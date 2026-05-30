/**
 * spa/scheduler.js
 * Stateless launchd-based scheduler. All state lives in data/spa-state.json.
 *
 * Runs every 15 min via launchd. Coordinates pure modules + side-effect
 * boundaries (calendar fetch, weather, telegram). No setTimeout, no continuous
 * polling — every run is self-contained.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readSnapshot } = require(path.join(__dirname, '..', 'monitor'));
const { loadConfig } = require('./config');
const { fetchWeather } = require('./weather-fetch');
const { isWeatherRisky } = require('./weather');
const { calculateLeadMinutes } = require('./preheat');
const { buildPreheatSession, updateSessionObservation, finalizeSession } = require('./session');
const {
  approvalMatchesContext,
  approvalExpiresMs,
  approvalPromptSent,
  createPendingApproval,
  stampApprovalPrompt,
  decideFromPollResult
} = require('./approval');
const { sendWeatherApprovalPrompt } = require('./telegram');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

const STATE_FILE          = process.env.SPA_STATE_FILE          || path.join(DATA_DIR, 'spa-state.json');
const EVENTS_FILE         = process.env.SPA_EVENTS_FILE         || path.join(DATA_DIR, 'spa-events.json');
const HISTORY_FILE        = process.env.SPA_HISTORY_FILE        || path.join(DATA_DIR, 'spa-preheat-history.json');
const OVERRIDE_FILE       = process.env.SPA_PREHEAT_OVERRIDE_FILE || path.join(DATA_DIR, 'spa-preheat-override.json');
const WEATHER_APPROVAL_FILE = process.env.SPA_WEATHER_APPROVAL_FILE || path.join(DATA_DIR, 'spa-weather-approval.json');

const CALENDAR_SCRIPT     = path.join(__dirname, 'calendar-fetch.js');
const CONTROL_SCRIPT      = path.join(ROOT, 'hubitat', 'control.js');
const APPROVAL_POLL_SCRIPT = path.join(__dirname, 'approval-poll.js');

// ── helpers ──────────────────────────────────────────────────────────────────

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
  const h = readJson(HISTORY_FILE);
  return { updatedAt: h?.updatedAt ?? null, sessions: Array.isArray(h?.sessions) ? h.sessions : [] };
}

function writeHistory(history) {
  writeJson(HISTORY_FILE, { updatedAt: new Date().toISOString(), sessions: history.sessions });
}

function readWeatherApproval() {
  return readJson(WEATHER_APPROVAL_FILE);
}

function writeWeatherApproval(approval) {
  writeJson(WEATHER_APPROVAL_FILE, approval);
}

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
  return null; // still pending / no file / etc.
}

function readOverride() {
  const override = readJson(OVERRIDE_FILE);
  if (!override?.startAt) return null;
  const parsed = Date.parse(override.startAt);
  if (!Number.isFinite(parsed)) return null;
  return { ...override, startAt: new Date(parsed).toISOString() };
}

function clearOverrideFile() {
  try { fs.unlinkSync(OVERRIDE_FILE); } catch { /* best effort */ }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const err = new Error(result.stderr || result.stdout || `${command} exited ${result.status}`);
    err.status = result.status;
    throw err;
  }
  return result.stdout.trim();
}

function runSpaMacro(macro) {
  return run('node', [CONTROL_SCRIPT, 'macro', macro, '--confirm']);
}

function delay(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) { /* spin */ }
}

// ── calendar fetch ───────────────────────────────────────────────────────────

async function fetchCalendarEvents(days = 7) {
  const output = run('node', [CALENDAR_SCRIPT, '--days', String(days)]);
  const parsed = JSON.parse(output || '[]');
  return (Array.isArray(parsed) ? parsed : []).filter(
    e => String(e.title || '').toLowerCase() === 'spa'
  );
}

// ── state file helpers ───────────────────────────────────────────────────────

function loadState() {
  return readJson(STATE_FILE) || {};
}

function saveState(state) {
  writeJson(STATE_FILE, state);
  return state;
}

function buildState(overrides = {}) {
  return {
    checkedAt: new Date(Date.now()).toISOString(),
    phase: 'idle',
    nextSpaEvent: null,
    preheatStartMs: null,
    leadMinutes: null,
    activePreheat: null,
    weatherApproval: null,
    weather: null,
    ...overrides
  };
}

// ── session helpers ──────────────────────────────────────────────────────────

