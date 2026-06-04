# MEMORY.md - HAL's Long-Term Memory

## Identity

- **Name:** HAL 9000 (short: HAL)
- **Emoji:** 🔴
- **Repo:** https://github.com/alwineinger/hal9000-v3

## Critical Workflow Rule

**When I modify workspace files, push to GitHub.** The workspace lives in the hal9000-v3 repo. Any file edits (IDENTITY.md, SOUL.md, TOOLS.md, AGENTS.md, skills, hubitat code, etc.) must be committed and pushed to `origin main`.

This ensures continuity — my memory and configuration persist across sessions.

## Git Setup

- GitHub PAT stored at: `~/.openclaw/secrets/github-hal-pat.txt`
- Credential helper: `store` (git stores credentials after first push)
- Git config: user.name=HAL, user.email=hal@example.com

To push after changes:
```bash
cd ~/.openclaw/workspace
git add -A
git commit -m "describe changes"
git push
```

## Agent Routing Rule (Critical)

**Always use `agentId` when spawning subagents.** Without it, `runtime: "subagent"` defaults to MiniMax-M2.7 regardless of task name.

```javascript
sessions_spawn({ agentId: "coding_specialist", runtime: "subagent", task: "...", taskName: "..." })
sessions_spawn({ agentId: "grok", runtime: "subagent", task: "...", taskName: "..." })
```

Available: `coding_specialist` (DeepSeek-V4-Pro), `grok` (Grok-4.3). Always verify `agents_list` before first spawn in a session.

`~/.openclaw/openclaw.json` is backed up to `config/openclaw.json` in the hal9000-v3 repo. After any config change, commit and push it:
```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/workspace/config/openclaw.json
cd ~/.openclaw/workspace
git add config/openclaw.json
git commit -m "backup: openclaw.json"
git push
```

## Hubitat Spa Automation

- Spa scheduling lives in: `hubitat/spa/`
- Entry point: `hubitat/spa/scheduler.js` (launchd-driven, every 15 min)
- Primary calendar: `hubitat/spa/calendar-fetch.js` (khal reads local .ics, which vdirsyncer keeps fresh via `com.andy.vdirsyncer-sync.plist` polling ~every 15 min)
- Alt calendar: `hubitat/spa/calendar-direct.js` (direct iCloud CalDAV via curl + node-ical)
- Device state read via: `hubitat/monitor.js` (external dependency)
- Device control via: `hubitat/control.js` (macros: spaHeatStart, spaHeatStop, etc.)
- launchd plist: `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist` (uses `StartInterval 60`, not `TimerInterval`) — spa override: `~/.openclaw/workspace/data/spa-preheat-override.json`
- Skill doc: `skills/hubitat/SKILL.md`
- Device state read via: `hubitat/monitor.js` (external dependency)
- Device control via: `hubitat/control.js` (macros: spaHeatStart, spaHeatStop, etc.)
- launchd plist: `~/Library/LaunchAgents/ai.openclaw.spa-scheduler.plist` (uses `StartInterval`, not `TimerInterval`)

## Things I've Learned

1. hal9000-v3 is the current repo — always push changes here
2. hal9000-v2 was the previous repo — now archived reference
3. The hubitat skill doesn't exist as a standalone skill in OpenClaw — I created the SKILL.md as part of the v3 repo
4. PAT is `github…2C1Y` (last 4 chars visible in filename)

### Spa Automation Design Principle

Once `spaHeatStart` is called and approved (if needed), PL-PLUS handles heating autonomously. The openclaw scheduler's only post-start responsibilities: (1) weather approval before calling `spaHeatStart`, (2) `spaHeatStop` at event end to return to pool mode. No ongoing openclaw involvement during preheat.


## Stable Preferences

- User is Andy.
- Assistant identity: HAL (HAL9000-inspired), calm/precise/courteous with dry wit.
- User wants iterative improvement over time and expects lessons from conversations to become operational rules.
- Default to US Eastern Time for all timestamps unless told otherwise.

## Home Automation Context (Hubitat)

