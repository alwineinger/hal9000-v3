# Daily Memory: Hubitat Spa Automation Code Review
**Date:** 2026-05-28
**Task:** Full audit of HAL's Hubitat integration and spa automation code

---

## Scope Examined

```
hubitat/
├── monitor.js          ← device state reader (Maker API)
├── spa-calendar.js     ← legacy shim entry point
└── spa/
    ├── index.js        ← barrel export
    ├── config.js       ← config loader / constants
    ├── scheduler.js    ← main orchestrator
    ├── preheat.js      ← lead-time calculation
    ├── session.js      ← preheat observation sessions
    ├── approval.js     ← weather approval state machine
    ├── weather.js      ← weather risk assessment
    ├── telegram.js     ← Telegram approval messaging boundary
    ├── utils.js        ← pure helpers
    └── test-smoke.js   ← smoke tests

skills/
└── caldav-calendar/   ← vdirsyncer/khal CalDAV skill (installed)
```

---

## Per-File Summary

### 1. `hubitat/monitor.js`
**Purpose:** Reads current spa/pool device state from Hubitat via Maker API HTTP calls.

**What it does:**
- `readAttribute(deviceId, attribute)` → reads a single device attribute
- `readSwitch(deviceId)` → reads full device and extracts `switch` attribute
- `readSnapshot()` → parallel fetch of 7 device values, returns structured state object

**Device IDs used:**
| Key | ID | Description |
|-----|----|-------------|
| `spaTemp` | 2125 | temperature |
| `spaMode` | 2141 | switch (on=spa, off=pool) |
| `heaterPower` | 2131 | switch |
| `heaterRun` | 2137 | switch |
| `heaterAuto` | 2138 | switch |
| `poolTemp` | 2124 | temperature |
| `ambientTemp` | 2126 | air temp |

**Hardcoded config (lines 8-10):**
```js
const HUB_HOST = process.env.HUBITAT_HUB_HOST || '10.40.1.227';
const HUB_APP_ID = process.env.HUBITAT_APP_ID || '2321';
const HUB_TOKEN = process.env.HUBITAT_ACCESS_TOKEN || '108c58a4-aeff-4301-9610-7dd56b40a035';
```
Token is a real Maker API token embedded in source. Not a secret breach since it's in a private repo, but violates MEMORY.md rule about keeping secrets out of committed files.

**Status:** ✅ Functional. Clean implementation with proper error swallowing on reads (returns null on failure).

---

### 2. `hubitat/spa-calendar.js`
**Purpose:** Legacy entry point shim.

**What it does:** Imports `main` from `./spa/scheduler` and runs it. The comment explicitly says this is a shim that delegates to the refactored scheduler. This is fine.

**Status:** ✅ Correctly deprecated in favor of `spa/scheduler.js`.

---

### 3. `hubitat/spa/index.js`
**Purpose:** Barrel export for all spa sub-modules.

**Status:** ✅ Correct.

---

### 4. `hubitat/spa/config.js`
**Purpose:** Centralized configuration constants and env loader.

**Defaults:**
- `TARGET_TEMP_F: 102`
- `BASE_HEAT_RATE_FPH: 4`
- `PREHEAT_BUFFER_MIN: 15`
- `MIN_HEAT_RATE_FPH: 1.5`
- `WEATHER_APPROVAL_TIMEOUT_MIN: 5`
- `MAX_OVERRIDE_LEAD_HOURS: 12`
- `WEATHER_LOCATION: 'Tampa, FL'`
- `SPA_ALLOW_LLM: false` (must be explicitly enabled)
- `SPA_WEATHER_APPROVAL_NOTIFY: false`
- `SPA_WEATHER_APPROVAL_CHANNEL: 'telegram'`

**Status:** ✅ Clean. All values overridable via env vars.

---

### 5. `hubitat/spa/scheduler.js`
**Purpose:** Main orchestrator — coordinates calendar fetch, device state, preheat decisions, weather gate, and heat execution.

**Entry point flow:**
1. Fetch calendar events (filters for "Spa" title)
2. `readSnapshot()` from monitor.js
3. Calculate lead time via `preheat.js`
4. Resolve preheat window (normal vs. override)
5. Evaluate weather risk gate
6. Send Telegram approval prompt if needed
7. Execute `runSpaMacro('spaHeatStart')` if safe
8. Post-action 5-second re-read snapshot
9. Update/finalize session observation
10. Write `spa-state.json` snapshot

**Critical reference (line 47):**
```js
const CONTROL_SCRIPT = path.join(ROOT, 'hubitat', 'control.js');
```
And (line 109):
```js
function runSpaMacro(macro) {
  return run('node', [CONTROL_SCRIPT, 'macro', macro, '--confirm']);
}
```
**This file does NOT exist.** The scheduler calls `control.js` to run `spaHeatStart`/`spaHeatStop` macros, but `control.js` has never been created in this repo.