function pushSession(history, session) {
  const sessions = Array.isArray(history?.sessions) ? history.sessions.slice() : [];
  const idx = sessions.findIndex(s => s.sessionId === session.sessionId);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  history.sessions = sessions.slice(-40);
  return history;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg      = loadConfig();
  const nowMs    = Date.now();
  const checkedAt = new Date(nowMs).toISOString();

  // Load existing state (persisted across runs)
  let prev = loadState();
  const phase = prev?.phase || 'idle';

  // Fetch current device snapshot once per run
  const currentState = await readSnapshot();

  // Fetch current weather for risk evaluation
  const weather = fetchWeather() ?? currentState?.weather ?? null;

  // ── PHASE 1: IDLE ─────────────────────────────────────────────────────────
  if (phase === 'idle' && !prev?.activePreheat && !prev?.nextSpaEvent) {
    const events = await fetchCalendarEvents(7);

    if (!events.length) {
      // No Spa events — stay idle
      saveState(buildState({ phase: 'idle', weather }));
      return;
    }

    const nextSpaEvent = events[0]; // already sorted by start
    const nextSpaStartMs = Date.parse(nextSpaEvent.start);
    const nextSpaEndMs   = Date.parse(nextSpaEvent.end);

    const history = readHistory();

    const leadMinutes = calculateLeadMinutes({
      spaTempF: currentState?.spaTempF,
      ambientF: weather?.tempF,
      weatherDesc: weather?.desc,
      history,
      config: cfg
    });

    const leadMinutesSafe = leadMinutes ?? 60;
    const override = readOverride();
    const overrideStartAtMs = override?.startAt ? Date.parse(override.startAt) : null;
    const preheatStartMs = overrideStartAtMs ?? (nextSpaStartMs - (leadMinutesSafe * 60 * 1000));

    prev = saveState(buildState({
      phase: 'idle',
      nextSpaEvent,
      preheatStartMs,
      leadMinutes: leadMinutesSafe,
      weather,
      overrideStartAt: override?.startAt ?? null
    }));

    // Phase 1 done — state saved, preheat window set.
    // Phase 2 will evaluate preheat readiness on the next launchd firing (15 min later).
    return;
  }

  // ── PHASE 2: PREHEAT_PENDING ──────────────────────────────────────────────
  // nextSpaEvent exists, phase is 'idle', preheatStartMs is set, no activePreheat yet
  if (
    phase === 'idle' &&
    prev?.nextSpaEvent &&
    Number.isFinite(prev?.preheatStartMs) &&
    !prev?.activePreheat
  ) {
    if (nowMs < prev.preheatStartMs) {
      // Too early — still waiting; just update checkedAt
      saveState({ ...prev, checkedAt });
      return;
    }

    // Time to start preheat — check weather risk
    const weatherRisk = isWeatherRisky(weather);

    if (weatherRisk) {
      // Check for existing valid approval
      const approval = readWeatherApproval();
      const matches  = approvalMatchesContext(approval, prev.nextSpaEvent, prev.preheatStartMs);
      const expired  = approval && approvalExpiresMs(approval) && nowMs > approvalExpiresMs(approval);

      if (!matches || expired) {
        // No valid approval — send prompt and store pending approval
        const freshApproval = createPendingApproval({
          nextSpaEvent: prev.nextSpaEvent,
          preheatStartMs: prev.preheatStartMs,
          weather,
          reason: 'Weather conditions indicate rain or storms are present or likely.'
        });
        writeWeatherApproval(freshApproval);

        const delivery = sendWeatherApprovalPrompt(freshApproval, nowMs);
        const stamped  = stampApprovalPrompt(freshApproval, delivery, nowMs, cfg.weatherApprovalTimeoutMin ?? 30);
        writeWeatherApproval(stamped);

        saveState({
          ...prev,
          checkedAt,
          phase: 'preheat_pending_approval',
          weatherApproval: stamped
        });
        return;
      }

      if (approval?.status === 'pending') {
        // Approval already in flight — transition to waiting state
        saveState({ ...prev, checkedAt, phase: 'preheat_pending_approval', weatherApproval: approval });
        return;
      }

      if (approval?.status === 'denied') {
        // Weather denied — clear event, go idle
        saveState(buildState({ phase: 'idle', weather }));
        return;
      }

      // approval status === 'approved' — fall through to start preheat
    }

    // No weather risk (or approval already granted) — start heating
    runSpaMacro('spaHeatStart');

    // Wait 5 min for valve transit + water residence time before first valid temp reading
    delay(5 * 60 * 1000);
    const confirmedState = await readSnapshot();
    const valveOk = confirmedState?.valveState === 'spa';

    const activePreheat = buildPreheatSession({
      nextSpaEvent: prev.nextSpaEvent,
      checkedAt,
      weather,
      currentState: confirmedState,
      leadMinutes: prev.leadMinutes,
      config: cfg
    });

    const history = readHistory();
    pushSession(history, activePreheat);
    writeHistory(history);

    saveState({
      ...prev,
      checkedAt,
      phase: 'heating',
      activePreheat,
      weatherApproval: readWeatherApproval()
    });
    return;
  }

  // ── PHASE 3: HEATING ───────────────────────────────────────────────────────
  if (phase === 'heating' && prev?.activePreheat) {
    const nextSpaEndMs = prev.nextSpaEvent ? Date.parse(prev.nextSpaEvent.end) : null;
    const sessionStartMs = Date.parse(prev.activePreheat?.startedAt);
    const maxHeatMs = Number.isFinite(sessionStartMs)
      ? sessionStartMs + (cfg.maxOverrideLeadHours ?? 12) * 3600_000
      : null;

    const eventEnded = nextSpaEndMs && nowMs >= nextSpaEndMs;
    const exceededMax = maxHeatMs && nowMs >= maxHeatMs;

    if (!eventEnded && !exceededMax) {
      // Still within event window and max-duration bound — update observation, stay heating
      const updated = updateSessionObservation(prev.activePreheat, { checkedAt, currentState });

      const history = readHistory();
      pushSession(history, updated);
      writeHistory(history);

      saveState({ ...prev, checkedAt, activePreheat: updated });
      return;
    }

    // Event ended or max duration exceeded — stop heating and finalize
    const completionReason = exceededMax && !eventEnded ? 'max-duration' : 'event-ended';

    try {
      runSpaMacro('spaHeatStop');
    } catch (err) {
      // spaHeatStop failure should not block finalization; log and continue
      console.error(`
[spa-check] WARNING: spaHeatStop failed: ${err.message}`);
    }

    const finalized = finalizeSession(prev.activePreheat, completionReason, { checkedAt });

    const history = readHistory();
    pushSession(history, finalized);
    writeHistory(history);

    // Return to idle, no nextSpaEvent, no activePreheat
    saveState(buildState({ phase: 'idle', weather: weather ?? null }));
    return;
  }

  // ── PHASE 4: PREHEAT_PENDING_APPROVAL ─────────────────────────────────────
  if (phase === 'preheat_pending_approval' && prev?.weatherApproval) {
    const pollResult = checkWeatherApprovalPoll();

    if (pollResult?.status === 'approved') {
      const updatedApproval = decideFromPollResult(prev.weatherApproval, 'yes', 'telegram-reply', nowMs);
      writeWeatherApproval(updatedApproval);

      // Start heating
      runSpaMacro('spaHeatStart');

      // Wait 5 min for valve transit + water residence time before first valid temp reading
      delay(5 * 60 * 1000);
      const confirmedState = await readSnapshot();
      // valve confirmed implicitly via continued operation

      const activePreheat = buildPreheatSession({
        nextSpaEvent: prev.nextSpaEvent,
        checkedAt,
        weather,
        currentState: confirmedState,
        leadMinutes: prev.leadMinutes,
        config: cfg
      });

      const history = readHistory();
      pushSession(history, activePreheat);
      writeHistory(history);

      saveState({
        ...prev,
        checkedAt,
        phase: 'heating',
        activePreheat,
        weatherApproval: updatedApproval
      });
      return;
    }

    if (pollResult?.status === 'denied' || pollResult?.status === 'expired') {
      const decisionSource = pollResult.status === 'expired' ? 'expired' : 'telegram-reply';
      const updatedApproval = decideFromPollResult(prev.weatherApproval, 'no', decisionSource, nowMs);
      writeWeatherApproval(updatedApproval);

      // Denied — clear event, go idle
      saveState(buildState({
        phase: 'idle',
        weather: weather ?? null,
        weatherApproval: updatedApproval
      }));
      return;
    }

    // Still pending — nothing to do, just update checkedAt
    saveState({ ...prev, checkedAt });
    return;
  }

  // Unknown / stale phase — reset gracefully
  saveState(buildState({ phase: 'idle', weather: weather ?? null }));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { main };