# Spa Automation — Full Codebase Reference

**Repository:** `https://github.com/alwineinger/hal9000-v3`
**Workspace path:** `/Users/oc_user/.openclaw/workspace`
**launchd plist:** `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist`
**Data files:** `/Users/oc_user/.openclaw/workspace/data/spa-*.json`

---

## File Inventory

### Core Scheduler (state machine)
| File | Purpose |
|---|---|
| `hubitat/spa/scheduler.js` | Launchd-driven state machine. Orchestrates all phases. Stateless — all state in `data/spa-state.json`. |
| `hubitat/spa/index.js` | Barrel export for all spa modules. |

### Business Logic (pure — no I/O)
| File | Purpose |
|---|---|
| `hubitat/spa/config.js` | Config constants + env var loading. |
| `hubitat/spa/preheat.js` | `calculateLeadMinutes()` (historical rate chain), `resolvePreheatWindow()` (override logic), `sessionScore()`, `calculateHistoricalRate()`. |
| `hubitat/spa/session.js` | `buildPreheatSession()`, `updateSessionObservation()`, `finalizeSession()`. |
| `hubitat/spa/weather.js` | `isWeatherRisky()`, `weatherPenalty()`, `buildWeatherApprovalPrompt()`. |
| `hubitat/spa/approval.js` | `approvalMatchesContext()`, `createPendingApproval()`, `stampApprovalPrompt()`, `decideFromPollResult()`. |
| `hubitat/spa/utils.js` | `bucket()`, `round()`, `parseIntOrNull()`, `temperature()`, `toIsoWithLocalOffset()`. |

### I/O Boundaries
| File | Purpose |
|---|---|
| `hubitat/spa/telegram.js` | Sends Telegram approval prompts via `openclaw message send`. |
| `hubitat/spa/approval-poll.js` | Polls Telegram for yes/no replies to approval prompts. `--check` updates approval file. |
| `hubitat/spa/weather-fetch.js` | Fetches OpenWeather One Call API → `{ tempF, desc, precipMm, forecast[] }`. |
| `hubitat/spa/calendar-fetch.js` | Calls `khal list` → filters for "Spa" events → JSON `{uid,title,start,end}`. |
| `hubitat/spa/calendar-direct.js` | Direct iCloud CalDAV via curl + node-ical (alternative to khal). |

### External Dependencies
| File | Purpose |
|---|---|
| `hubitat/monitor.js` | `readSnapshot()` — reads Hubitat device state via Maker API. |
| `hubitat/control.js` | `runSpaMacro(macro)` — sends `spaHeatStart`, `spaHeatStop`, `poolNormal`, etc. to Hubitat. |
| `hubitat/spa/package.json` | npm deps: `@js-temporal/polyfill`, `@xmldom/xmldom`, `ical`, `luxon`, `node-ical`, `temporal-polyfill`. |

### Tests / Docs
| File | Purpose |
|---|---|
| `hubitat/spa/test-smoke.js` | Smoke tests for pure modules. |
| `hubitat/spa/DESIGN.md` | Architecture overview, state machine phases, design decisions. |
| `hubitat/spa/AUDIT_FINDINGS.md` | Audit findings and fixes applied (2026-05-28). |

---

## Key Constants (from `config.js` + `preheat.js`)

```js
// config.js defaults
TARGET_TEMP_F           = 102   // °F spa target
BASE_HEAT_RATE_FPH      = 4     // °F/hr default (used as fallback)
PREHEAT_BUFFER_MIN      = 15    // always added to lead time
MIN_HEAT_RATE_FPH       = 1.5   // floor after weather penalty
WEATHER_APPROVAL_TIMEOUT_MIN = 5 // min to respond before approval expires
MAX_OVERRIDE_LEAD_HOURS = 12    // max preheat window

// preheat.js hardcoded (no env override)
TARGET_TEMP_F           = 102
BASE_HEAT_RATE_FPH      = 15    // ⚠️ differs from config.js default of 4
MIN_HEAT_RATE_FPH       = 10    // ⚠️ differs from config.js default of 1.5
PREHEAT_BUFFER_MIN      = 10    // ⚠️ differs from config.js default of 15
```

> ⚠️ **Known inconsistency:** `preheat.js` defines its own hardcoded BASE_HEAT_RATE_FPH=15, MIN_HEAT_RATE_FPH=10, PREHEAT_BUFFER_MIN=10 — these differ from the config.js DEFAULTS. The scheduler's `calculateLeadMinutes` call passes `config` which has config.js values, but preheat.js also has hardcoded fallbacks. The effective values depend on whether config.js has an env override.

---

