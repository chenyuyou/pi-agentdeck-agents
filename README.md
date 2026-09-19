# pi-agentdeck-agents

A tiny [pi](https://pi.dev) package that installs the **Agent Deck style agent
library** — `explorer`, `planner`, `reviewer` — into pi's global agent
directory, so every project and every machine gets the same specialist agents,
**each with its own model, thinking level, system prompt and tool set**.

These are the same Markdown + YAML frontmatter agent files used by the macOS
[Agent Deck](https://agentdeck.site) app and by the pi subagent extensions
([`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents),
[`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents),
[`pi-subagents`](https://www.npmjs.com/package/pi-subagents)).

## Install

Install a pi subagent runtime that discovers agents from `~/.pi/agent/agents/`,
then this package:

```bash
# 1. runtime (does the actual delegation)
pi install npm:@tintinweb/pi-subagents

# 2. this agent library
pi install git:github.com/<YOUR-GH-USER>/pi-agentdeck-agents
```

Then restart pi, or run `/agentdeck-agents sync` inside pi.

That's it — in any project:

```text
Use explorer to map this codebase before we plan.
Ask planner for an implementation plan.
Run reviewer on my diff.
```

or browse them in `/agents`.

## Agents

| Agent | Model | Thinking | Tools | Role |
|---|---|---|---|---|
| `explorer` | `opencode-go/deepseek-v4.1-flash` | low | read, grep, find, ls, bash | fast read-only codebase recon |
| `planner` | `opencode-go/kimi-k2.7-code` | max | read, grep, find, ls, bash | implementation approach / trade-offs |
| `reviewer` | `opencode-go/deepseek-v4-pro` | high | read, grep, find, ls, bash | evidence-backed review |

Models are deliberately tiered by cost vs. intelligence. Edit the `model:` /
`thinking:` lines in your agent files to taste.

## What the extension does

On load (and on every `session_start`) it copies the bundled `agents/*.md` into
`$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`):

- a file that does **not** exist → created
- a file carrying `managed_by: pi-agentdeck-agents` → refreshed when the package updates
- a file you wrote yourself (no marker) → **left untouched**
- `/agentdeck-agents sync` → overwrite everything, including local edits

Nothing else is registered: the actual subagent tools and UI come from the
runtime extension you installed in step 1.

## Per-agent model resolution

The subagent runtime reads `model:`/`thinking:` from each agent file. To change
a model, edit the file (or, if you also use the `piagents` CLI, run
`piagents tier planner cheap && piagents sync`).

## Files

```
extensions/index.ts      seeding extension (no runtime dependencies)
agents/explorer.md
agents/planner.md
agents/reviewer.md
```

## License

MIT