- Hubitat is the primary HA controller. Not all devices are exposed to HAL — Andy controls what gets exposed.
- Hubitat has thermostat integration (Nester/Ecobee/Honeywell or native Hubitat device) — currently not wired up to HAL.
- Hubitat integrated with **Hayward PL-PLUS** pool automation controller via RS485 (code in Andy's hubitat/aqualogic repos). PL-PLUS handles heater behavior autonomously once spa mode + heater relay + heater auto are all enabled — no ongoing openclaw control needed during preheat.
- **Pool/Spa key behavior:** When `spaMode on` + `heaterPower on` + `heaterAuto on` → PL-PLUS manages heating to target temp on its own. No re-invocation needed during preheat. Spa automation's only end-of-event job: return to pool mode (`spaMode off`, `heaterAuto off`).
- Spa preheat workflow: launchd polls khal every 5 min → detects upcoming "Spa" event → reads preheat override file if present → calculates lead time (null guard → 60 min default) → calls `spaHeatStart` macro at preheat window → PL-PLUS handles heating → launchd calls `spaHeatStop` macro at event end to return to pool mode.
- **launchd plist env vars**: HUBITAT_TOKEN_FILE, SPA_WEATHER_APPROVAL_TARGET (numeric chat ID not "telegram:handle"), SPA_WEATHER_APPROVAL_CHANNEL, SPA_WEATHER_APPROVAL_NOTIFY=1, OPENCLAW_BIN. Missing any of these silently breaks the scheduler.
- **SPA_WEATHER_APPROVAL_TARGET**: Must be numeric Telegram chat ID (e.g. "8004363273"), not "telegram:username" format — that format causes "Unknown target" errors.
- Weather approval: if storms/rain present at preheat start (chance ≥ 35% per OpenWeather forecast), scheduler requests Telegram approval before calling `spaHeatStart`. Once approved, no more approval polling needed (heater is autonomous). Andy saw 58% thunder at 5pm ET in external forecast vs OpenWeather's 58% as well — data matched.
- Hubitat Maker API in use for device control.
- Safety-critical controls include pool/spa mode and heater relays.
- Guardrails are required for risky actions and should remain default behavior.
- Device 2126 is the pool-controller air sensor at the equipment pad (sun spikes); prefer device 1451 (lanai temp/humidity under the eave) for actual lanai air readings until 2126 gets shaded.
- Device 2137 ("Lanai Heater Running") mirrors the pool controller's heater command and is read-only; use it to confirm heater calls.
- Virtual buttons 452/456/457/458/459/460/461 are scene triggers (Alarm Cancel/Off, Goodbye, I'm Back, Good Night!, Good Morning, Kids Home Alone) and must only be invoked when Andy asks.

## Pool/Spa Device IDs
| ID | Label |
|---|---|
| 2124 | Pool Temp |
| 2125 | Spa Temp |
| 2126 | Lanai Pool Air Temp (equipment pad, afternoon sun) |
| 1451 | Lanai Temp/Humidity (under eave, preferred ambient) |
| 2131 | Lanai Heater Power (Aux2) |
| 2137 | Lanai Heater Running |
| 2138 | Lanai Heater Auto |
| 2140 | Lanai Pool Mode |
| 2141 | Lanai Spa Mode |
| 226 | Office Light |

## HVAC Device IDs (Hubitat)
| ID | Label | Current Value |
|---|---|---|
| 1806 | Advanced Honeywell T6 Pro Thermostat | cooling, setpoint 73°F |
| 2189 | hvac_cool_away | 80°F |
| 2190 | hvac_cool_day | 76°F |
| 2191 | hvac_cool_night | 73°F |
| 2192 | hvac_heat_away | 60°F |
| 2193 | hvac_heat_day | 72°F |
| 2194 | hvac_heat_night | 65°F |
| 1992 | thermController-Advanced-Honeywell-T6-Pro (Thermostat Controller) | — |

## HVAC Schedule Variables
| HAL name | Hubitat device | Description |
|---|---|---|
| thermawaycool | hvac_cool_away | 2189 | Cooling setpoint when away |
| thermawayheat | hvac_heat_away | 2192 | Heating setpoint when away |
| thermdaycool | hvac_cool_day | 2190 | Cooling setpoint during day |
| thermdayheat | hvac_heat_day | 2193 | Day heating setpoint |
| thermnightcool | hvac_cool_night | 2191 | Night/bedroom cooling setpoint |
| thermnightheat | hvac_heat_night | 2194 | Night heating setpoint |

## Operational Lessons

- Weather fetch via `spa/weather-fetch.js` using OpenWeather `/data/2.5/forecast` for Tampa FL (lat 28.0375, lon -82.4246). API key in `~/.openclaw/secrets/openweather-api.txt`. Falls back to null on failure — scheduler never blocks on weather. isWeatherRisky() thresholds: rain ≥ 50% or thunder ≥ 35% in any hourly window within 4 hours. Desc keyword match also triggers risk.

- **Weather approval requires explicit env var**: `SPA_WEATHER_APPROVAL_NOTIFY=1` must be set in the launchd plist for Telegram approval prompts to send. Without it, `sendWeatherApprovalPrompt` returns `{skipped: true}` — silently no-op.
- **`uid` vs `id` in approval matching**: calendar events emit `uid`, not `id`. `approval.js` originally used `nextSpaEvent.id` (always undefined) — now fixed to use `uid`.
- **launchd fires on 5-min grid, not dynamic**: `StartInterval 300` means :00, :05, :10, :15... The scheduler sees preheat windows on the next 5-min boundary, not at the exact preheat time. With 5-min runs, max lag is 4 min 59 sec vs 14 min 59 sec before.

- **Use subagents proactively** for any work that would block main agent responsiveness in chat. Spawn background tasks rather than doing heavy work inline.
- Prefer explicit confirmations before risky smarthome actions.
- When the user says they're done with the spa, return the system to **pool mode** (spaMode off, poolMode on) as the default safe resting state.
- Confirm user-requested actions after completion (explicit "done + what changed/verified"), especially while onboarding.
- Don't surface intermediate errors/warnings; only report issues if final attempts failed and the user needs to know or take action.
- If user requests a pause/stop for the night, disable any automation cron jobs that could affect the pool/spa before doing anything else.
- Encode learned operational context into scripts/config/docs, not just chat memory.
- Keep secrets (tokens/keys) out of committed files.