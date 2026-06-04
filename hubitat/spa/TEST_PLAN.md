# Spa Scheduler Test Plan

## Overview

End-to-end scenarios for the spa scheduling automation. Each scenario documents:
- **Trigger**: what causes this scenario
- **Expected behavior**: what the system should do
- **Actual behavior (after fixes)**: confirmed behavior
- **Exceptions**: known acceptable deviations per Andy's decisions

---

## Scenario A: Normal Preheat (Weather Clear)

**Trigger**: Spa event exists on calendar, weather is clear for the preheat window.

**Expected behavior**:
1. Scheduler fires at weatherCheckMs (weatherCheckLeadMin before preheatStartMs)
2. Weather risk = clear → no approval needed
3. spaHeatStart called at preheatStartMs
4. Valve confirmed 'spa' mode, activePreheat session created
5. PL-PLUS heats autonomously to 102°F
6. At eventEndMs → spaHeatStop → valve returns to 'pool'

**Actual behavior**: Matches expected.

**Exceptions**: None.

---

## Scenario B: Weather Risky + Approval Granted

**Trigger**: Spa event exists, weather is risky (rain/storm), user replies YES to Telegram approval prompt.

**Expected behavior**:
1. At weatherCheckMs, isWeatherRisky(weather) = true → approval prompt sent
2. User replies YES on Telegram
3. Next scheduler run: pollResult = approved → spaHeatStart at preheatStartMs (or immediately if preheatStartMs is past)
4. Valve confirmed → activePreheat session created
5. At eventEndMs → spaHeatStop

**Actual behavior**: Matches expected. Approval is one-shot; no re-approval during preheat.

**Exceptions**: None.

---

## Scenario C: Weather Risky + Approval Denied

**Trigger**: Spa event exists, weather is risky, user replies NO (or times out → default YES per Option A).

**Expected behavior**:
- **Reply NO**: Scheduler goes idle immediately, no heating. Telegram notification sent.
- **Timeout (default YES)**: Preheat proceeds as if weather were clear. This is the chosen design (Option A from review).

**Actual behavior**: Timeout → `expireApprovalDefaultYes` called → proceed to heating.

**Exceptions**: Timeout default behavior (Option A) is intentional.

---

## Scenario D: Manual Override Before PreheatStartMs

**Trigger**: User creates `spa-preheat-override.json` with a manual preheat time (e.g., for a same-day unscheduled soak).

**Expected behavior**:
1. Phase 1 detects override → preheatStartMs set from override.startAt (capped at maxOverrideLeadHours = 12h from now)
2. Phase 2 starts heating at override start time
3. PL-PLUS runs until event end time OR max 12hr, whichever comes first

**Actual behavior**: Matches expected.

**Exceptions**: None.

---

## Scenario E: Multi-Event — Same Day (Morning + Afternoon)

**Trigger**: Two Spa events on the same calendar day (e.g., 9am and 3pm).

**Expected behavior**:
- Phase 1 picks the first (earliest-start) event as `nextSpaEvent`
- If preheat for morning event is already active, afternoon event is ignored until next day's scheduler run
- Morning event heating completes, spa returns to pool mode, afternoon event processed on next run

**Actual behavior**: Phase 1 picks events[0] (sorted by start time). Only one event is tracked at a time.

**Exceptions**:
- If morning event starts heating before afternoon event is detected, the afternoon event is not picked up until the next day's scheduler runs. Acceptable — only one event can be active at a time.

---

## Scenario F: Multi-Event Across Week

**Trigger**: Spa events on multiple days across the week (e.g., Tuesday and Thursday).

**Expected behavior**:
- Phase 1 picks the next upcoming event (events[0] sorted by start time)
- After that event completes, scheduler goes idle → next run picks the following event
- Each event is treated independently with its own preheat window

**Actual behavior**: Matches expected.

**Exceptions**: None.

---

## Scenario G: Late Event Detection (PreheatStartMs in Past)

