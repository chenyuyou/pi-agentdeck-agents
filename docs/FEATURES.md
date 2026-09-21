# Features

What this package gives the pi coding agent, feature by feature. For install and
layer rules see the [README](../README.md); for the macOS-app mapping see
[UPSTREAM.md](../UPSTREAM.md).

- [1. The agent library](#1-the-agent-library)
- [2. Model tiers, fallbacks and read-first files](#2-model-tiers-fallbacks-and-read-first-files)
- [3. The routing catalog](#3-the-routing-catalog)
- [4. Delegation policy](#4-delegation-policy)
- [5. Task-adaptive auto-start (`/agentdeck-flow`)](#5-task-adaptive-auto-start-agentdeck-flow)
- [6. Plan gate](#6-plan-gate)
- [7. Auto-review after edits](#7-auto-review-after-edits)
- [8. Supervisor bridge](#8-supervisor-bridge)
- [9. Loops](#9-loops)
- [10. Commands, prompts and skills](#10-commands-prompts-and-skills)
- [11. Safety, cost and hygiene](#11-safety-cost-and-hygiene)
- [12. Files this package touches](#12-files-this-package-touches)

---

## 1. The agent library

Three specialist agents, byte-identical to the macOS app's bundled definitions:

| Agent | Role | Model (default overlay) | Thinking |
|---|---|---|---|
| `explorer` | read-only reconnaissance; reports files, data flow, unknowns | `muse-spark-1.3-contributor` | low |
| `planner` | implementation approach, trade-offs, ordering, validation | same | high |
| `reviewer` | evidence-backed review of a diff/plan/risk area | same | high |

All three are read-only (`read, grep, find, ls, bash` + `contact_supervisor`) and
use `systemPromptMode: replace`, so their body *is* the system prompt.

They are **seed files, not a live registry**: the package copies them into the
agent directory and the subagent runtime discovers them like any other agent.

```
~/.pi/agent/agents/{explorer,planner,reviewer}.md          # global install
<project>/.pi/agents/{explorer,planner,reviewer}.md        # project-local (-l)
```

Project-local wins over global, matching the runtime's own discovery order, and a
project file of the same name shadows the global one.

## 2. Model tiers, fallbacks and read-first files

The app keeps per-agent models in its UI; here they live in `models.json`
(the *overlay*), applied only as files are installed — the baseline files never
change.

```json
{
  "tiers": {
    "cheap":    { "model": "opencode-go/…" },
    "balanced": { "model": "opencode-go/…" },
    "genius":   { "model": "opencode-go/…" }
  },
  "agents": {
    "explorer": { "tier": "cheap",    "fallbackModels": ["opencode-go/…"] },
    "planner":  { "tier": "genius",   "fallbackModels": ["opencode-go/…"] },
    "reviewer": { "tier": "balanced", "fallbackModels": ["opencode-go/…"] }
  },
  "toolMap":   { "contact_supervisor": "ext:supervisor/contact_supervisor" },
  "toolAppend": []
}
```

Per agent you can set `model` (beats `tier`), `tier`, `thinking`, `toolsAppend`
and `fallbackModels`.

- **Fallbacks**: on a *model-looking* spawn error (model/auth/provider/thinking)
  the extension retries the next entry in order, notifying and auditing each
  attempt. Anything else fails fast. After explicit pins it deliberately does
  **not** fall back to "inherit the parent model" — a silent model change is
  worse than a visible failure.
- **`defaultReads`** (a mac field the runtime ignores) is honoured: every prompt
  this package builds starts with "Read these files first if present: …", and
  both catalogs show it as `reads:`, so model-initiated spawns see it too.

## 3. The routing catalog

The app appends a **catalog** to the parent prompt; this package injects the same
shape in two places — the system prompt on every turn, and the Agent **tool
description** (via the runtime's `toolDescriptionMode: "custom"`).

```text
Agent Deck orchestration (parent session):
- Delegation happens only through the Agent tool (`subagent_type`); it is not automatic — if you do not call it, nothing is delegated.
<delegation policy bullets>
- Fresh agents cannot see this conversation … every delegation must be self-contained.
- If you delegate planning to `planner`, convert its returned plan into your own working plan before implementing …
- Trust but verify: an agent's summary describes intent, not outcome.

Available agents (policy: balanced):
- explorer: <whenToUse> [outcome: reportOnly; tools: read, grep, find, ls, bash, contact_supervisor]
- planner:  … [outcome: reportOnly; tools: …; reads: context.md]
- reviewer: … [outcome: reportOnly; tools: …; reads: plan.md, progress.md]
```

It is read live from the agent directory (project first), so custom agents and
project overrides appear without regenerating anything. The description file is
read once at tool registration, so tool-description changes land on the **next**
pi session; the system-prompt half is live every turn.

## 4. Delegation policy

The app's real "when do agents start" knob is a prompt policy, not a scheduler:

| Policy | Meaning |
|---|---|
| `light` | delegate when it clearly improves the result; the parent may work directly |
| `balanced` *(default)* | delegate substantive implementation/investigation/planning/review; only trivial low-risk changes stay in the parent |
| `strict` | delegate anything substantive; the parent orchestrates and synthesizes |

```
/agentdeck policy light|balanced|strict
```

## 5. Task-adaptive auto-start (`/agentdeck-flow`)

**Off by default** (the app has no equivalent — this is an extra). When on, each
new task is classified heuristically (no extra model call) and the matching agent
is started immediately:

| Classification | Trigger examples | Agent started |
|---|---|---|
| `review` | "review 一下这个 diff" | `reviewer` |
| `plan` | "帮我重构 X"、"add a --json flag"、long open-ended requests | `planner` |
| `explore` | "这个项目怎么组织的"、"how does the auth flow work" | `explorer` |
| `none` | trivial markers (typo/rename/comment), short specifics, explicit delegation instructions, slash commands | — |

```bash
/agentdeck-flow                 # status: settings, this task, log path
/agentdeck-flow on|off          # auto-start
/agentdeck-flow test <text>     # show how a prompt would be classified
```

Safety: only `tui`/`rpc` sessions; one-shot `-p` runs and child sessions are
skipped (spawned prompts carry an `[agentdeck-flow]` marker, so a child can never
re-classify its own prompt). Every decision is appended to
`~/.pi/agent/agentdeck-flow.jsonl`.

## 6. Plan gate

```bash
/agentdeck-flow gate on|off     # off by default
```

With the gate on, the first `edit`/`write` of a `plan`-classified task is blocked
with a reason telling the model to obtain a plan first. It opens once a `planner`
run completes — correlated by agent id when this package started it, and it never
blocks more than twice, so it cannot deadlock.

## 7. Auto-review after edits

```bash
/agentdeck autoreview on|off    # off by default; one review per 10 min
```

After a turn that actually changed files, the bundled `reviewer` is spawned over
the change set through the runtime's cross-extension RPC (no extra parent turn).
It is role-appropriate by construction: the review is a real subagent run with its
own model, and its result arrives on the normal completion path.

Guards: `edit` files are recorded from `tool_execution_start` (pi exposes tool
`args` only there) and rolled back if the tool errors; interactive modes only;
one review per `autoreviewTtlMinutes` (default 10); every decision audited to
`~/.pi/agent/agentdeck-autoreview.jsonl`.

## 8. Supervisor bridge

Upstream prompts say "ask the supervisor one focused question" and list
`contact_supervisor`. Both halves are implemented:

| Side | Tool | Behaviour |
|---|---|---|
| child | `contact_supervisor(kind, message, options?)` | `progress` returns at once; `question`/`blocker` create a pending request and **wait** (default 180s) then return the answer |
| parent | `list_supervisor_requests` | what children are blocked on |
| parent | `answer_supervisor_request(id, answer)` | unblock that child |
| human | `/agentdeck-answer [<id> <answer>]` | answer without going through the model |

Transport is a JSON store (`agentdeck-supervisor-requests.json`) that the waiting
child polls and the parent writes, so it works for in-process and out-of-process
agent runners alike. On timeout the child is told to proceed with its
recommendation and record the assumption, so unattended runs never stall. The tick
of "subagent finished" costs nothing: children re-enter the normal completion path.

## 9. Loops

`/agentdeck-loop` runs the app's recommended **Analyze → Fix → Validate** cycle:

```
/agentdeck-loop <goal>      analyze (planner) → fix (maker) → validate, up to maxIterations
/agentdeck-loop status      current run
/agentdeck-loop stop        stop after the in-flight step
```

```json
{ "loop": { "command": "npm test", "maker": "general-purpose", "maxIterations": 3, "stepTimeoutSeconds": 900 } }
```

Each step consumes the previous one: the planner's returned plan is fed to the
maker, and a failing validation's output is fed into the next maker attempt.
Without a `command` the loop stops after the maker step and says so — validation
is never silently assumed. Runs are written to
`~/.pi/agent/agentdeck-loop/<run>.json` (goal, plan, steps, validation output,
outcome), and only the 5 most recent finished runs are kept in memory.

User-launched only — matching the app, whose loops are not automatic either.

## 10. Commands, prompts and skills

| Command | Purpose |
|---|---|
| `/route [task]` | pick a bundled agent (shows model + role) and delegate |
| `/agentdeck` | agents, models, `whenToUse`, auto-review + policy + tool-desc state |
| `/agentdeck sync` | re-install agents from baseline + overlay (backups first) |
| `/agentdeck doctor` | agents dir, baseline, overlay, runtime, supervisor, auto-review, spend, scope |
| `/agentdeck policy …` | delegation policy |
| `/agentdeck autoreview on\|off` | post-edit review |
| `/agentdeck tooldesc on\|off` | tool-description injection |
| `/agentdeck budget [usd\|off]` | daily subagent budget |
| `/agentdeck-flow …` | auto-start, plan gate, classifier test |
| `/agentdeck-routing` | print the injected catalog |
| `/agentdeck-answer [id answer]` | supervisor requests |
| `/agentdeck-loop …` | Analyze→Fix→Validate |

Prompt templates: the app's four (`/investigate-a-bug`, `/plan-a-feature`,
`/refactor-for-clarity`, `/review-my-changes`) plus three pi-native ones
(`/explore`, `/plan`, `/review`) that delegate to the matching agent.

Skills: the app's five, plus pi-native `pi-agent-authoring`, `pi-agentdeck`
(how this package works) and `pi-mcp-setup`.

## 11. Safety, cost and hygiene

| Concern | Behaviour |
|---|---|
| Baseline integrity | `agents/`, `prompts/`, `skills/` are never edited; `verify:fidelity` proves it (12/12) |
| Overwriting your edits | `sync` writes `name.md.bak.<stamp>` first (newest 3 kept); normal startup only *heals* missing overlay keys and never overwrites a value you set |
| Spend | subagent cost is accumulated per day from completion events; notify once at 80% and 100%; at 100% automatic spawns (auto-start, auto-review) pause while explicit actions keep working |
| Runaway loops | auto-review is throttled to one per 10 min; the plan gate blocks at most twice; every automatic spawn path is interactive-mode only |
| Disk | audit JSONLs trimmed to ~2000 lines on startup; supervisor store capped at 50; loop runs capped at 5 |
| Concurrency | spend file writes are tmp+rename (the background agent runner is a second writer) |
| Auditability | every decision (classify, spawn, fallback, gate, skip, budget) is one JSONL line you can grep |

`scripts/smoke.sh` is a 10-check headless regression battery
(`npm run smoke`): fidelity, model resolution, doctor fields, catalog, classifier
positive/negative cases, budget and tool-description status.

## 12. Files this package touches

| Path | Purpose |
|---|---|
| `~/.pi/agent/agents/*.md` | seeded agents (healed, backed up on `sync`) |
| `~/.pi/agent/agent-tool-description.md` | generated Agent tool description |
| `~/.pi/agent/subagents.json` | `toolDescriptionMode: "custom"` (merged, never overwritten) |
| `~/.pi/agent/agentdeck.json` | settings: `policy`, `autoreview`, `toolRouting`, `autoSpawn`, `planGate`, `budget.dailyUsd`, `loop.*`, `supervisorTimeoutSeconds` |
| `~/.pi/agent/agentdeck-spend.json` | today's accumulated subagent cost |
| `~/.pi/agent/agentdeck-flow.jsonl` | classifier + auto-start audit |
| `~/.pi/agent/agentdeck-autoreview.jsonl` | auto-review audit |
| `~/.pi/agent/agentdeck-autoreview.lock` | throttle marker |
| `~/.pi/agent/agentdeck-supervisor-requests.json` | supervisor request/answer store |
| `~/.pi/agent/agentdeck-supervisor.jsonl` | supervisor message log |
| `~/.pi/agent/agentdeck-loop/<run>.json` | loop run artifacts |
| `<project>/.pi/agents/*.md` | project-local installs, and your own project agents |
