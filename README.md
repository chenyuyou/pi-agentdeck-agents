# pi-agentdeck-agents

The **macOS [Agent Deck](https://agentdeck.site) app's bundled resources**,
packaged for [pi](https://pi.dev) — and **byte-for-byte identical** to upstream.

`v0.1.0` is the pristine baseline: nothing added, nothing rewritten. It exists so
later versions can be diffed against something known-good.

## Install

```bash
# 1. a pi subagent runtime (does the actual delegation)
pi install npm:@tintinweb/pi-subagents

# 2. this bundle
pi install npm:pi-agentdeck-agents
```

Then restart pi (the extension copies the agents into
`$PI_CODING_AGENT_DIR/agents/`, default `~/.pi/agent/agents/`).

## What's inside — 12 files, all upstream-identical

| Kind | Files | How pi uses it |
|---|---|---|
| Agents | `explorer.md`, `planner.md`, `reviewer.md` | copied to `~/.pi/agent/agents/`; discovered by the subagent runtime |
| Prompts | `investigate-a-bug`, `plan-a-feature`, `refactor-for-clarity`, `review-my-changes` | `pi.prompts` → `/investigate-a-bug` etc. |
| Skills | `agent-authoring`, `loop-authoring`, `mcp-install-helper`, `prompt-authoring`, `skill-authoring` | `pi.skills` → `/skill:<name>` |

Source: `a-streetcoder/agent-deck` → `agent-deck/bundled-agents`,
`agent-deck/bundled-prompts`, `agent-deck/bundled-skills`, pinned in
[`upstream.lock.json`](./upstream.lock.json).

## Verify the copy

```bash
npm run verify:fidelity    # local files vs the locked sha256 hashes
npm run verify:upstream    # also re-downloads upstream and compares
```

`upstream.lock.json` records the exact upstream commit and the SHA-256 of every
file, so "is it identical?" is a command, not a claim.

The library hashes all 12 files at commit `9efbe6c1dc2a` (2026).

## Baseline semantics (important)

- Agents carry **no `model:` field**. The macOS app keeps per-agent models in its
  own Models UI, not in the files — so upstream files have none, and neither does
  this baseline. Subagents therefore inherit the parent session's model.
- Frontmatter keys that only the macOS app understands (`whenToUse`,
  `systemPromptMode`, `defaultExpectedOutcome`, `defaultReads`,
  `defaultProgress`) are preserved verbatim. pi's subagent extensions ignore
  unknown keys; `systemPromptMode: replace` matches their default `replace`.
- `tools:` includes `contact_supervisor`, which only exists inside the macOS app.
  pi simply has no such tool; the other tools in the list are unaffected.
- The extension that seeds the agents never edits their content. Files that
  already exist on disk are left alone; `/agentdeck-agents sync` overwrites them
  from the pristine bundle.

## What is *not* the same as the macOS app

Only the packaging is ours: `package.json`, `extensions/index.ts`, `README.md`,
`scripts/`. The macOS app is a SwiftUI application — its agent library UI, Models
view, worktrees, issue board, memory and MCP screens are not part of this bundle
and are not portable to pi.

## Building on the baseline

Keep `agents/`, `prompts/` and `skills/` untouched, and add your changes as a new
version layer (bump `version`, tag, publish). That way
`npm run verify:fidelity` keeps proving the base is clean, and any diff against
upstream is a deliberate, reviewable change rather than drift.

## Files

```
agents/{explorer,planner,reviewer}.md            pristine
prompts/{investigate-a-bug,plan-a-feature,
         refactor-for-clarity,
         review-my-changes}.md                   pristine
skills/{agent-authoring,loop-authoring,
        mcp-install-helper,prompt-authoring,
        skill-authoring}/SKILL.md                pristine
extensions/index.ts                              seeder (no runtime deps)
scripts/verify-fidelity.mjs                      hash checker
upstream.lock.json                               upstream commit + sha256
```

## License

MIT (the bundled resources come from the MIT-licensed Agent Deck app).