**Calendar script path (line 44):**
```js
const CALENDAR_SCRIPT = path.join(ROOT, 'skills', 'apple-calendar-ops', 'scripts', 'calendar_fetch.py');
```
This path does not exist in the workspace. The `caldav-calendar` skill uses `vdirsyncer` + `khal` directly, not a `calendar_fetch.py` script. There is no `skills/apple-calendar-ops/` directory.

**Weather data gap:**
The scheduler reads `weather` from `previousSnapshot?.weather || currentState?.weather || null` — but `readSnapshot()` never fetches weather data. Weather must come from a previous run's state file. If the state file doesn't have weather, `isWeatherRisky()` will always return `false`, bypassing the weather gate entirely. No fresh weather fetch is implemented.

**State transition logic issues:**
- `shouldPreheat` is `true` when `nowMs >= preheatStartMs && nowMs < nextSpaEndMs`
- But the heat execution checks `needsSpaHeat = currentState?.valveState !== 'spa' || currentState?.heaterAuto !== 'on'`
- If the preheat window has passed (nowMs >= nextSpaEndMs) but the spa is still heating, `shouldPreheat` becomes false — the scheduler won't call `spaHeatStop`, leaving the spa running. No cleanup logic for post-event shutdown.
- The session finalization checks `Date.now() >= nextSpaEndMs` but only calls `finalizeSession` if there's a `previousActivePreheat`. The active preheat tracking is fragile — if the process crashes between `spaHeatStart` and finalization, the state file retains a stale `activePreheat`.

**Status:** ⚠️ Incomplete. Missing `control.js` and mismatched calendar script path.

---

### 6. `hubitat/spa/preheat.js`
**Purpose:** Pure lead-time calculation with historical rate blending.

**Key functions:**
- `sessionScore()` — weights historical sessions by conditions similarity
- `calculateHistoricalRate()` — weighted average of up to 8 most-similar sessions
- `calculateLeadMinutes()` — computes preheat window in minutes
- `resolvePreheatWindow()` — applies override or calculates from event start

**Issues:**
- `calculateLeadMinutes()` uses `weatherPenalty()` from `weather.js` but the caller (`scheduler.js`) never applies it — the penalty is computed in `preheat.js` only via the blended rate calculation, but the raw `weatherDesc` field is passed, not a penalty multiplier. The weather penalty logic is never actually invoked.
- `resolvePreheatWindow()` has good override logic but the `overrideIgnored` path doesn't account for `leadMinutes` being `null` (which happens when `spaTempF` is unknown), falling back to `eventStartMs - 0` which is the event start itself — 0 preheat buffer.

**Status:** ⚠️ Functional but weather penalty not properly integrated.

---

### 7. `hubitat/spa/session.js`
**Purpose:** Pure session management for preheat observations.

**What it does:**
- `buildPreheatSession()` — creates session with initial observation
- `updateSessionObservation()` — adds new observation, recomputes overall rate
- `finalizeSession()` — marks complete with reason

**Issues:**
- `updateSessionObservation()` computes `observedRateFPerHour` from first to last valid observation when `totalElapsed >= 15`. But `totalElapsed` is the sum of all `elapsedMinutes` across observations, not the time from first to last. This can be wildly off if observations are taken at irregular intervals.
- `lastObservedSpaTempF` is tracked but never used for anything.

**Status:** ⚠️ Minor — rate calculation could be incorrect.

---

### 8. `hubitat/spa/approval.js`
**Purpose:** Weather approval state machine.

**Key functions:**
- `approvalMatchesContext()` — matches eventId + preheatStart
- `createPendingApproval()` — creates pending approval with prompt text
- `stampApprovalPrompt()` — marks prompt sent, sets expiry
- `decideApproval()` — transitions to approved/denied

**Issue:** The `decideApproval()` function exists but is never called anywhere in `scheduler.js`. Weather approval decisions are never actually processed — the scheduler only reads the approval file but never evaluates user responses to the Telegram message. The approval loop is open-loop: it sends a prompt but never receives or processes a reply.

**Status:** ⚠️ Incomplete — approval decision path not connected to any input.

---

### 9. `hubitat/spa/weather.js`
**Purpose:** Weather risk assessment.

**Key functions:**
- `weatherPenalty()` — applies temp and condition multipliers (never called from scheduler)
- `isWeatherRisky()` — checks current conditions + 4-hour forecast window
- `buildWeatherApprovalPrompt()` — generates prompt text

**Issue:** `weatherPenalty()` is defined but never invoked anywhere in the codebase. The weather-based rate adjustment is a dead code path.

