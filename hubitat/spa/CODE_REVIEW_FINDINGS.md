# Spa Automation — Full Code Review Findings (with Test Scenario Cross-Reference)

**Date:** 2026-06-06
**Reviewer:** coding_specialist
**Scope:** All spa files, launchd plists, plus cross-reference against TEST_PLAN.md (16 scenarios), AUDIT_FINDINGS.md (prior 2026-05-28 audit)

---

## 🔴 CRITICAL (3)

### C1 — Hardcoded Hubitat API Token in monitor.js:12
**File:** `hubitat/monitor.js`, line 12
```js
const HUB_TOKEN = proces…OKEN || '108c58a4-aeff-4301-9610-7dd56b40a035';
```
A full live token is hardcoded as fallback. The launchd plist sets `HUBITAT_TOKEN_FILE` but NOT `HUBITAT_ACCESS_TOKEN`, so when run via launchd, monitor.js **always** falls through to the hardcoded token. Additionally, `control.js` uses `HUBITAT_TOKEN`/`HUBITAT_TOKEN_FILE` while `monitor.js` uses `HUBITAT_ACCESS_TOKEN` — two different env var names for the same credential.
- **Security risk:** Token in git history. Token rotation silently breaks monitor.js.
- **Prior audit:** Not addressed.
- **Scenarios affected:** ALL (every scheduler run reads snapshot via monitor.js)

### C2 — Launchd StartInterval Is 60s, Not 15min
**Files:** `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist` and `hubitat/plists/ai.openclaw.spa-scheduler.plist`
Both have `<key>StartInterval</key><integer>60</integer>`. Scheduler header previously said "Runs every 15 min." (fixed — now says "every 60 seconds"). 900 runs/day instead of 96.
- **Prior audit:** Section 4 mentions "plist verification was not performed within allotted time." This confirms the plist was never checked.
- **Scenarios affected:** ALL (900× daily makes every scenario fire ~10× more than designed; log noise masks debugging)

### C3 — Repo Plist vs Installed Plist Out of Sync
**Files:** `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist` vs `hubitat/plists/ai.openclaw.spa-scheduler.plist`
Installed plist has `StandardOutPath=/tmp/spa-scheduler.log`, `StandardErrorPath=/tmp/spa-scheduler.err`. Repo copy omits those but adds `ProcessType=Interactive` and `Umask=63`. Deploying from repo would regress logging.
- **Prior audit:** Not addressed.
- **Scenarios affected:** Deployment safety.

---

## 🟠 HIGH (4)

### H1 — isWeatherRisky(null) Returns false (Fails Open)
**File:** `hubitat/spa/weather.js`, line 23: `if (!weather) return false;`
When `fetchWeather()` returns null (API down, rate limit), heating proceeds without safety check.
- **Prior audit:** Not addressed.
- **Scenarios affected:** ALL weather-risky scenarios (B, C, L, N). If weather API is down during a storm, scenario A behavior is triggered when B/C/L would be correct.

### H2 — isWeatherRisky Keyword+Precip Short-Circuit Defeats Forecast Check
**File:** `hubitat/spa/weather.js`, lines 25-28
When current `desc` contains rain/storm keywords but `precipMm < 2.54mm`, returns `false` immediately — bypassing the hourly forecast check entirely. "Light rain, 0.5mm now" with "thunderstorm in 2 hours" → returns "not risky."
- **Prior audit:** Not addressed.
- **Scenarios affected:** B, C. Approval prompt may never be sent when it should be.

### H3 — Approval Timeout Not Communicated to User in Prompt
**File:** `hubitat/spa/weather.js`, lines 71-80 (`buildWeatherApprovalPrompt`)
Prompt says "Default is YES if you do not respond" but never mentions the specific timeout duration. User has 20 min (from plist: `SPA_WEATHER_APPROVAL_TIMEOUT_MIN=20`) but doesn't know it.
- **Prior audit:** Not addressed.
- **Scenarios affected:** B, C, L.

### H4 (NEW) — Scenario H: Event Cancellation Does NOT Send Telegram Alert
**File:** `hubitat/spa/scheduler.js`, line 26 (imports)
TEST_PLAN.md Scenario H states: "Telegram message sent: 'Your spa event was removed from the calendar — I've turned off the spa.'" But `sendEventCancelledAlert` (defined in `telegram.js:75`) is **never imported** into `scheduler.js`. The Phase 3 cancellation path (line 612-615) only writes a runLog line:
```js
runLog('INFO', `[HEATING] Event uid=... not in live calendar but end time not yet reached — continuing (khal boundary edge case).`);
```
If the event is gone AND end time has passed, spaHeatStop is called but no Telegram notification fires. This is a feature gap — the function exists but isn't wired in.
- **Prior audit:** Not addressed.
- **Scenarios affected:** H.

