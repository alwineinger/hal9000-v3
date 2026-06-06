# SPA Automation End-to-End Audit — Findings & Fixes

Date: 2026-05-28 (EDT packaging for 2026-05-29 session execution)  
Auditor: coding_specialist (subagent)  
Scope: All files in the audit list (scheduler, session, approval, control, monitor, config, state, history)

## 1. Summary of Fixes Applied

| # | Bug Class | File | Description | Status |
|---|-----------|------|-------------|--------|
| 1 | Arithmetic overflow / feedback loop | `session.js` | `elapsedMinutes` in each observation was `(session.observedMinutes || 0) + delta` then `observedMinutes = sum(all)`. This produced exponential doubling: 0,1,2,4,8,... and eventual ~1.33e+36 overflow after ~120 scheduler ticks. | FIXED |
| 2 | `id` vs `uid` field mismatch | `session.js` | `buildPreheatSession` used `nextSpaEvent.id` (undefined) for both `sessionId` and `eventId`. The calendar produces `uid`. | FIXED |
| 3 | Incorrect finalization path in scheduler | `scheduler.js` | Phase 3 did call `spaHeatStop` and `finalizeSession` on event end, but if `spaHeatStop` threw, the state would remain stuck "heating". Also lacking a max-duration safety net for missing/invalid event end times. | FIXED |
| 4 | Guardrail error message copy-paste error | `control.js` | `"spaMode on blocked while spaMode is already on"` (should reference `poolMode`). | FIXED |
| 5 | No resilience against device commands | `scheduler.js` | `runSpaMacro` failures during finalization would blow up `main()` and leave state `heating` indefinitely on that run; the next 60-second run had a chance but no guarantee. | FIXED |
| 6 | Audit hygiene | `session.js` | Added header docstring clarifying the intended meaning of the *three* minute fields (delta vs. total vs. session-level summary). | FIXED |

## 2. Data Flow Verified (call-graph)

```
scheduler.main()
  ├─> loadState()/saveState() ⟷ data/spa-state.json
  ├─> readSnapshot()          ──> monitor.js  (Hubitat Maker API)
  ├─> fetchWeather()          ──> spa/weather-fetch.js (OpenWeather)
  ├─> fetchCalendarEvents()   ──> spa/calendar-fetch.js (khal)
  ├─> buildPreheatSession()   ──> spa/session.js
  ├─> updateSessionObservation() ──> spa/session.js
  ├─> finalizeSession()       ──> spa/session.js
  ├─> isWeatherRisky()        ──> spa/weather.js
  ├─> calculateLeadMinutes()  ──> spa/preheat.js
  ├─> approvalMatchesContext, createPendingApproval, stamp..., decideFromPollResult ──> spa/approval.js
  ├─> readWeatherApproval/writeWeatherApproval ⟷ data/spa-weather-approval.json
  └─> runSpaMacro()           ──> control.js (macro spaHeatStart / spaHeatStop via Hubitat Maker API)
                               └─> approval-poll.js (spawnSync) ──> read/write same json
```

States/phases (exact transitions):
- `idle`             → collects events → `preheat_pending` (or immediate `heating` if `preheatStartMs <= now` and no weather block).
- `preheat_pending`  → `heating` if weather risk absent or prior approval granted.
- `preheat_pending_approval` → waits on `approval-poll.js --check` (spawned) → `approved` (Phase 4→heating) or `denied/expired` (→`idle`).
- `heating`          → observations updated every tick (60-second real schedule, more dense in test state files); on `now >= eventEnd` (or max duration), runs `spaHeatStop`, calls `finalizeSession`, then `idle`.
- `idle` + no events → `idle`.

## 3. Important Date/Time Consistency Findings

- All arithmetic uses milliseconds internally (`Date.parse`, `Date.now()`, `* 60 * 1000`).
- Calendar events are emitted by `calendar-fetch.js` as bare `YYYY-MM-DDTHH:MM:SS` strings (no TZ suffix). `Date.parse` on Node in Eastern interprets these as **local time** (EDT/EST). Scheduler, approval, preheat etc. all use the same `Date.parse`, so relative math is internally consistent. Daylight-saving edge-cases may exist at the autumn transition but are outside the scope of the observed bugs.
- `preheatStartMs` 1780012800000 in the inspected state file is **historically interesting** (very early relative to event time). This is stale data (an earlier buggy run) and does not represent a current code path problem.
- Observation timestamps (`capturedAt`) in the broken state file are valid ISO strings that include the `Z` suffix, so those were parsed correctly. The math failure was purely internal.
- No mixed unit bugs (ms vs minutes) in the active code paths remain after the fixes.

## 4. Items NOT Treated as "Bugs to Fix by the Subagent"

- Design choice: `spaHeatStop` deliberately leaves `heaterPower` ON (only turns `heaterAuto` OFF and restores valves to pool). This matches `poolNormal` behavior and appears intentional for shared filter/pump hardware.
- `valveOk` variable computed but unused in Phase 2 heater start path — cosmetic.
- `weather` snapshot at `main()` entry freezes for the entire 60-second run; fresh forecasts are used at the next tick. Acceptable.
- Low-frequency edge (calendar returns non-Spa events, empty array handling, etc.) follows existing robustness opinions that were not changed.
- Launchd plist environment variable verification was completed by inspection of the source (all references match documented variables); a live Mac side-by-side dump was not performed within the allotted time. The (already-fixed) `SPA_WEATHER_APPROVAL_TARGET` format issue is documented in the prompt as handled elsewhere.

## 5. Remaining Manual Verification (for the primary agent)

1. After commit+push, `git diff --name-only` should show `session.js`, `scheduler.js`, `control.js`, `AUDIT_FINDINGS.md`.
2. Before the next prod scheduler tick, temporarily **force-finalize the current stuck session** via direct edit of `data/spa-state.json` (or wait one wall-clock hour for the event-end time to roll since the offending state was captured pre-end). Both approaches will prove finalization works.
3. Run the scheduler locally (`node spa/scheduler.js`) inside the 60-second window where the (fixed) session should stop observing and correctly transition while writing the stop macro + finalized session to history. Observe `observedMinutes` values are sane (never exceed total wall minutes of the preheat).
4. Confirm `data/spa-weather-approval.json` handling in the dirty state (it contains an `approved` approval from before the current run). The fresh scheduler run will ignore it for event `0D10EFFB...` because `approvalMatchesContext` requires both `uid` and `preheatStart` to match.

## 6. Rollback Guidance

If the patch causes any issue, revert the commit:

```bash
cd /Users/oc_user/.openclaw/workspace/hubitat
git revert HEAD --no-edit
git push
```

Or selectively restore single files:

```bash
git checkout HEAD~1 -- hubitat/spa/session.js hubitat/spa/scheduler.js hubitat/control.js
git commit -am "revert(spa): back out audit fixes for investigation"
```

## 7. Post-Audit Code State Assertions

- `session.observedMinutes` computed from `Date.parse(session.startedAt)` each tick ⇒ strictly monotonically increasing by the scheduler interval (every 60 real seconds, or ~1 in the test harness).
- Each observation `elapsedMinutes` = minutes since start of that session (non-accumulating).
- `observedRateFPerHour` is recomputed correctly from first/last valid temperature deltas divided by real total minutes.
- `finalizeSession` is now armored by `try/catch` around `spaHeatStop`, guaranteed to write `completedAt` + `completionReason` and return the state to `idle`.
- `sessionId` and `eventId` now read from `.uid`.
- Guardrail message is truthful.

End of audit.