**Status:** ⚠️ Dead code in `weatherPenalty()`. Otherwise functional.

---

### 10. `hubitat/spa/telegram.js`
**Purpose:** Thin boundary for Telegram weather approval messaging via `openclaw message send`.

**Current behavior:** Sends a fixed prompt text via `spawnSync` CLI call. Does not parse responses, does not read back Telegram messages.

**Config required:**
- `SPA_WEATHER_APPROVAL_NOTIFY=1`
- `SPA_WEATHER_APPROVAL_TARGET=<telegram-user-id>`
- `SPA_WEATHER_APPROVAL_CHANNEL=telegram`
- `OPENCLAW_BIN` (defaults to `openclaw`)

**Issues:**
- The message is sent but the scheduler has no mechanism to read the reply. The approval loop is incomplete.
- No error recovery if `openclaw message send` fails mid-way.

**Status:** ⚠️ Half-implemented — can send but not receive.

---

### 11. `hubitat/spa/utils.js`
**Purpose:** Pure utility helpers.

**Functions:** `parseIntOrNull`, `temperature`, `bucket`, `round`, `toIsoWithLocalOffset`.

**Status:** ✅ Clean. All used appropriately.

---

### 12. `hubitat/spa/test-smoke.js`
**Purpose:** Smoke tests for pure modules.

**Status:** ✅ Functional tests present.

---

### 13. `skills/caldav-calendar/`
**Purpose:** vdirsyncer + khal CalDAV sync/query skill for iCloud and other CalDAV providers.

**Contents:**
- `SKILL.md` — full usage docs (sync, query, create, edit, delete events)
- `_meta.json` — OpenClaw skill metadata
- `.clawhub/origin.json` — origin tracking

**Note:** This skill is the installed calendar skill. The scheduler references `skills/apple-calendar-ops/scripts/calendar_fetch.py` which doesn't exist. The actual calendar query would need to use `khal list` commands per the caldav-calendar skill docs, not a Python script.

**Status:** ⚠️ Mismatched — scheduler references non-existent script.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│  ENTRY: spa-calendar.js (shim)                               │
│          → spa/scheduler.js main()                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │ Calendar │ │ Monitor  │ │  Weather │
   │ Fetch    │ │ (read)   │ │ (risk)   │
   └────┬─────┘ └────┬─────┘ └────┬─────┘
        │            │            │
        ▼            ▼            ▼
   spa-preheat   readSnapshot   isWeatherRisky()
   calculateLeadMinutes          weatherPenalty() [DEAD]
        │
        ▼
   resolvePreheatWindow()
   (override logic)
        │
        ▼
   ┌─────────────────────────────────────────┐
   │  WEATHER GATE                            │
   │  isWeatherRisky && !approval?            │
   │  → sendWeatherApprovalPrompt()           │
   │  (telegram.js → openclaw message send)   │
   │  ⚠️ No response-reading path             │
   └─────────────────────────────────────────┘
        │
        ▼ (if cleared)
   runSpaMacro('spaHeatStart')
   ⚠️ control.js MISSING — spaHeatStart/spaHeatStop unreachable
        │
        ▼
   write spa-state.json
   (activePreheat session update)

   MISSING: spaHeatStop on event end
   MISSING: approval decision processing
   MISSING: weather fetch (uses stale snapshot weather)