## State Machine Phases

```
IDLE (no nextSpaEvent)
  └─> fetchCalendarEvents()
      ├─ no events → stay idle
      └─ event found
          ├─ calculate leadMinutes (historicalRate → lastObservedRate → baseRate)
          ├─ resolvePreheatWindow() → preheatStartMs
          └─ Phase: idle + nextSpaEvent + preheatStartMs set

IDLE (nextSpaEvent + preheatStartMs set, no activePreheat)
  └─ nowMs < preheatStartMs → wait (exit)
  └─ nowMs >= preheatStartMs
      ├─ isWeatherRisky() == false → spaHeatStart → HEATING
      └─ isWeatherRisky() == true
          ├─ no valid approval → send Telegram prompt → PREHEAT_PENDING_APPROVAL
          ├─ approval pending → stay PREHEAT_PENDING_APPROVAL
          └─ approval approved → spaHeatStart → HEATING

PREHEAT_PENDING_APPROVAL
  └─ poll result
      ├─ approved → spaHeatStart → HEATING
      ├─ denied/expired → idle
      └─ still pending → wait (update checkedAt)

HEATING (activePreheat in state)
  └─ nowMs < eventEnd && !exceededMax → updateSessionObservation() → stay heating
  └─ nowMs >= eventEnd || exceededMax → spaHeatStop → finalizeSession → idle
```

---

## Weather Risk Logic (`isWeatherRisky`)

Returns `true` (risky) if ANY of:
1. **Current conditions keyword + precip:** `desc` matches `/rain|storm|thunder|squall|shower/` AND `precipMm >= 2.54` (0.1 inch)
2. **Current precip alone:** `precipMm >= 2.54` with no keyword
3. **Forecast hourly window** (now − 30 min → now + 4 hrs):
   - Keyword match in hourly desc → risky
   - `chanceofrain >= 50%` → risky
   - `chanceofthunder >= 35%` → risky
   - Keyword fallback: if `chanceofthunder` missing/0 but desc has `storm|thunder|thunders` → treated as 50%

**Weather penalty** (applied to heating rate):
- Ambient temp < 80°F → `Math.max(0.7, 1 - ((80 - tempF) * 0.03))`
- Rain/storm keyword in desc → `* 0.9`
- Combined and floored at `0.7`

---

## Historical Rate Chain (`calculateLeadMinutes`)

```
gap = targetTempF - spaTempF
  └─ gap <= 0 → return 0

historicalRate = calculateHistoricalRate(history, {
  startSpaBucket: bucket(spaTempF, 2),
  ambientBucket:  bucket(ambientF, 5),
  weatherDesc
})
  └─ filter: observedRateFPerHour finite, observedMinutes >= 30
  └─ score each session: spaBucket distance, ambientBucket distance, weather match, elapsed bonus
  └─ keep top 8 with score > 0.15
  └─ weighted average by score

lastObservedRate = sessions[sessions.length-1]?.observedRateFPerHour (if finite, >= 30 min)

effectiveRate =
  historicalRate (if finite) →
  lastObservedRate (if finite) →
  baseRate (config, fallback = 4°F/hr)

rate = max(MIN_HEAT_RATE_FPH, effectiveRate) / weatherPenalty

leadMinutes = ceil((gap / rate) * 60) + PREHEAT_BUFFER_MIN
```

---

## Data Files

| File | Contents |
|---|---|
| `data/spa-state.json` | `{ phase, nextSpaEvent, preheatStartMs, leadMinutes, activePreheat, weatherApproval, weather, checkedAt }` |
| `data/spa-weather-approval.json` | `{ eventId, preheatStart, status, reason, promptText, expiresAt, promptSentAt, decisionAt, decisionSource }` |
| `data/spa-preheat-history.json` | `{ updatedAt, sessions[] }` — last 40 sessions |
| `data/spa-preheat-override.json` | `{ startAt: "ISO timestamp" }` — forces preheat start at exact time |
| `data/spa-scheduler.log` | Rotated run log (7-day retention) |

---

## launchd Configuration

```xml
<key>Label</key><string>ai.openclaw.spa-scheduler</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>  <!-- fires every 60 sec, not 15 min — NOTE: log says 15 min in DESIGN.md but plist says 60 sec -->

<key>EnvironmentVariables</key>
<dict>
  <key>HUBITAT_TOKEN_FILE</key><string>/Users/oc_user/.openclaw/secrets/hubitat-api-key.txt</string>
  <key>SPA_CALENDAR_DAYS</key><string>7</string>
  <key>SPA_WEATHER_APPROVAL_CHANNEL</key><string>telegram</string>
  <key>SPA_WEATHER_APPROVAL_TARGET</key><string>8004363273</string>  <!-- numeric Telegram chat ID -->
  <key>SPA_WEATHER_APPROVAL_NOTIFY</key><string>1</string>          <!-- must be "1" to enable Telegram prompts -->
  <key>OPENCLAW_BIN</key><string>/opt/homebrew/bin/openclaw</string>
</dict>
```