**Trigger**: Spa event is created after preheatStartMs has already passed (e.g., user adds an event with only 30 minutes' notice).

**Expected behavior**:
1. Phase 1 detects event → preheatStartMs is in the past
2. Phase 2 sees nowMs >= preheatStartMs → spaHeatStart called immediately (no wait)
3. `waitForValveReady` polls until valve confirms 'spa'
4. PL-PLUS heats; spa may not reach 102°F by event start (acceptable — it does its best)

**Actual behavior**: Matches expected. No special handling needed; the `nowMs >= preheatStartMs` check in Phase 2 causes immediate heating.

**Actual behavior**: Matches expected. `nowMs >= preheatStartMs` check in Phase 2 causes immediate heating. Telegram notification sent: "Heating started X min late. Estimated ready time: HH:MM AM/PM ET." (implemented commit 270ee45)

**Exceptions**: Spa may not reach 102°F if preheat was delayed. Acceptable — system does its best given available time.

---

## Scenario H: Event Cancelled During Heating (C2/C3)

**Trigger**: Spa event is removed from calendar while heating phase is active.

**Expected behavior**:
1. Phase 3 heating path re-fetches calendar at top of each run
2. `currentEvent = liveEvents.find(e => e.uid === prev.nextSpaEvent.uid)` → null
3. spaHeatStop called (idempotent — skips if already in pool mode)
4. Telegram message sent: "Your spa event was removed from the calendar — I've turned off the spa."
5. Phase set to 'idle', activePreheat cleared

**Actual behavior**: Calendar re-fetch added to Phase 3 heating path. Event removal triggers spaHeatStop + Telegram notification.

**Exceptions**: None.

---

## Scenario I: Event End Time Changed During Heating (C2/C3)

**Trigger**: Spa event end time is extended or shortened while heating phase is active.

**Expected behavior**:
1. Phase 3 re-fetches calendar → finds event with same uid but different end time
2. `currentEvent.end !== prev.nextSpaEvent.end` → nextSpaEventEndMs updated, state saved
3. Heating continues with new end time
4. If new end time is already past, heating stops immediately

**Actual behavior**: End time change detected and persisted. Heating adapts to new end time.

**Exceptions**: None.

---

## Scenario J: Manual PL-PLUS Override During Active Preheat (M3)

**Trigger**: User manually switches PL-PLUS to pool mode while scheduler is actively heating (e.g., decided not to use the spa after all).

**Expected behavior**:
- PL-PLUS stays in pool mode — manual override takes precedence
- Scheduler will call spaHeatStop on next run (already in pool → idempotent skip)
- At event end time, scheduler calls spaHeatStop (no-op since already in pool)
- Spa remains off

**Actual behavior**: Acceptable. PL-PLUS 12hr timeout and manual override are independent safeguards. Scheduler handles it gracefully.

**Exceptions**: None (acceptable — no fix needed per Andy's decision).

---

## Scenario K: Valve Failure With Notification

**Trigger**: Valve does not reach 'spa' state after `spaHeatStart` and one retry.

**Expected behavior**:
1. `waitForValveReady` exhausts retries → returns `{ valveOk: false }`
2. Valve failure alert sent via Telegram
3. Scheduler goes to `idle` phase with `failedPreheat: true`
4. No activePreheat session created — spa was never heated
5. `nextSpaEventEndMs` is preserved so scheduler will not act on this event again
6. User must manually resolve valve issue

**Actual behavior**: Matches expected. Telegram alert sent. failedPreheat state prevents re-heating for same event.

**Exceptions**: None.

---

## Scenario L: Approval Expires → Default YES

**Trigger**: Weather risky, approval prompt sent, user does not reply within `weatherApprovalTimeoutMin` (5 minutes).

**Expected behavior**:
- Approval times out → `expireApprovalDefaultYes` called in approval-poll.js
- Status set to 'approved', decisionSource = 'timeout-default-yes'
- Next scheduler run proceeds to spaHeatStart as if approved
- Preheat continues without explicit user confirmation

**Actual behavior**: Matches expected (Option A — default YES on timeout).

**Exceptions**: None.

---

## Scenario M: Manual OFF During Active Preheat (M2)

**Trigger**: User manually turns spa off via Hubitat app during an active preheat session.

**Expected behavior**:
- PL-PLUS is in manual/override mode — scheduler cannot control it
- Scheduler calls spaHeatStop when event ends (or on next run) — idempotent since already off
- If user turns spa back on manually, PL-PLUS handles it autonomously
- Scheduler's `failedPreheat` flag is NOT set (the user intentionally overrode, not a valve failure)

**Actual behavior**: spaHeatStop is idempotent — skips if already in pool mode. Scheduler handles gracefully.

**Exceptions**: None (acceptable — no additional fix needed per Andy's decision).

---

## Scenario N: Weather Forecast Changes Mid-Heating (W2)

**Trigger**: Weather was clear at preheat start, but forecast changes to rain/storm while heating is active.

**Expected behavior**:
- Weather approval is one-shot — only evaluated at weatherCheckMs, not continuously during heating
- No re-approval triggered; heating continues regardless of weather change
- PL-PLUS continues heating to 102°F

**Actual behavior**: Acceptable — one-shot approval design. No fix needed per Andy's decision.

**Exceptions**: None.

---

## Scenario O: Late Approval Reply After Heating Started (A2/A3)

**Trigger**: User replies YES to the approval prompt after heating has already started (e.g., phone was offline).

**Expected behavior**:
- If spa is already heating, the approval reply is noted but has no effect on active heating
- If event is later cancelled, Phase 3 calendar re-fetch will stop the spa regardless
- Approval file is not deleted after heating starts — cleaned up on next event cycle

**Actual behavior**: Acceptable — calendar cancellation is the real safeguard, not approval status. No fix needed per Andy's decision.

**Exceptions**: None.

---

## Scenario P: Scheduler Crash Mid-Pregame

**Trigger**: Scheduler crashes (process.exit(1) due to unhandled error) during Phase 2 before `activePreheat` is set.

**Expected behavior**:
- State file has `phase: 'idle'`, `nextSpaEvent` set, `preheatStartMs` set, but no `activePreheat`
- Next scheduler run (after launchd restarts it) enters Phase 2 normally
- Since nowMs >= preheatStartMs, spaHeatStart is called immediately
- PL-PLUS handles heating from there
- Event end time is tracked via `nextSpaEventEndMs` (persisted from Phase 1)

**Actual behavior**: Matches expected. Scheduler is stateless (reads state from file), so crash is recoverable.

**Exceptions**: If crash happens after spaHeatStart but before session is written to history, the session won't be in history. Acceptable — no audit trail for that run, but scheduler continues normally.

---

## Scenario Q: Scheduler Crash Mid-Heating

**Trigger**: Scheduler crashes during Phase 3 (active heating).

**Expected behavior**:
- State file has `phase: 'heating'`, `activePreheat` set, `nextSpaEventEndMs` persisted
- Next scheduler run detects Phase 3 path → eventEnded check fires → spaHeatStop → idle
- PL-PLUS is autonomous and keeps heating even without the scheduler
- On next run, spaHeatStop called and session finalized

**Actual behavior**: Matches expected. PL-PLUS is independent of the scheduler during active heating.

**Exceptions**: None.

---

## Running the Tests

Tests are manual (integration tests against real calendar and Hubitat):

1. **Setup**: Ensure scheduler is running via launchd (`launchctl list | grep spa`)
2. **Calendar events**: Create/delete "Spa" events in iCloud calendar
3. **Override**: Create/remove `data/spa-preheat-override.json`
4. **Weather**: Use Tampa weather — rainy days are rare in summer, so artificial weather testing requires mocking
5. **Approval**: Monitor `data/spa-weather-approval.json` for state transitions

**Log location**: `data/spa-scheduler.log` — check for INFO/WARNING/ERROR entries after each scenario run.