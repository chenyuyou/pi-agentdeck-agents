# pi-agentdeck-agents

The **macOS [Agent Deck](https://agentdeck.site) app's bundled resources**,
packaged for [pi](https://pi.dev).

Two cleanly separated layers:

- **Baseline (v0.1.0)** — the 12 bundled files are **byte-for-byte identical** to
  upstream. Nothing added, nothing rewritten. Verified by hash.
- **Overlay (v0.2.0)** — per-agent **model pins** in a separate `models.json`,
  merged into the agent frontmatter only at install time. The baseline files stay
  pristine.

## Install

```bash
# 1. a pi subagent runtime (does the actual delegation)
pi install npm:@tintinweb/pi-subagents

# 2. this bundle
pi install npm:pi-agentdeck-agents
```

Then restart pi (the extension copies the agents into
`$PI_CODING_AGENT_DIR/agents/`, default `~/.pi/agent/agents/`).

## What's inside

| Kind | Files | How pi uses it |
|---|---|---|
| Agents | `explorer.md`, `planner.md`, `reviewer.md` | copied to `~/.pi/agent/agents/` (+ model pin); discovered by the subagent runtime |
| Prompts | `investigate-a-bug`, `plan-a-feature`, `refactor-for-clarity`, `review-my-changes` | `pi.prompts` → `/investigate-a-bug` etc. |
| Skills | `agent-authoring`, `loop-authoring`, `mcp-install-helper`, `prompt-authoring`, `skill-authoring` | `pi.skills` → `/skill:<name>` |
| Overlay | `models.json` | per-agent model pins applied on install |

Source: `a-streetcoder/agent-deck` → `agent-deck/bundled-agents`,
`agent-deck/bundled-prompts`, `agent-deck/bundled-skills`, pinned in
[`upstream.lock.json`](./upstream.lock.json).

## Verify

```bash
npm run verify:fidelity   # local baseline files vs the locked sha256 hashes
npm run verify:upstream   # also re-downloads upstream and compares
npm run verify:models     # every pin resolves in your local pi model catalog
```

`upstream.lock.json` records the exact upstream commit and the SHA-256 of every
file, so "is the baseline identical?" is a command, not a claim. The overlay is a
separate file, so it never muddies that check.

## Model pins (v0.2.0 overlay)

The macOS app keeps per-agent models in its own Models UI, so the upstream agent
files carry **no `model:` field**. The overlay supplies them:

| Agent | Pinned model | Upstream thinking |
|---|---|---|
| `explorer` | `opencode-go/deepseek-v4.1-flash` | low |
| `planner` | `opencode-go/kimi-k2.7-code` | high |
| `reviewer` | `opencode-go/deepseek-v4-pro` | high |

Edit `models.json` to taste (`model` and optionally `thinking`), then
`/agentdeck-agents sync` to re-install. Remove an agent from `models.json` to let
it inherit the parent session's model.

## Baseline semantics (important)

- Frontmatter keys that only the macOS app understands (`whenToUse`,
  `systemPromptMode`, `defaultExpectedOutcome`, `defaultReads`, `defaultProgress`)
  are preserved verbatim. pi's subagent extensions ignore unknown keys;
  `systemPromptMode: replace` matches their default `replace`.
- `tools:` includes `contact_supervisor`, which only exists inside the macOS app.
  pi has no such tool; the other tools in the list are unaffected.
- The seeding extension never edits baseline content. It applies the overlay while
  writing to `~/.pi/agent/agents/`; a file that already exists on disk is left
  alone unless `/agentdeck-agents sync` is used.

## What is *not* the same as the macOS app

Only the packaging is ours: `package.json`, `extensions/index.ts`, `models.json`,
`scripts/`, `README.md`. The macOS app is a SwiftUI application — its agent
library UI, Models view, worktrees, issue board, memory and MCP screens are not
part of this bundle and are not portable to pi.

## Versioning

The baseline never changes; every update is a new layer on top of it.

| Version | Layer |
|---|---|
| `v0.1.0` | pristine baseline (byte-identical upstream) |
| `v0.2.0` | `models.json` per-agent model pins |
| next | add whatever you need — keep `agents/`/`prompts/`/`skills/` untouched |

## Files

```
agents/{explorer,planner,reviewer}.md            pristine
prompts/{investigate-a-bug,plan-a-feature,
         refactor-for-clarity,
         review-my-changes}.md                   pristine
skills/{agent-authoring,loop-authoring,
        mcp-install-helper,prompt-authoring,
        skill-authoring}/SKILL.md                pristine
models.json                                      overlay: model pins
extensions/index.ts                              seeder (baseline + overlay)
scripts/verify-fidelity.mjs                      hash checker
scripts/verify-models.mjs                        pin checker
upstream.lock.json                               upstream commit + sha256
CHANGELOG.md
```

## License

MIT (the bundled resources come from the MIT-licensed Agent Deck app).
