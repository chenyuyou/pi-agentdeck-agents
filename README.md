# pi-agentdeck-agents

The macOS **[Agent Deck](https://agentdeck.site) app's bundled resources** for
the [pi](https://pi.dev) coding agent — plus the pi-native glue the app provided
around them.

Three layers, kept deliberately separate:

| Layer | Files | Promise |
|---|---|---|
| **Baseline** | `agents/`, `prompts/`, `skills/` | **byte-identical** to upstream, never edited |
| **Overlay** | `models.json`, `extensions/` | everything pi needs that the app kept in its UI |
| **Glue** | `/route`, `/agentdeck`, supervisor bridge | pi-native equivalents of the app's UI features |

`npm run verify:fidelity` proves the baseline is untouched at any time.

## Install

```bash
# a pi subagent runtime (does the actual delegation)
pi install npm:@tintinweb/pi-subagents

# this bundle
pi install npm:pi-agentdeck-agents
```

Project-local instead of global (agents land in `<project>/.pi/agents/`):

```bash
pi install -l npm:pi-agentdeck-agents
```

Restart pi afterwards; `/agentdeck doctor` checks the setup.

## What you get

| Kind | Items | How to use |
|---|---|---|
| Agents | `explorer`, `planner`, `reviewer` | `Agent(subagent_type: "explorer", …)`, `@explorer`, or `/route` |
| Prompts (upstream) | `investigate-a-bug`, `plan-a-feature`, `refactor-for-clarity`, `review-my-changes` | `/investigate-a-bug <symptom>` … |
| Prompts (pi-native) | `explore`, `plan`, `review` | `/explore <area>`, `/plan <feature>`, `/review [focus]` |
| Skills (upstream) | `agent-authoring`, `loop-authoring`, `mcp-install-helper`, `prompt-authoring`, `skill-authoring` | loaded on demand |
| Skills (pi-native) | `pi-agent-authoring`, `pi-agentdeck`, `pi-mcp-setup` | loaded on demand |

## Commands

| Command | What it does |
|---|---|
| `/route [task]` | pick a bundled agent (shows its model) and delegate a task to it |
| `/agentdeck` | list agents, their models and `whenToUse` |
| `/agentdeck sync` | re-install the agents from baseline + overlay |
| `/agentdeck doctor` | agents dir, baseline hash status, runtime presence, supervisor tool, scope, auto-review state |
| `/agentdeck autoreview on\|off` | turn the automatic post-edit review on or off |
| `/agentdeck tooldesc on\|off` | inject (or stop injecting) the routing rules into the Agent tool description |
| `/agentdeck-routing` | print the routing block injected into the system prompt |
| `/agentdeck-tooldesc sync` | regenerate the Agent tool description now |

## Orchestration

Meshed with how the macOS app actually does it (source: `AppViewModel.nativeSubagentCatalogPrompt`,
`AppSettings.NativeSubagentDelegationPolicy`, `agent-deck-documentation/*`).

### The parent catalog (what the model is told)

The app appends an **agent catalog** to the parent prompt. This package injects the
same content in two places — the system prompt (each turn, v0.4.0) and the Agent
tool description (v0.5.0):

```text
Agent Deck orchestration (parent session):
- Delegation happens only through the Agent tool (`subagent_type`); it is not automatic — if you do not call it, nothing is delegated.
<delegation policy bullets>
- Fresh agents cannot see this conversation … every delegation must be self-contained.
- If you delegate planning to `planner`, convert its returned plan into your own working plan before implementing …
- Trust but verify: an agent's summary describes intent, not outcome.

Available agents (policy: balanced):
- explorer: <whenToUse> [outcome: reportOnly; tools: read, grep, find, ls, bash, contact_supervisor]
- planner:  …
- reviewer: …
```

That `- name: whenToUse [outcome; tools]` line shape is the app's own format.

### Delegation policy

The app's real "when do agents start" knob is a prompt policy, not a scheduler:

| Policy | Meaning |
|---|---|
| `light` | delegate when it clearly improves the result; the parent may work directly |
| `balanced` *(default)* | delegate substantive implementation/investigation/planning/review; only trivial low-risk changes stay in the parent |
| `strict` | delegate anything substantive; the parent orchestrates and synthesizes |

```
/agentdeck policy light|balanced|strict
```

### Beyond the app (opt-in extras)

Two additions the app does not have, both **off by default**:

- `/agentdeck-flow on|off` — heuristically classify each new task and **start the
  agent immediately** (explore / plan / review) instead of waiting for the model to
  decide. Deterministic, auditable in `~/.pi/agent/agentdeck-flow.jsonl`; child
  sessions and one-shot runs are skipped so it can never recurse.
- `/agentdeck-flow gate on|off` — block the first `edit`/`write` of a non-trivial
  task until a `planner` run exists (max 2 blocks, never deadlocks).

### Tool description injection

The same rules are also written into the **Agent tool description** itself — the
place the model reads when deciding whether to delegate at all — through the
runtime's supported extension point (`toolDescriptionMode: "custom"` plus
`<agentDir>/agent-tool-description.md`).

```
## Agent Deck orchestration

Delegation happens only through this tool (`subagent_type`). It is not automatic — if you do not call it, nothing is delegated.

- Act primarily as the orchestrator: clarify, plan, delegate, supervise, and synthesize results.
- Delegate substantive implementation, investigation, planning, or review work to a relevant agent by default; …

Choose by role (policy: balanced):

- `explorer`: <whenToUse> [outcome: reportOnly; tools: read, grep, find, ls, bash, contact_supervisor]
- `planner`: …
- `reviewer`: …
```

The generated file is upstream's **own** default description (keeping `{{typeList}}`
and `{{agentDir}}` live, so the agent list never goes stale) plus the routing
section. `subagents.json` is merged, never overwritten.

