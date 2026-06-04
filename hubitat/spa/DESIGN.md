# Spa Automation Design

### Overview
The spa automation ensures the spa reaches 102°F by the start of a calendar "Spa" event. It is implemented as a state machine driven by a launchd agent (every 15 min), with state persisted in data files.

### Architecture

**Key principle:** The Hayward PL-PLUS handles heater regulation autonomously. OpenClaw's only jobs are: (1) start preheat at the right time with weather approval, (2) stop and return to pool mode at event end.

**Components:**
- `hubitat/spa/scheduler.js` — state machine orchestrator, reads state from files, calls control.js macros
- `hubitat/spa/calendar-fetch.js` — queries khal for "Spa" events (next N days), outputs JSON (primary)
- `hubitat/spa/calendar-direct.js` — direct iCloud CalDAV via curl + node-ical (alternative, no khal/vdirsyncer dependency)
- `hubitat/spa/control.js` — Hubitat device macros: spaHeatStart, spaHeatStop, poolNormal, officeFlash
- `hubitat/spa/approval.js` — weather approval state machine
- `hubitat/spa/telegram.js` — sends Telegram approval prompts
- `hubitat/spa/approval-poll.js` — polls Telegram for yes/no replies to approval prompts
- `hubitat/spa/weather-fetch.js` — fetches weather from wttr.in for preheat decision

**State files (all in data/):**
- `spa-state.json` — main scheduler state with phase, nextSpaEvent, activePreheat
- `spa-weather-approval.json` — weather approval status
- `spa-preheat-override.json` — manual preheat override
- `spa-preheat-history.json` — historical session data

### State Machine

The scheduler has 4 explicit phases:

**IDLE (phase: "idle")**
- Launchd fires → scheduler reads state
- No active preheat → polls khal for "Spa" events (next 7 days)
- No events found → exit (nothing to do)
- Event found → calculate leadMinutes, preheatStartMs = event.start - leadMinutes, write state, exit

**PREHEAT_PENDING (phase: "idle" + nextSpaEvent + preheatStartMs set)**
- If now < preheatStartMs → exit (waiting)
- If now >= preheatStartMs:
  - Weather risky AND no valid approval → send Telegram approval prompt, set phase:"preheat_pending_approval", exit
  - Weather risky AND approval pending → poll approval, if approved → spaHeatStart, set phase:"heating"
  - Weather clear → spaHeatStart, set phase:"heating"

**HEATING (phase: "heating", activePreheat in state)**
- PL-PLUS handles heating autonomously
- If now < event.end → nothing, exit (PL-PLUS running)
- If now >= event.end → spaHeatStop, finalize session, set phase:"idle"

**PREHEAT_PENDING_APPROVAL (phase: "preheat_pending_approval")**
- Poll approval file
- If approved → spaHeatStart, phase:"heating"
- If denied/expired → clear state, phase:"idle"

### Weather Approval
- Only triggered when weather is risky (rain/storm within preheat window)
- One-shot gate — once approved, no re-approval needed during preheat
- Approval sent via Telegram, reply polled on next launchd cycle
- Timeout: 5 min, then preheat defaults to YES and proceeds

### Calendar Integration

**Primary: calendar-fetch.js (khal)**
- Uses khal to query vdirsyncer-synced iCloud calendars
- No `-a` flag needed — khal's title filter isolates "Spa" events
- Synced path: `~/.local/share/vdirsyncer/calendars/`
- Run: `node calendar-fetch.js --days N` → JSON array of `{uid, title, start, end}`

**Alternative: calendar-direct.js (CalDAV)**
- Direct iCloud CalDAV via curl — no vdirsyncer/khal dependency
- Uses `@xmldom/xmldom` for XML parsing, `node-ical` for ICS parsing
- Queries `https://caldav.icloud.com/` directly with app-specific password
- Same JSON output contract as calendar-fetch.js
- Useful when vdirsyncer/khal pipeline is unavailable
- `spaHeatStart`: sets spaMode=on, heaterPower=on, heaterAuto=on — PL-PLUS takes over from there
- `spaHeatStop`: sets spaMode=off, heaterAuto=off — returns to pool mode
- No ongoing control during preheat — PL-PLUS is autonomous

### Key Device IDs
| ID | Device |
|---|---|
| 2141 | Lanai Spa Mode |
| 2140 | Lanai Pool Mode |
| 2131 | Lanai Heater Power (Aux2) |
| 2138 | Lanai Heater Auto |
| 2137 | Lanai Heater Running (read-only) |
| 2125 | Spa Temp |
| 1451 | Lanai Temp/Humidity (preferred ambient) |

### Launchd Integration
- launchd fires every 15 minutes via `StartInterval` (not `TimerInterval` — macOS requires `StartInterval`)
- launchd runs: `node hubitat/spa/scheduler.js`
- Plist: `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist`
- Scheduler is stateless — reads/writes `data/spa-state.json` for all context
- launchd does NOT need to track active preheat — scheduler does via state file

### Design Decisions
1. **State machine vs event-driven:** Explicit phases make the scheduler idempotent — re-running any state does nothing extra, preventing double-fires
2. **One-shot heating:** spaHeatStart called once; PL-PLUS manages temp without further OpenClaw involvement
3. **Weather approval is one-shot:** Only needed at preheat start, not during preheat
4. **Session history kept:** buildPreheatSession/finalizeSession track actual vs estimated lead time for future model refinement