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

## Related

- [IDENTITY.md](./IDENTITY.md)
- [TOOLS.md](./TOOLS.md)
- [AGENTS.md](./AGENTS.md)