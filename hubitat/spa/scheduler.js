/**
 * spa/scheduler.js
 * Orchestrator for the spa scheduling automation.
 * Coordinates pure modules + side-effect boundaries (calendar fetch, weather fetch, telegram).
 *
 * This file is intentionally kept thin; most decision logic lives in the pure modules.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readSnapshot } = require(path.join(__dirname, '..', 'monitor'));
const { loadConfig } = require('./config');
const { isWeatherRisky } = require('./weather');
const { calculateLeadMinutes, resolvePreheatWindow } = require('./preheat');
const { buildPreheatSession, updateSessionObservation, finalizeSession } = require('./session');
const { approvalMatchesContext, approvalExpiresMs, approvalPromptSent, createPendingApproval, decideFromPollResult } = require('./approval');
const { sendWeatherApprovalPrompt } = require('./telegram');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

const STATE_FILE = process.env.SPA_STATE_FILE || path.join(DATA_DIR, 'spa-state.json');
const EVENTS_FILE = process.env.SPA_EVENTS_FILE || path.join(DATA_DIR, 'spa-events.json');
const CALENDAR_SCRIPT = path.join(__dirname, 'calendar-fetch.js');
const CONTROL_SCRIPT = path.join(ROOT, 'hubitat', 'control.js');
const HISTORY_FILE = process.env.SPA_HISTORY_FILE || path.join(DATA_DIR, 'spa-preheat-history.json');
const OVERRIDE_FILE = process.env.SPA_PREHEAT_OVERRIDE_FILE || path.join(DATA_DIR, 'spa-preheat-override.json');
const WEATHER_APPROVAL_FILE = process.env.SPA_WEATHER_APPROVAL_FILE || path.join(DATA_DIR, 'spa-weather-approval.json');
const APPROVAL_POLL_SCRIPT = path.join(__dirname, 'approval-poll.js');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readHistory() {
  const history = readJson(HISTORY_FILE);
  if (!history || !Array.isArray(history.sessions)) {
    return { updatedAt: null, sessions: [] };
  }
  return history;
}

function writeHistory(history) {
  writeJson(HISTORY_FILE, {
    updatedAt: new Date().toISOString(),
    sessions: Array.isArray(history.sessions) ? history.sessions : []
  });
}

function readWeatherApproval() {
  return readJson(WEATHER_APPROVAL_FILE);
}

function writeWeatherApproval(approval) {
  writeJson(WEATHER_APPROVAL_FILE, approval);
}

/**
 * Check the approval file via approval-poll.js --check and return the result.
 * Returns null if still pending / expired / no reply yet.
 */
function checkWeatherApprovalPoll() {
  const result = spawnSync('node', [APPROVAL_POLL_SCRIPT, '--check'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
    timeout: 20000
  });
  if (result.status === 0) {
    try {
      return JSON.parse((result.stdout || '').trim());
    } catch {
      return null;
    }
  }
  // status 1 = still pending, no approval file, etc. — treat as null
  return null;
}

function readOverride() {
  const override = readJson(OVERRIDE_FILE);
  if (!override || !override.startAt) return null;
  const parsedStart = Date.parse(override.startAt);
  if (!Number.isFinite(parsedStart)) return null;
  return { ...override, startAt: new Date(parsedStart).toISOString() };
}

function clearOverrideFile() {
  try { fs.unlinkSync(OVERRIDE_FILE); } catch { /* best effort */ }
}

