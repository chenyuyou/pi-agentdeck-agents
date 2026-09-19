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
| `/agentdeck doctor` | agents dir, baseline hash status, runtime presence, supervisor tool, scope |

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

## License

MIT. Bundled resources are MIT, from the Agent Deck project (see `NOTICE`).