**Important env vars:**
- `SPA_WEATHER_APPROVAL_TARGET` must be numeric chat ID (e.g. `"8004363273"`), not `"telegram:username"` — the latter causes "Unknown target" errors.
- `SPA_WEATHER_APPROVAL_NOTIFY=1` must be set for Telegram prompts to actually send — without it, `sendWeatherApprovalPrompt` returns `{skipped: true}` silently.
- `SPA_STATE_FILE`, `SPA_EVENTS_FILE`, `SPA_HISTORY_FILE`, `SPA_PREHEAT_OVERRIDE_FILE`, `SPA_WEATHER_APPROVAL_FILE`, `SPA_RUN_LOG_FILE` can override file paths.

---

## Hubitat Device IDs

| ID | Device | Notes |
|---|---|---|
| 2141 | Lanai Spa Mode | Write: `spaMode on` |
| 2140 | Lanai Pool Mode | Write: `poolMode on` |
| 2131 | Lanai Heater Power (Aux2) | Write: `heaterPower on/off` |
| 2138 | Lanai Heater Auto | Write: `heaterAuto on/off` |
| 2137 | Lanai Heater Running | Read-only mirror of heater command |
| 2125 | Spa Temp | Read current temp |
| 2124 | Pool Temp | Read |
| 2126 | Lanai Pool Air Temp | Equipment pad — affected by afternoon sun |
| 1451 | Lanai Temp/Humidity | Preferred ambient sensor (under eave) |

---

## How `spaHeatStart` Works (control.js macro)

1. `spaMode on` → device 2141
2. `heaterPower on` → device 2131
3. `heaterAuto on` → device 2138

PL-PLUS then autonomously heats to target. OpenClaw's only job post-start: wait 5 min for valve transit, then begin observations.

## How `spaHeatStop` Works

1. `spaMode off` → device 2141 (returns valves to pool)
2. `heaterAuto off` → device 2138

Note: `heaterPower` is intentionally NOT turned off — shared filter/pump hardware.

---

## Known Design Quirks

1. **launchd fires every 60 sec** (`StartInterval: 60` in plist), not every 15 min. DESIGN.md says 15 min but the actual plist uses 60 sec. The scheduler itself is stateless and self-rate-limited by state transitions.

2. **preheat.js hardcoded constants differ from config.js defaults** — BASE_HEAT_RATE_FPH is 15 in preheat.js but 4 in config.js DEFAULTS. The effective value depends on what `config` object is passed in.

3. **Weather approval is one-shot** — once approved for a given event+preheatStart, it is never re-prompted. If the user denies, the event is skipped entirely.

4. **Approval matching uses `uid` not `id`** — calendar events emit `uid`. The old bug used `.id` (always undefined).

5. **valveOk variable** — computed in `waitForValveReady()` but unused in Phase 2 path (only Phase 4 uses it). Cosmetic issue.

6. **Weather forecast horizon** — looks from `now - 30 min` to `now + 4 hrs` in hourly forecast. This means it can flag past weather as risky in the current-hour bucket.

7. **Override file (`spa-preheat-override.json`)** is read fresh on every scheduler run. If `override.startAt` is in the past, it's ignored and `leadMinutes` is calculated normally.

---

## Git History (recent)

```
0d06e31 fix(weather): require ≥0.1in precip (2.54mm) before rain triggers risk
e3b1b11 fix(preheat): wire historicalRate into effectiveRate calculation
327a48b refactor(spa): wire resolvePreheatWindow, apply weatherPenalty, add run log rotation
fb933c7 spa scheduler: fix const-reassignment crash, add valve guard, fix Phase 3 timestamps
2f6b800 spa scheduler: guard against stale preheat window and past events
0977bd3 session: track activatedAt vs startedAt; scheduler: 5-min warmup before first temp reading
94f07d6 scheduler: wait 5 min after spaHeatStart before first temp reading
eab6b80 fix(spa): remove Phase 1→2 fall-through; add lastObservedRate fallback in preheat.js
e9ffdc0 refactor(spa): end-to-end audit fixes
b6661a2 fix: use uid instead of id for calendar event matching in approvals
6fa8c67 Spa automation fixes: OpenWeather weather, leadMinutes null guard, override respect
```