function overrideAppliesToEvent(overrideStartMs, nextSpaStartMs) {
  if (!Number.isFinite(overrideStartMs) || !Number.isFinite(nextSpaStartMs)) return false;
  const leadMs = nextSpaStartMs - overrideStartMs;
  const maxLeadMs = 12 * 60 * 60 * 1000; // conservative default
  return leadMs > 0 && leadMs <= maxLeadMs;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `${command} exited with ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim();
}

function runSpaMacro(macro) {
  return run('node', [CONTROL_SCRIPT, 'macro', macro, '--confirm']);
}

async function fetchCalendarEvents() {
  const days = Number(process.env.SPA_CALENDAR_DAYS) || 2;
  const output = run('node', [CALENDAR_SCRIPT, '--days', String(days)]);
  const parsed = JSON.parse(output || '[]');
  // Filter to exact "Spa" or "spa" titled events only
  const events = (Array.isArray(parsed) ? parsed : []).filter(e => String(e.title || '').toLowerCase() === 'spa');
  return events;
}

async function main() {
  const cfg = loadConfig();
  const nowMs = Date.now();
  const checkedAt = new Date(nowMs).toISOString();

  // 1. Side effects: fetch calendar + current device state
  const events = await fetchCalendarEvents();
  const currentState = await readSnapshot();

  // 2. Determine next Spa event
  const nextSpaEvent = events.length > 0 ? events[0] : null; // assume sorted by start
  const nextSpaStartMs = nextSpaEvent ? Date.parse(nextSpaEvent.start) : null;
  const nextSpaEndMs = nextSpaEvent ? Date.parse(nextSpaEvent.end) : null;

  // 3. Weather (already embedded in state snapshot or fetched separately in legacy path)
  // For now we rely on the weather already present in the state snapshot pattern
  const previousSnapshot = readJson(STATE_FILE);
  const weather = previousSnapshot?.weather || currentState?.weather || null;
  const weatherRisk = isWeatherRisky(weather);

  // 4. History + override
  const history = readHistory();
  const override = readOverride();

  // 5. Pure decision: lead time
  const leadMinutes = calculateLeadMinutes({
    spaTempF: currentState?.spaTempF,
    ambientF: weather?.tempF,
    weatherDesc: weather?.desc,
    history,
    config: cfg
  });

  const { preheatStartMs, overrideApplied, overrideIgnored } = resolvePreheatWindow({
    nextSpaEvent,
    leadMinutes,
    override,
    maxOverrideLeadHours: cfg.maxOverrideLeadHours
  });

  if (overrideApplied) {
    // clear override once consumed
    clearOverrideFile();
  }

  const shouldPreheat = Boolean(
    nextSpaEvent &&
    Number.isFinite(preheatStartMs) &&
    nowMs >= preheatStartMs &&
    nowMs < (nextSpaEndMs || Infinity)
  );

  const needsSpaHeat = currentState?.valveState !== 'spa' || currentState?.heaterAuto !== 'on';

  // 6. Weather approval gate
  let weatherApproval = readWeatherApproval();
  let weatherGateActive = false;
  let weatherApprovalDelivery = null;
  let action = 'none';
  let actionOutput = null;
  let activePreheat = null;

  if (shouldPreheat && needsSpaHeat && weatherRisk) {
    const matches = approvalMatchesContext(weatherApproval, nextSpaEvent, preheatStartMs);
    const expired = weatherApproval && approvalExpiresMs(weatherApproval) && nowMs > approvalExpiresMs(weatherApproval);

    if (!matches || expired) {
      // create fresh pending approval
      weatherApproval = createPendingApproval({
        nextSpaEvent,
        preheatStartMs,
        weather,
        reason: 'Weather conditions indicate rain or storms are present or likely.'
      });
      writeWeatherApproval(weatherApproval);
      weatherGateActive = true;
      action = 'waiting-weather-approval';
    } else if (weatherApproval?.status === 'pending') {
      weatherGateActive = true;
      action = 'waiting-weather-approval';
    } else if (weatherApproval?.status === 'denied') {
      action = 'weather-denied';
    }
  }

  // 7. Send approval prompt if needed (only here, via telegram boundary)
  if (shouldPreheat && needsSpaHeat && weatherGateActive && weatherApproval?.status === 'pending' && !approvalPromptSent(weatherApproval)) {
    weatherApprovalDelivery = sendWeatherApprovalPrompt(weatherApproval, nowMs);
    weatherApproval = stampApprovalPrompt(weatherApproval, weatherApprovalDelivery, nowMs, cfg.weatherApprovalTimeoutMin);
    writeWeatherApproval(weatherApproval);
    if (!weatherApprovalDelivery?.ok) {
      action = 'weather-approval-send-failed';
    }
  }

  // 8. Poll for Telegram reply if approval is pending
  if (shouldPreheat && needsSpaHeat && weatherGateActive && weatherApproval?.status === 'pending' && approvalPromptSent(weatherApproval)) {
    const pollResult = checkWeatherApprovalPoll();
    if (pollResult) {
      if (pollResult.status === 'approved') {
        weatherApproval = decideFromPollResult(weatherApproval, 'yes', 'telegram-reply', nowMs);
        writeWeatherApproval(weatherApproval);
        weatherGateActive = false; // proceed to preheat
      } else if (pollResult.status === 'denied' || pollResult.status === 'expired') {
        weatherApproval = decideFromPollResult(weatherApproval, 'no', pollResult.status === 'expired' ? 'expired' : 'telegram-reply', nowMs);
        writeWeatherApproval(weatherApproval);
        weatherGateActive = false;
        action = 'weather-denied';
      }
      // else still pending — wait
    }
  }

  // 9. Execute preheat if safe (weather gate cleared)
  if (shouldPreheat && needsSpaHeat && !weatherGateActive) {
    action = 'spaHeatStart';
    actionOutput = runSpaMacro('spaHeatStart');
    activePreheat = buildPreheatSession({
      nextSpaEvent,
      checkedAt,
      weather,
      currentState,
      leadMinutes,
      config: cfg
    });
  }

  // 9. Post-action monitor snapshot (legacy behavior)
  let monitorAfter = null;
  if (action === 'spaHeatStart') {
    monitorAfter = await new Promise((resolve, reject) => {
      setTimeout(() => {
        readSnapshot().then(resolve).catch(reject);
      }, 5000);
    });
  }

  // 10. Session observation + finalization
  const previousActivePreheat = previousSnapshot?.activePreheat || null;
  if (!activePreheat && previousActivePreheat && previousActivePreheat.status === 'active') {
    activePreheat = previousActivePreheat;
  }

  let nextActivePreheat = activePreheat;
  if (nextActivePreheat?.status === 'active') {
    nextActivePreheat = updateSessionObservation(nextActivePreheat, { checkedAt, currentState });
    if (!shouldPreheat && previousActivePreheat) {
      nextActivePreheat = finalizeSession(nextActivePreheat, 'window-ended', { checkedAt });
    } else if (nextSpaEvent && nextSpaEndMs != null && Date.now() >= nextSpaEndMs) {
      nextActivePreheat = finalizeSession(nextActivePreheat, 'event-ended', { checkedAt });
    }
  }

  if (nextActivePreheat) {
    const existing = Array.isArray(history.sessions) ? history.sessions.slice() : [];
    const idx = existing.findIndex(s => s.sessionId === nextActivePreheat.sessionId);
    if (idx >= 0) existing[idx] = nextActivePreheat;
    else existing.push(nextActivePreheat);
    history.sessions = existing.slice(-40);
    writeHistory(history);
  }

  // 11. Build final snapshot (preserves legacy shape)
  const snapshot = {
    checkedAt,
    weather,
    weatherRisk,
    currentState,
    nextSpaEvent,
    overrideApplied,
    leadMinutes,
    preheatStart: preheatStartMs ? new Date(preheatStartMs).toISOString() : null,
    shouldPreheat,
    action,
    actionOutput,
    heatingStalled: false, // TODO: implement trend-based detection in follow-up
    trend: null,
    previousState: previousSnapshot,
    monitorBefore: currentState,
    monitorAfter,
    activePreheat: nextActivePreheat || null,
    weatherApproval,
    weatherApprovalDelivery,
    preheatHistory: {
      updatedAt: checkedAt,
      sessionCount: Array.isArray(history.sessions) ? history.sessions.length : 0,
      override: overrideApplied ? { startAt: new Date(preheatStartMs).toISOString(), source: 'data/spa-preheat-override.json' } : null,
      overrideIgnored: Boolean(overrideIgnored)
    }
  };

  writeJson(STATE_FILE, snapshot);
  console.log(JSON.stringify(snapshot, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { main };
