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
const { calculateLeadMinutes, resolvePreheatWindow } = require('./preheat');
const { buildPreheatSession, updateSessionObservation, finalizeSession } = require('./session');
const {
  approvalMatchesContext,
  approvalExpiresMs,
  createPendingApproval,
  stampApprovalPrompt,
  decideFromPollResult
} = require('./approval');
const { sendWeatherApprovalPrompt, sendValveFailureAlert, sendHeatingStartedLateAlert } = require('./telegram');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

const STATE_FILE          = process.env.SPA_STATE_FILE          || path.join(DATA_DIR, 'spa-state.json');
const EVENTS_FILE         = process.env.SPA_EVENTS_FILE         || path.join(DATA_DIR, 'spa-events.json');
const HISTORY_FILE        = process.env.SPA_HISTORY_FILE        || path.join(DATA_DIR, 'spa-preheat-history.json');
const OVERRIDE_FILE       = process.env.SPA_PREHEAT_OVERRIDE_FILE || path.join(DATA_DIR, 'spa-preheat-override.json');
const WEATHER_APPROVAL_FILE = process.env.SPA_WEATHER_APPROVAL_FILE || path.join(DATA_DIR, 'spa-weather-approval.json');
const RUN_LOG_FILE = process.env.SPA_RUN_LOG_FILE || path.join(DATA_DIR, 'spa-scheduler.log');
const LOCK_FILE = path.join(DATA_DIR, 'spa-scheduler.lock');

const CALENDAR_SCRIPT     = path.join(__dirname, 'calendar-fetch.js');
const CONTROL_SCRIPT      = path.join(ROOT, 'hubitat', 'control.js');
const APPROVAL_POLL_SCRIPT = path.join(__dirname, 'approval-poll.js');
const { expireApprovalDefaultYes } = require('./approval-poll');

const CALENDAR_LOOK_AHEAD_DAYS = 7;

// ── run log helpers ───────────────────────────────────────────────────────────

function runLog(level, message) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  fs.appendFileSync(RUN_LOG_FILE, entry);
}

function rotateRunLog(retentionDays = 7) {
  try {
    const content = fs.readFileSync(RUN_LOG_FILE, 'utf8');
    const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const lines = content.split('\n').filter(line => {
      if (!line.includes('[')) return true; // keep non-log lines
      const match = line.match(/\[([^\]]+)\]/);
      if (!match) return true;
      const ts = Date.parse(match[1]);
      return Number.isFinite(ts) && ts > cutoffMs;
    });
    fs.writeFileSync(RUN_LOG_FILE, lines.join('\n') + '\n');
  } catch (err) {
    // If rotation itself fails (disk full, corrupt file), let the scheduler keep running
    // but emit to stderr so there's at least some record of the failure.
    // Avoids silent failure when rotateRunLog is the thing that's broken.
    process.stderr.write(`[spa-check] rotateRunLog failed: ${err.message}\n`);
  }
}

// ── lock file helpers ──────────────────────────────────────────────────────────

function acquireLock() {
  const pid = process.pid;
  const tmp = LOCK_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, String(pid));
    fs.renameSync(tmp, LOCK_FILE); // atomic on macOS
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    try {
      const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      // Check if old process is still alive
      try { process.kill(oldPid, 0); return false; } catch { /* died, stale lock */ }
      // Stale lock — remove and retry
      try { fs.unlinkSync(LOCK_FILE); } catch { /* best effort */ }
      try {
        fs.writeFileSync(tmp, String(pid));
        fs.renameSync(tmp, LOCK_FILE);
        return true;
      } catch { return false; }
    } catch { return false; }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* best effort */ }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    weatherCheckMs: null,
    nextSpaEventEndMs: null,
    leadMinutes: null,
    activePreheat: null,
    weatherApproval: null,
    weather: null,
    ...overrides
  };
}