---

## 🟡 MEDIUM (8)

### M1 — monitor.js valveState Is Raw Switch Value, Not Interpreted
**File:** `hubitat/monitor.js`, line 78: `valveState: spaMode` (raw 'on'/'off')
Scheduler checks `state?.valveState === 'spa' || state?.valveState === 'on'`. The `'spa'`/`'pool'` branches are dead code — monitor.js never returns interpreted states. Currently harmless (the `'on'`/`'off'` checks still work), but if someone updates monitor.js to use `interpretValveState()` like control.js does, the scheduler checks for `'spa'` would suddenly start matching while `'on'` would stop matching.
- **Prior audit:** Not addressed.
- **Scenarios affected:** J, K, M (manual valve override detection)

### M2 — Smoke Test Uses `{ id: 'evt1' }` But Calendar Events Use `uid`
**File:** `hubitat/spa/test-smoke.js`, lines 78-84
`nextSpaEvent: { id: 'evt1', ... }` produces `sessionId: "undefined:..."`. Test passes only because it checks `sess && sess.sessionId` (any truthy string). Prior audit fix #2 fixed session.js to use `.uid` but the test was never updated.
- **Prior audit:** Fix #2 addressed session.js. Test file regression.
- **Scenarios affected:** Testing only. A real bug where uid is missing would pass this test.

### M3 — resolveWeatherCheckMs Receives Unused nextSpaEvent Parameter
**File:** `hubitat/spa/scheduler.js`, lines 170-173 (definition) and call sites 252-257, 290-295
Function definition destructures only `{ preheatStartMs, weatherCheckLeadMin }` but both call sites pass `nextSpaEvent`. No clamping to prevent weather check after event start.
- **Prior audit:** Not addressed.
- **Scenarios affected:** G (late event). If weatherCheckMs falls after event start, the scheduler could still evaluate weather when it's too late.

### M4 — Phase 4 Approved Path Lacks Event-Ended Guard (Asymmetric with Expired Path)
**File:** `hubitat/spa/scheduler.js`, lines 676-698 vs 699-710
The expired path (line 704) has a guard: `if (prev.nextSpaEventEndMs && nowMs > prev.nextSpaEventEndMs)`. The approved path does NOT. If approval arrives after the event has already ended, the scheduler will call `spaHeatStart` for a past event. The heating will be caught by Phase 3 on the next run, but this is wasted effort and an unnecessary valve cycle.
- **Prior audit:** Not addressed.
- **Scenarios affected:** O (late approval reply after event end)

### M5 — No Telegram Notification on Explicit Denial (Phase 2 + Phase 4)
**Files:** `hubitat/spa/scheduler.js`, line 477 (Phase 2) and line 711 (Phase 4)
Both denial paths go idle silently. TEST_PLAN Scenario C says "Telegram notification sent" on denial but no code path calls any notification. Neither `sendEventCancelledAlert` nor any denial-specific alert is imported or invoked.
- **Prior audit:** Not addressed.
- **Scenarios affected:** C.

### M6 — SPA_WEATHER_APPROVAL_TIMEOUT_MIN Default Layer Discrepancy
**Files:** `hubitat/spa/config.js`, `hubitat/spa/scheduler.js`, `hubitat/spa/approval.js`
Three different defaults: `config.js:5`, `scheduler.js:30` (`cfg.weatherApprovalTimeoutMin ?? 30`), `approval.js:5` (`timeoutMin = 5`). The plist sets `20`. The effective timeout is 20 (plist) or 30 (if no plist env). The `approval.js` default of 5 is never used because scheduler always passes a value. Confusing for debugging.
- **Prior audit:** Not addressed.
- **Scenarios affected:** L.

### M7 — No Circuit Breaker on Hubitat/Weather API Failures
**File:** `hubitat/spa/scheduler.js` — `readSnapshot()` (10s timeout) and `fetchWeather()` (10s connect timeout via curl) called every run.
If Hubitat is down, every run blocks ~20s and re-hits APIs. No exponential backoff. With 60s StartInterval this is ~33% of runtime wasted. With 900s it would be fine, but with 60s it's significant.
- **Prior audit:** Not addressed.
- **Scenarios affected:** ALL under network failure.

