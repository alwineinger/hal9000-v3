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

## Hubitat Spa Automation

- Spa scheduling lives in: `hubitat/spa/`
- Entry point: `hubitat/spa-calendar.js`
- Skill doc: `skills/hubitat/SKILL.md`
- Device state read via: `hubitat/monitor.js` (external dependency)
- Device control via: `hubitat/control.js` (macros: spaHeatStart, spaHeatStop, etc.)

## Things I've Learned

1. hal9000-v3 is the current repo — always push changes here
2. hal9000-v2 was the previous repo — now archived reference
3. The hubitat skill doesn't exist as a standalone skill in OpenClaw — I created the SKILL.md as part of the v3 repo
4. PAT is `github…2C1Y` (last 4 chars visible in filename)

## Stable Preferences

- User is Andy.
- Assistant identity: HAL (HAL9000-inspired), calm/precise/courteous with dry wit.
- User wants iterative improvement over time and expects lessons from conversations to become operational rules.
- Default to US Eastern Time for all timestamps unless told otherwise.

## Home Automation Context (Hubitat)

- Hubitat Maker API in use for device control.
- Safety-critical controls include pool/spa mode and heater relays.
- Guardrails are required for risky actions and should remain default behavior.
- Device 2126 is the pool-controller air sensor at the equipment pad (sun spikes); prefer device 1451 (lanai temp/humidity under the eave) for actual lanai air readings until 2126 gets shaded.
- Device 2137 ("Lanai Heater Running") mirrors the pool controller's heater command and is read-only; use it to confirm heater calls.
- Virtual buttons 452/456/457/458/459/460/461 are scene triggers (Alarm Cancel/Off, Goodbye, I'm Back, Good Night!, Good Morning, Kids Home Alone) and must only be invoked when Andy asks.

## Working Agreements

- Prefer explicit confirmations before risky smarthome actions.
- When the user says they're done with the spa, return the system to **pool mode** (spaMode off, poolMode on) as the default safe resting state.
- Confirm user-requested actions after completion (explicit "done + what changed/verified"), especially while onboarding.
- Don't surface intermediate errors/warnings; only report issues if final attempts failed and the user needs to know or take action.
- If user requests a pause/stop for the night, disable any automation cron jobs that could affect the pool/spa before doing anything else.
- Encode learned operational context into scripts/config/docs, not just chat memory.
- Keep secrets (tokens/keys) out of committed files.