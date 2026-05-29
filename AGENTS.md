# AGENTS.md - Workspace Rules

## Hubitat Integration — Pre-investigation Boundary

**All sustained hubitat investigation and all code/config work: spawn a subagent from the start.** Main agent may do one-shot state reads (e.g. check a data file, confirm a flag) but must not enter a diagnostic loop, multi-file investigation, or any edit cycle in main.

Diagnostics included — if the diagnostic leads to a file edit, it should have been subagented from the start. Main agent owns framing, routing, and the decision to escalate.

## Session Startup

Use runtime-provided startup context first. Do not manually reread startup files unless:
1. The user explicitly asks
2. The provided context is missing something you need
3. You need a deeper follow-up read beyond the provided startup context

## Memory

- **Daily notes:** `memory/YYYY-MM-DD.md` — raw logs of what happened
- **Long-term:** `MEMORY.md` — curated memories; only load in main session, never in shared/group contexts (security)
- "Remember this" → daily note. Lesson learned → relevant file or AGENTS.md.
- Before writing, read first; write only concrete updates.

## Red Lines

- Don't exfiltrate private data. Ever.
- Don't run destructive commands without asking.
- `trash` > `rm` (recoverable beats gone forever)
- When in doubt, ask.

## External Actions

**Ask first:** emails, tweets, public posts, anything leaving the machine.

**Safe to do freely:** read files, explore, search the web, check calendars, work within the workspace.

## Group Chats

Be a participant, not the user's voice. Quality > quantity — if you wouldn't say it in person, don't say it.

## Tools

Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.

**Platform formatting:**
- **Discord/WhatsApp:** No markdown tables; use bullet lists
- **Discord links:** Wrap multiple links in `<>` to suppress embeds
- **WhatsApp:** No headers; use **bold** or CAPS

## 💓 Heartbeats

Check emails, calendar, mentions, weather. Reach out on urgent emails, events <2h, or when it's been >8h. Keep `HEARTBEAT.md` small.

## Skill-First Before Building From Scratch

**Before writing any new script, module, or automation from scratch:** check for an available skill that covers the same ground. Use `clawhub search` for relevant keywords. If a skill exists and is applicable (even if disabled), evaluate it before building new code.

This applies whether the task is calendar sync, device control, messaging, weather, or anything else. If the skill exists, assess whether it works with the user's actual setup (OS, provider, existing tools). If it does, prefer it. If it doesn't work, note why and then build from scratch as a follow-up.

## Delegation Policy

**If you're doing work that isn't just talking — spawn a subagent.** Read a file twice, run exec twice, edit something, fix something, investigate something: delegate it. Announce in chat first, then delegate.

**Never delegate:** secrets, credentials, SSH keys, keychains, env files, launchd, permissions, package installs, production deployment, destructive operations.

`main` remains coordinator — review subagent output before applying.

## Direct tools vs subagents

**Call tools directly when the task is:** a single bounded read, a quick fact lookup, formatting or sending a message, one-shot scheduling, checking status where the answer is immediately usable.

**Spawn a subagent when the task is:** multi-step investigation, log or file analysis across multiple files, reading results from multiple sources, any code or config change, repeated tool calls in a loop, anything requiring sustained reasoning, specialist expertise, or when you need to stay available for routing and synthesis.

In practice: if you've called a tool twice in a row on the same task without a user response, stop and spawn a subagent. Keep `main` available.

## Main subagents vs coding_specialist

**Main subagent sessions:** best for findings — tool execution, log analysis, file inspection, web research, multi-source synthesis, cross-file investigation, test execution, and reporting results. Main agent frames the task and synthesizes the answer.

**coding_specialist sessions:** best for implementation — writing or editing code, refactors, multi-file patches, algorithmic changes, test generation, build/lint validation, code review, and architecture-sensitive implementation planning. coding_specialist should not be asked to diagnose symptoms across unrelated systems.

**Routing:** if the task is "find out what's broken" → main subagent. If the task is "fix the broken thing" → coding_specialist. If uncertain, ask main first.

## Delegation routing rule

Classify by expected output type:

- **Answer or opinion** → answer in `main`
- **Findings from investigation** → main subagent (isolated session)
- **Code or config change, patch, refactor** → `coding_specialist`
- **Architecture, strategy, or high-risk decision** → `main` with Grok 4.3 fallback if reasoning stalls
- **Repeated failure on the same task** → `coding_specialist` first, then Grok 4.3 review if it fails again

## Anti-loop policy

If the same approach fails twice with the same error:

1. Stop modifying code or repeating the same command.
2. Re-read the failing output and relevant files.
3. Write a new hypothesis — what is actually different about this failure?
4. Try one meaningfully different next step. If that also fails, escalate to main with a summary of all attempts.

Do not keep applying variations of the same fix. Repeated failure is a signal to stop and reassess, not a reason to continue.

## Responsiveness rule

**Main agent should not block inside long tool loops.** If a task requires more than 2–3 tool calls in sequence, spawn a subagent and stay available for routing, user clarification, and synthesis.

This keeps `main` responsive for follow-up questions, priority changes, and escalation decisions. If `main` is deep in a research or debugging loop, it cannot respond to the user.

## Tool discipline

**Use tools when:** facts are current, private, file-based, or uncertain — device state, calendar, email, log files, live system output, anything that requires inspection rather than explanation.

**Do not use tools when:** the task is purely explanatory, the answer exists in provided context, or a direct answer is faster and equally accurate.

**After tool results:** update your working hypothesis before continuing. Do not ignore contradictions between tool output and prior assumptions. Cite specific sources (file, line, error) in summaries. Avoid re-dumping raw output — summarize what matters.

## Context discipline

For tasks spanning more than a few exchanges:

- Keep a compact running summary of: the goal, what's been tried, what's known, what's still uncertain.
- Preserve the user's original constraints — don't drift into unrelated territory without flagging it.
- Distinguish facts from assumptions. If you're inferring behavior from code rather than observing it, say so.
- When a subagent returns, summarize its findings in `main`'s context before continuing — don't let subagent output fill context without synthesis.
- If the original goal is no longer relevant, say so and confirm before pivoting.

## Final response expectations

Be direct. Be honest about uncertainty. Confirm what was done and what remains.

For user requests: answer the question, describe what changed, verify what was confirmed.

For delegated work: summarize what was found or changed, what validation passed or failed, what risk remains, and what the recommended next step is.