### M8 — config.json Has spaScheduler Config Nested Inside `devices` Object
**File:** `hubitat/config.json`
```json
"devices": {
  "spaScheduler": { "pollIntervalMin": 15, ... },
  "spaMode": "2141", ...
}
```
A config object is sibling to device ID strings. If any code does `cfg.devices.spaScheduler` expecting a string ID, it gets an object. The `control.js` guard for "Unknown alias" would fail on this.
- **Prior audit:** Not addressed.

---

## 🔵 LOW (5)

### L1 — Dead Import in monitor.js:7
`const fetch = require('node:http')` — imported as `fetch` but never used. Actual HTTP uses `require('http').get()` inline.

### L2 — calendar-direct.js Typo
Line 152: `href.includes('/notification')` (singular) should be `/notifications/` (plural, standard CalDAV).

### L3 — calendar-direct.js Never Referenced by Scheduler
Full direct iCloud CalDAV implementation exists but no automatic fallback from `calendar-fetch.js`.

### L4 — waitForValveReady Retry Semantics Confusing
Signature says `retries = 1` but up to 3 state checks are performed. Returned `attempts` is `retries + 1 = 2` — underreported by 1.

### L5 — 'America/New_York' Timezone Hardcoded in 2 Files
`weather.js:68` and `telegram.js:139`. If timezone changes, needs updating in both places.

---

## ✅ Prior Audit Verification

| Audit Fix # | Description | Status |
|-------------|-------------|--------|
| 1 | Session.js exponential overflow fix | ✅ Verified: `elapsedMinutes` now computed from `activatedAt`, non-accumulating |
| 2 | uid vs id in session.js | ✅ Verified: `sessionId = ${nextSpaEvent.uid}:${checkedAt}` |
| 3 | Finalization path + max-duration safety net | ✅ Verified: try/catch around spaHeatStop, max-duration cap present |
| 4 | Guardrail error message copy-paste | ✅ Verified: poolMode/spaMode messages correct |
| 5 | runSpaMacro failure resilience | ✅ Verified: try/catch at lines 580-584, 648-662 |
| 6 | Audit hygiene (session.js header) | ✅ Verified: docstring present |

**No regressions found in the 6 prior fixes.**

---

## 📋 Test Scenario Coverage Gap Analysis

| Scenario | Code Supports? | Notes |
|----------|---------------|-------|
| A: Normal Preheat | ✅ | Fully supported |
| B: Weather + Approval | ✅ | Fully supported |
| C: Weather + Denied | ⚠️ | No Telegram notification on denial (M5) |
| D: Manual Override | ✅ | Supported via override file |
| E: Multi-Event Same Day | ✅ | events[0] pick with sequential processing |
| F: Multi-Event Week | ✅ | Sequential processing after each event completes |
| G: Late Event | ✅ | Works via nowMs >= preheatStartMs. Late-start alert sent |
| H: Event Cancelled | ⚠️ | Telegram notification never sent (H4) even though function exists |
| I: End Time Changed | ✅ | Fully supported with state update |
| J: Manual PL-PLUS Override | ✅ | Graceful — idempotent spaHeatStop |
| K: Valve Failure | ✅ | Telegram alert + failedPreheat state |
| L: Approval Expiry | ✅ | Default YES via expireApprovalDefaultYes |
| M: Manual OFF | ✅ | Graceful — idempotent spaHeatStop |
| N: Weather Changes Mid-Heating | ✅ | Intentional — no re-approval (one-shot design) |
| O: Late Approval Reply | ✅ | Calendar cancellation is real safeguard |
| P: Crash Mid-Pregame | ✅ | Stateless design recovers on next run |
| Q: Crash Mid-Heating | ✅ | Stateless design + autonomous PL-PLUS |

---

## 📊 Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 4     |
| MEDIUM   | 8     |
| LOW      | 5     |

**Top 3 action items:**
1. **C1:** Remove hardcoded Hubitat token from monitor.js; unify on `HUBITAT_TOKEN_FILE` env var
2. **C2:** Fix launchd StartInterval from 60 to 900 (or update header comment if 60s is intentional)
3. **H1:** Default `isWeatherRisky(null)` to `true` — fail closed, not open
