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

Via npm (the official pi-package flow):

```bash
# 1. runtime (does the actual delegation)
pi install npm:@tintinweb/pi-subagents

# 2. this agent library
pi install npm:pi-agentdeck-agents
```

Or straight from GitHub (source, pinnable to a tag):

```bash
pi install git:github.com/YOUR-GH-USER/pi-agentdeck-agents@v0.1.0
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
| `planner` | `opencode-go/kimi-k2.7-code` | high | read, grep, find, ls, bash | implementation approach / trade-offs |
| `reviewer` | `opencode-go/deepseek-v4-pro` | high | read, grep, find, ls, bash | evidence-backed review |

Models are deliberately tiered by cost vs. intelligence. Edit the `model:` line
in your agent files to taste.

## Prompt templates

The macOS app's bundled prompts, byte-identical, available as `/name`:

| Prompt | Argument | Purpose |
|---|---|---|
| `/investigate-a-bug` | `<symptom>` | reproduce → isolate → root-cause, no fix yet |
| `/plan-a-feature` | `<feature>` | end-to-end plan before code |
| `/refactor-for-clarity` | `<file or area>` | behaviour-preserving refactor plan |
| `/review-my-changes` | `[focus]` | self-review staged + unstaged diff |

## Skills

The macOS app's bundled skills, byte-identical:

| Skill | Purpose |
|---|---|
| `agent-authoring` | create/review Agent Deck agents |
| `loop-authoring` | create/refine Agent Deck loops |
| `mcp-install-helper` | install/import/repair MCP servers |
| `prompt-authoring` | reusable slash prompt templates |
| `skill-authoring` | create/validate skills |

## Fidelity to the macOS app

The `agents/`, `prompts/` and `skills/` files are **copies of the macOS app's
`bundled-agents/`, `bundled-prompts/` and `bundled-skills/`** — same bodies,
same prompt text, same skill instructions. The agent **bodies are byte-identical**
to upstream.

Two deliberate, documented kinds of change are applied to the agent frontmatter
only:

1. **Additions** the pi runtime needs and the macOS app keeps outside the file
   (it stores per-agent models in its own Models view):
   `model`, `color`, `icon`, `max_turns`, `prompt_mode`, `disallowed_tools`.
2. **One removal-for-portability**: `contact_supervisor` stays listed in the
   original `tools:` (kept verbatim) but is additionally placed in
   `disallowed_tools`, because that tool only exists inside the macOS app.

Everything else — `whenToUse`, `systemPromptMode`, `defaultExpectedOutcome`,
`defaultReads`, `defaultProgress`, `tools`, `thinking`, and the full body — is
kept exactly as upstream.

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
extensions/index.ts                 seeding extension (no runtime dependencies)
agents/{explorer,planner,reviewer}.md
prompts/{investigate-a-bug,plan-a-feature,refactor-for-clarity,review-my-changes}.md
skills/{agent-authoring,loop-authoring,mcp-install-helper,prompt-authoring,skill-authoring}/SKILL.md
```

The extension seeds the agents; `prompts/` and `skills/` are declared in
`package.json` (`pi.prompts`, `pi.skills`) so pi loads them straight from the
package — nothing to copy.

## License

MIT