```

---

## Issues List

### Critical

| # | File | Issue | Description |
|---|------|-------|-------------|
| C1 | `scheduler.js` | **`control.js` missing** | Line 47 defines `CONTROL_SCRIPT` pointing to `hubitat/control.js` which has never been created. `runSpaMacro()` will throw a spawn error. Spa cannot be turned on or off. |
| C2 | `scheduler.js` | **Calendar script path wrong** | Line 44 references `skills/apple-calendar-ops/scripts/calendar_fetch.py` which does not exist. The `caldav-calendar` skill has no such script. Spa scheduler cannot fetch calendar events. |
| C3 | `approval.js` + `scheduler.js` | **Approval loop is open** | `decideApproval()` exists but is never called. No code reads Telegram replies or processes approval decisions. Weather gate can block preheat indefinitely without resolution. |

### Warnings

| # | File | Issue | Description |
|---|------|-------|-------------|
| W1 | `scheduler.js` | **No post-event shutdown** | When `nowMs >= nextSpaEndMs`, `shouldPreheat` becomes false but `spaHeatStop` is never called. Spa may remain in spa mode indefinitely after event ends. |
| W2 | `monitor.js` | **Hardcoded secrets** | Hubitat Maker API token (`108c58a4-aeff-4301-9610-7dd56b40a035`) and hub IP are hardcoded with fallback defaults. Should use only env vars; no defaults for tokens. |
| W3 | `monitor.js` vs MEMORY.md | **Device ID mismatch** | MEMORY.md says use device 1451 (lanai temp) for ambient readings instead of 2126 (sun spike). `monitor.js` hardcodes `ambientTemp: 2126`. Also, MEMORY.md mentions device 2126 is problematic for sun spikes. |
| W4 | `preheat.js` | **Weather penalty not applied** | `weatherPenalty()` in `weather.js` is never called. Rate calculations don't apply weather discount. Cold ambient air should slow heating but the code doesn't account for this in the preheat lead time. |
| W5 | `session.js` | **Rate calculation uses sum of intervals** | `totalElapsed` in `updateSessionObservation()` is the sum of all `elapsedMinutes` values, not the actual time span from first to last observation. Can give wrong rate. |
| W6 | `scheduler.js` | **Weather is stale** | `weather` is pulled from `previousSnapshot?.weather` — if no previous run exists or weather wasn't captured, `isWeatherRisky()` gets null and returns false, bypassing the weather gate entirely. No fresh weather fetch implemented. |

### Minor

| # | File | Issue | Description |
|---|------|-------|-------------|
| M1 | `session.js` | **Dead field** | `lastObservedSpaTempF` is tracked but never consumed. |
| M2 | `scheduler.js` | **heatingStalled always false** | TODO comment: trend-based stall detection not implemented. |
| M3 | `skills/caldav-calendar/` | **Hubitat skill doc missing** | MEMORY.md says `skills/hubitat/SKILL.md` exists — it doesn't. Only `caldav-calendar` skill is present. No Hubitat-specific skill doc. |

---

## Device ID Reference

| ID | Used in monitor.js | In MEMORY.md | Notes |
|----|-------------------|--------------|-------|
| 2124 | poolTemp ✅ | — | OK |
| 2125 | spaTemp ✅ | — | OK (not in MEMORY) |
| 2126 | ambientTemp ⚠️ | yes (but warned problematic) | MEMORY says use 1451 instead |
| 2131 | heaterPower ✅ | yes | OK |
| 2137 | heaterRun ✅ | yes | OK |
| 2138 | heaterAuto ✅ | yes | OK |
| 2141 | spaMode (valve) ✅ | yes | OK |
| 1451 | — | yes (preferred ambient) | Not used anywhere |
| 452/456/457/458/459/460/461 | — | yes (virtual buttons) | Never referenced in current code — safe |

---

## Recommended Remedies

### Immediate (Critical)

1. **Create `hubitat/control.js`** — Must implement:
   - `spaHeatStart`: switch valve to spa mode (device 2141 on), enable heater auto (device 2138 on)
   - `spaHeatStop`: switch valve to pool mode (device 2141 off), disable heater auto (device 2138 off)
   - Handle `macro` argument from scheduler: `spaHeatStart`, `spaHeatStop`
   - Optional: `forceOn` mode for 1-hour override use case
   - Use same Maker API pattern as `monitor.js`

2. **Fix calendar script path** — Replace `skills/apple-calendar-ops/scripts/calendar_fetch.py` with actual `khal list` commands per the `caldav-calendar` skill, or create a `scripts/calendar_fetch.py` that wraps khal.

3. **Implement weather approval decision loop** — Either:
   - Poll Telegram messages for approval responses after sending prompt, or
   - Use a file-based approval (e.g., write pending to `spa-weather-approval.json`, let HAL process it on next chat interaction)

### Short-term (Warnings)

4. **Fix ambient temp device** — Change `monitor.js` line: `ambientTemp: 2126` → `ambientTemp: 1451`

5. **Implement `spaHeatStop` on event end** — In `scheduler.js`, when `nowMs >= nextSpaEndMs && activePreheat`, call `runSpaMacro('spaHeatStop')` and finalize session.

6. **Add weather fetch** — Either integrate `weather.js` caller to fetch fresh data, or document that weather must be populated by a prior run.

7. **Fix `weatherPenalty()` call path** — In `preheat.js`'s `calculateLeadMinutes()`, apply `weatherPenalty(weather)` to the effective rate (divide rate by penalty).

8. **Fix `updateSessionObservation` rate** — Use actual elapsed time from first to last observation, not sum of interval lengths.

### Minor

9. **Remove hardcoded token defaults** — In `monitor.js`, require env vars with no defaults for sensitive values.

10. **Create `skills/hubitat/SKILL.md`** — Document the Hubitat integration end-to-end.

11. **Remove dead `lastObservedSpaTempF` field** or implement its use.

---

## Git Status

Last commit to workspace: `b0c373d Economize context — trim boilerplate, no behavior change`

Repo: `https://github.com/alwineinger/hal9000-v3`