Limits and safety:

- The host reads the description **once, at tool registration** → changes apply on
  the next pi session. `/agentdeck-tooldesc` reports file, mode and whether it wrote.
- If `toolDescriptionMode` is `compact`, or `custom` with a file that is not ours,
  the extension **backs off** and leaves your choice alone.
- Turn it off with `/agentdeck tooldesc off` (restores `toolDescriptionMode: "full"`;
  the file is kept but ignored).
- Base template resolution: the installed runtime's own
  `examples/agent-tool-description.md` when present, else the copy vendored in
  `templates/`.

### Auto-review

After a turn that actually changed files, optionally spawn the bundled `reviewer`
agent over the change set:

```
/agentdeck autoreview on      # default is OFF
```

It spawns through the subagent runtime's cross-extension RPC (no extra model turn
in the parent) and reports through the normal completion path.

Guards, so this cannot run away:

- **Interactive sessions only** (`tui` / `rpc`). One-shot runs (`pi -p`) skip it —
  a background agent completing after shutdown would emit on a disposed event
  bus. Spawned child sessions report a non-interactive mode too, so a subagent's
  own edits never trigger a nested review.
- **One review per 10 minutes** (`autoreviewTtlMinutes` in `~/.pi/agent/agentdeck.json`).
- **Failed edits are ignored** — the file is recorded from `tool_execution_start`
  and rolled back if the tool errors.
- Every decision is appended to `~/.pi/agent/agentdeck-autoreview.jsonl`
  (`edit`, `spawn`, `spawn-reply`, `skipped`, …), so the behaviour is auditable.

## Supervisor bridge (`contact_supervisor`)

Upstream agents list `contact_supervisor` in `tools:` and their prompts say "ask
the supervisor one focused question". The macOS app ships a bridge extension for
it; **pi had no such tool**. `extensions/supervisor.ts` implements it:

- the child emits a `progress` / `question` / `blocker` message,
- it is appended to `$PI_CODING_AGENT_DIR/agentdeck-supervisor.jsonl` and emitted
  on pi's shared event bus,
- the supervising session shows a notification and records an entry.

Non-blocking by design: the child continues with its best judgement. The overlay
rewrites the app-only plain tool name to pi's selector —

```
tools: read, grep, find, ls, bash, contact_supervisor      # upstream (plain name: a pi typo)
tools: read, grep, find, ls, bash, ext:supervisor/contact_supervisor   # installed
```

— which is also what removes the `tools-error: ... is not a known built-in`
warning upstream agents would otherwise produce.

## Model tiers

`models.json` supplies the per-agent models the app keeps in its Models UI:

| Agent | Tier | Model |
|---|---|---|
| `explorer` | `cheap` | `opencode-go/deepseek-v4.1-flash` |
| `reviewer` | `balanced` | `opencode-go/deepseek-v4-pro` |
| `planner` | `genius` | `opencode-go/kimi-k2.7-code` |

Thinking levels stay exactly as upstream. Edit `models.json` (a `model` or a
`tier`, plus optional `thinking` / `toolsAppend`), then `/agentdeck sync`.
`npm run verify:models` prints each pin and its `$/Mtok`.

## Verify

```bash
npm run verify:fidelity   # baseline vs the locked sha256 (12/12)
npm run verify:upstream   # baseline vs the live upstream files
npm run verify:models     # every pin resolves locally, with cost
npm run rebaseline        # pull a new upstream revision into the baseline
```

## Upstream tracking

`upstream.lock.json` pins the upstream commit and hashes every baseline file.
`.github/workflows/upstream-watch.yml` checks weekly and opens a PR when upstream
moves; `scripts/rebaseline.mjs` does the same locally. See [`UPSTREAM.md`](./UPSTREAM.md).

## What is *not* the macOS app

The app is a SwiftUI application: agent library UI, Models view, worktrees, issue
board, memory and MCP screens are not portable. This bundle carries the resources
plus pi-native equivalents (routing, supervisor bridge, model overlay). See
[`NOTICE`](./NOTICE) for attribution.

## Versioning

| Version | Layer |
|---|---|
| `v0.1.0` | pristine baseline (byte-identical upstream) |
| `v0.2.0` | per-agent model pins |
| `v0.3.0` | supervisor bridge, tool mapping, tiers, `/route`, `/agentdeck`, pi-native prompts & skills, CI + upstream watch |
| `v0.4.0` | orchestration: `whenToUse` routing hints + optional auto-review after edits |
| `v0.5.0` | routing rules injected into the Agent tool description (`toolDescriptionMode: custom`) |
| `v0.6.0` | macOS-aligned parent catalog + `light`/`balanced`/`strict` delegation policy; opt-in task-adaptive auto-start and plan gate |

## License

MIT. Bundled resources are MIT, from the Agent Deck project (see `NOTICE`).