function resolveWeatherCheckMs({ preheatStartMs, weatherCheckLeadMin = 30 }) {
  if (!Number.isFinite(preheatStartMs)) return null;
  return preheatStartMs - (weatherCheckLeadMin * 60 * 1000);
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

// ── valve readiness ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 30_000;  // 30 seconds — frequent enough to catch a 45s transit
const MAX_TOTAL_WAIT_MS = 600_000; // 10 minutes — cap to prevent indefinite waits
const RETRY_WAIT_MS     = 60_000;  // 60 seconds — PL-PLUS needs time to process PRESS + transit

/**
 * Wait for valve to reach 'spa' state, with up to one automatic retry.
 * Polls every 30 seconds; 60-second pause after each retry command.
 * Caps total wait at 10 minutes.
 * Returns { valveOk, attempts, confirmedState }.
 */
async function waitForValveReady(retries = 1) {
  const startMs = Date.now();

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let state;
    try {
      state = await readSnapshot();
    } catch (err) {
      runLog('WARNING', `[waitForValveReady] readSnapshot failed: ${err.message}. Retrying...`);
      state = null;
    }
    if (state?.valveState === 'spa') {
      return { valveOk: true, attempts: attempt, confirmedState: state };
    }

    if (attempt <= retries) {
      const elapsed = Date.now() - startMs;
      if (elapsed >= MAX_TOTAL_WAIT_MS) break;

      // Retry: re-invoke spaHeatStart to nudge the valve
      try {
        runSpaMacro('spaHeatStart');
      } catch (err) {
        runLog('WARNING', `[HEATING] Valve retry spaHeatStart failed: ${err.message}`);
      }
      // Give the PL-PLUS controller time to process PRESS and complete transit
      await sleep(RETRY_WAIT_MS);
    } else {
      // Final attempt — respect total wait cap
      const elapsed = Date.now() - startMs;
      if (elapsed >= MAX_TOTAL_WAIT_MS) break;
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return { valveOk: false, attempts: retries + 1, confirmedState: null };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg      = loadConfig();

  // Acquire lock to prevent concurrent runs (e.g. launchd fires while previous run is still executing)
  if (!acquireLock()) {
    runLog('WARNING', '[scheduler] Lock file held by another process — skipping this run.');
    return;
  }

  try {
    // Rotate run log on every entry — keeps file bounded to retention window
  rotateRunLog(cfg.spaRunLogRetentionDays ?? 7);
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
    const events = await fetchCalendarEvents(CALENDAR_LOOK_AHEAD_DAYS);

    if (!events.length) {
      // No Spa events — stay idle
      runLog('INFO', `[IDLE] No Spa events found in next ${CALENDAR_LOOK_AHEAD_DAYS} days.`);
      saveState(buildState({ phase: 'idle', weather }));
      return;
    }

    const nextSpaEvent = events[0]; // already sorted by start
    runLog('INFO', `[IDLE] Event detected: Spa uid=${nextSpaEvent.uid} starting ${nextSpaEvent.start} (ends ${nextSpaEvent.end}).`);

    // Clear any stale approval that doesn't match the new event's uid
    const existingApproval = readWeatherApproval();
    if (existingApproval?.status === 'pending' && existingApproval?.eventId !== nextSpaEvent.uid) {
      runLog('INFO', `[IDLE] Clearing stale pending approval from uid=${existingApproval?.eventId} — new event uid=${nextSpaEvent.uid}.`);
      writeWeatherApproval(null);
    }

    const nextSpaStartMs = Date.parse(nextSpaEvent.start);
    const nextSpaEndMs   = Date.parse(nextSpaEvent.end);

    // Skip events that have already ended — no point scheduling preheat for a past event
    if (nextSpaEndMs && nowMs > nextSpaEndMs) {
      saveState(buildState({ phase: 'idle', weather }));
      return;
    }

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
    const window = resolvePreheatWindow({
      nextSpaEvent,
      leadMinutes: leadMinutesSafe,
      override,
      maxOverrideLeadHours: cfg.maxOverrideLeadHours ?? 12
    });
    const preheatStartMs = window.preheatStartMs;
    const weatherCheckMs = resolveWeatherCheckMs({
      nextSpaEvent,
      preheatStartMs,
      weatherCheckLeadMin: cfg.weatherCheckLeadMin
    });

    // Persist nextSpaEventEndMs so the scheduled stop survives even if nextSpaEvent is cleared
    const nextSpaEventEndMs = Date.parse(nextSpaEvent.end) || null;

    prev = saveState(buildState({
      phase: 'idle',
      nextSpaEvent,
      preheatStartMs,
      weatherCheckMs,
      nextSpaEventEndMs,
      leadMinutes: leadMinutesSafe,
      weather,
      overrideStartAt: override?.startAt ?? null,
      overrideApplied: window.overrideApplied,
      overrideIgnored: window.overrideIgnored
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
    const weatherCheckMs = Number.isFinite(prev.weatherCheckMs)
      ? prev.weatherCheckMs
      : resolveWeatherCheckMs({
          nextSpaEvent: prev.nextSpaEvent,
          preheatStartMs: prev.preheatStartMs,
          weatherCheckLeadMin: cfg.weatherCheckLeadMin
        });

    if (nowMs < weatherCheckMs) {
      // Too early for weather evaluation — still waiting; just update checkedAt
      saveState({ ...prev, checkedAt, weatherCheckMs });
      return;
    }

    // Weather can be evaluated before preheat starts so risky conditions can gate heating.
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
          weather,
          weatherCheckMs,
          phase: 'preheat_pending_approval',
          weatherApproval: stamped
        });
        return;
      }

      if (approval?.status === 'pending') {
        // Approval already in flight — transition to waiting state
        saveState({ ...prev, checkedAt, weather, weatherCheckMs, phase: 'preheat_pending_approval', weatherApproval: approval });
        return;
      }

      if (approval?.status === 'denied') {
        // Weather denied — clear event, go idle
        saveState(buildState({ phase: 'idle', weather }));
        return;
      }

      if (approval?.status === 'approved' && nowMs < prev.preheatStartMs) {
        // Approval is ready early; keep waiting until heating may actually begin.
        saveState({ ...prev, checkedAt, weather, weatherCheckMs, weatherApproval: approval });
        return;
      }

      // approval status === 'approved' and preheat time has arrived — fall through to start preheat
    } else if (nowMs < prev.preheatStartMs) {
      // Weather is clear, but heating still waits until the calculated preheat start.
      saveState({ ...prev, checkedAt, weather, weatherCheckMs });
      return;
    }

    // No weather risk (or approval already granted) — start heating

    // Detect and notify on late start (T1 decision)
    if (nowMs > prev.preheatStartMs) {
      const lateByMin = Math.round((nowMs - prev.preheatStartMs) / 60_000);
      const estimatedReadyMs = currentState?.spaTempF
        ? nowMs + Math.max(0, (102 - currentState.spaTempF) * 2 * 60_000)
        : (prev.nextSpaEventEndMs ?? nowMs + 60 * 60_000);
      try {
        sendHeatingStartedLateAlert(lateByMin, estimatedReadyMs);
      } catch (err) {
        runLog('WARNING', `[HEATING] sendHeatingStartedLateAlert failed: ${err.message}`);
      }
    }

    runLog('INFO', `[IDLE→HEATING] Calling spaHeatStart for event uid=${prev.nextSpaEvent?.uid}.`);
    runSpaMacro('spaHeatStart');
    runLog('INFO', `[HEATING] spaHeatStart succeeded; waiting for valve confirmation.`);

    const activatedAt = new Date(Date.now()).toISOString();

    // Wait for valve to reach 'spa' state (retry once if needed)
    const valveResult = await waitForValveReady(1);

    if (!valveResult.valveOk) {
      // Valve failed to reach 'spa' mode after retry — abort session gracefully
      runLog('WARNING', `[HEATING] Valve failed ${valveResult.attempts}x — aborting preheat, no activePreheat session created. Spa will NOT auto-shut off at event end.`);
      sendValveFailureAlert();
      saveState({
        ...prev,
        phase: 'idle',
        activePreheat: null,
        failedPreheat: true,
        weather,
      });
      return;
    }

    runLog('INFO', `[IDLE→ACTIVE] Valve confirmed 'spa'. Session activated at ${activatedAt}.`);

    const confirmedState = valveResult.confirmedState;
    const currentCheckedAt = new Date(Date.now()).toISOString();

    const activePreheat = buildPreheatSession({
      nextSpaEvent: prev.nextSpaEvent,
      activatedAt,
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
      checkedAt: currentCheckedAt,
      phase: 'heating',
      activePreheat,
      nextSpaEventEndMs: prev.nextSpaEventEndMs,
      weatherApproval: readWeatherApproval()
    });
    return;
  }

  // ── PHASE 3: HEATING / FAILED PREHEAT END ────────────────────────────────
  if ((phase === 'heating' && prev?.activePreheat) ||
      (phase === 'idle' && prev?.failedPreheat && prev?.nextSpaEventEndMs)) {
    // Use persisted nextSpaEventEndMs if available, falling back to nextSpaEvent.end.
    // This ensures the stop time survives even if nextSpaEvent was cleared during a failed preheat.
    const persistedEndMs = prev?.nextSpaEventEndMs ? Number(prev.nextSpaEventEndMs) : null;
    const nextSpaEndMs = persistedEndMs
      || (prev.nextSpaEvent ? Date.parse(prev.nextSpaEvent.end) : null);

    // Handle idle + failedPreheat: stop at event end, otherwise wait
    if (phase === 'idle' && prev?.failedPreheat && nextSpaEndMs) {
      if (nowMs >= nextSpaEndMs) {
        runLog('INFO', `[HEATING→IDLE] Preheat failed earlier; stopping at event end.`);
        const state = await readSnapshot();
        if (state?.valveState === 'pool') {
          runLog('INFO', `[HEATING→IDLE] Spa already in pool mode — skipping spaHeatStop.`);
        } else {
          try { runSpaMacro('spaHeatStop'); } catch (err) {
            runLog('ERROR', `spaHeatStop failed during failedPreheat end: ${err.message}`);
          }
        }
        saveState(buildState({ phase: 'idle', weather: weather ?? null }));
        return;
      } else {
        runLog('INFO', `[IDLE] Preheat previously failed, waiting for event end at ${new Date(nextSpaEndMs).toISOString()}.`);
        return;
      }
    }

    // Normal heating path: activePreheat is set
    // Re-validate event still exists and end time hasn't changed (C2/C3)
    const liveEvents = await fetchCalendarEvents(1);
    const currentEvent = liveEvents.find(e => e.uid === prev?.nextSpaEvent?.uid);

    if (!currentEvent) {
      // Event was removed — stop heating and notify
      runLog('INFO', `[HEATING] Event uid=${prev.nextSpaEvent?.uid} no longer on calendar — stopping spa.`);
      const state = await readSnapshot();
      if (state?.valveState === 'pool') {
        runLog('INFO', `[HEATING→IDLE] Spa already in pool mode — skipping spaHeatStop.`);
      } else {
        runLog('INFO', `[HEATING→IDLE] Spa not in pool mode — calling spaHeatStop.`);
        try { runSpaMacro('spaHeatStop'); } catch (err) {
          runLog('ERROR', `spaHeatStop failed: ${err.message}`);
        }
      }
      // Send Telegram notification
      try {
        const { sendEventCancelledAlert } = require('./telegram');
        sendEventCancelledAlert(prev.nextSpaEvent?.uid);
      } catch (err) {
        runLog('WARNING', `sendEventCancelledAlert failed: ${err.message}`);
      }
      saveState(buildState({ phase: 'idle', weather: weather ?? null }));
      return;
    }

    if (currentEvent.end !== prev.nextSpaEvent?.end) {
      // Event end time changed — update persisted end time and continue heating
      const updatedEndMs = Date.parse(currentEvent.end);
      runLog('INFO', `[HEATING] Event end time changed from ${prev.nextSpaEvent?.end} to ${currentEvent.end} — updating stop time.`);
      saveState({ ...prev, nextSpaEventEndMs: updatedEndMs, nextSpaEvent: currentEvent });
      return;
    }

    const sessionStartMs = Date.parse(prev.activePreheat?.startedAt);
    const maxHeatMs = Number.isFinite(sessionStartMs)
      ? sessionStartMs + (cfg.maxOverrideLeadHours ?? 12) * 3600_000
      : null;

    const eventEnded = nextSpaEndMs && nowMs >= nextSpaEndMs;
    const exceededMax = maxHeatMs && nowMs >= maxHeatMs;
    runLog('INFO', `[HEATING] Checking end condition: eventEnded=${eventEnded} (endMs=${nextSpaEndMs}), exceededMax=${exceededMax} (maxMs=${maxHeatMs}).`);

    if (!eventEnded && !exceededMax) {
      // Still within event window and max-duration bound — update observation, stay heating
      const currentCheckedAt = new Date(nowMs).toISOString();
      const updated = updateSessionObservation(prev.activePreheat, { checkedAt: currentCheckedAt, currentState });

      const history = readHistory();
      pushSession(history, updated);
      writeHistory(history);

      saveState({ ...prev, checkedAt: currentCheckedAt, activePreheat: updated });
      return;
    }

    // Event ended or max duration exceeded — stop heating and finalize
    const completionReason = exceededMax && !eventEnded ? 'max-duration' : 'event-ended';

    runLog('INFO', `[HEATING→IDLE] Event ended (uid=${prev.nextSpaEvent?.uid}). Calling spaHeatStop.`);
    const state = await readSnapshot();
    if (state?.valveState === 'pool') {
      runLog('INFO', `[HEATING→IDLE] Spa already in pool mode — skipping spaHeatStop.`);
    } else {
      try {
        runSpaMacro('spaHeatStop');
        runLog('INFO', `[HEATING→IDLE] spaHeatStop succeeded. Returning to pool mode.`);
      } catch (err) {
        // spaHeatStop failure should not block finalization; log and continue
        runLog('ERROR', `WARNING: spaHeatStop failed: ${err.message}`);
      }
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
    let proceedToHeating = false;

    if (pollResult?.status === 'approved' || pollResult?.status === 'already-approved') {
      // Fix 8: also handle 'already-approved' (set by approval-poll.js when approval is already confirmed)
      const updatedApproval = decideFromPollResult(prev.weatherApproval, 'yes', 'telegram-reply', nowMs);
      writeWeatherApproval(updatedApproval);

      if (Number.isFinite(prev.preheatStartMs) && nowMs < prev.preheatStartMs) {
        // Approval arrived before heating may begin. Return to the scheduled wait path.
        saveState({
          ...prev,
          checkedAt,
          phase: 'idle',
          weather,
          weatherApproval: updatedApproval
        });
        return;
      }

      // Fall through to shared heating entry below
      proceedToHeating = true;
    } else if (pollResult?.status === 'expired') {
      // Fix 7: on expiry, default YES and fall through to heating (not return)
      const updatedApproval = expireApprovalDefaultYes(prev.weatherApproval, nowMs);
      writeWeatherApproval(updatedApproval);
      proceedToHeating = true;
    } else if (pollResult?.status === 'denied') {
      // Explicit deny — go idle
      const updatedApproval = decideFromPollResult(prev.weatherApproval, 'no', 'telegram-reply', nowMs);
      writeWeatherApproval(updatedApproval);
      saveState(buildState({
        phase: 'idle',
        weather: weather ?? null,
        weatherApproval: updatedApproval
      }));
      return;
    } else {
      // Still pending — nothing to do, just update checkedAt
      saveState({ ...prev, checkedAt });
      return;
    }

    // Shared heating entry — runs for both 'approved'/'already-approved' and expired
    if (proceedToHeating) {
      runLog('INFO', `[PREHEAT_PENDING→HEATING] Approval confirmed (${pollResult?.status === 'expired' ? 'expired-default-yes' : 'user/telegram'}). Calling spaHeatStart for uid=${prev.nextSpaEvent?.uid}.`);
      runSpaMacro('spaHeatStart');
      runLog('INFO', `[HEATING] spaHeatStart succeeded; waiting for valve confirmation.`);

      const activatedAt = new Date(Date.now()).toISOString();

      // Wait for valve to reach 'spa' state (retry once if needed)
      const valveResult = await waitForValveReady(1);

      if (!valveResult.valveOk) {
        // Valve failed to reach 'spa' mode after retry — abort session gracefully
        runLog('WARNING', `[HEATING] Valve failed ${valveResult.attempts}x — aborting preheat, no activePreheat session created. Spa will NOT auto-shut off at event end.`);
        sendValveFailureAlert();
        saveState({
          ...prev,
          phase: 'idle',
          activePreheat: null,
          failedPreheat: true,
          weather,
        });
        return;
      }

      runLog('INFO', `[PREHEAT_PENDING→ACTIVE] Valve confirmed 'spa'. Session activated at ${activatedAt}.`);

      const confirmedState = valveResult.confirmedState;
      const currentCheckedAt = new Date(Date.now()).toISOString();

      const activePreheat = buildPreheatSession({
        nextSpaEvent: prev.nextSpaEvent,
        activatedAt,
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
        checkedAt: currentCheckedAt,
        phase: 'heating',
        activePreheat,
        weatherApproval: readWeatherApproval()
      });
      return;
    }
  }

  // Unknown / stale phase — reset gracefully
  saveState(buildState({ phase: 'idle', weather: weather ?? null }));
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(err => {
    runLog('ERROR', err.message);
    process.exit(1);
  });
}

module.exports = { main, resolveWeatherCheckMs };
