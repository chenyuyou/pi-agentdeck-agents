# Changelog

## 0.2.0 — per-agent model pins (overlay layer)

Adds cost/intelligence tiering without touching the baseline.

- **New `models.json`** — per-agent model pins:
  - `explorer` → `opencode-go/deepseek-v4.1-flash`
  - `planner` → `opencode-go/kimi-k2.7-code`
  - `reviewer` → `opencode-go/deepseek-v4-pro`
- The seeding extension merges those keys into the agent frontmatter **as it
  installs** into `~/.pi/agent/agents/`. The bundled `agents/*.md` are still
  byte-identical to upstream, so `npm run verify:fidelity` remains 12/12.
- Thinking levels are left exactly as upstream (`low`/`high`/`high`).
- New `npm run verify:models` checks each pin resolves in the local pi catalog.

To drop a pin, remove that agent from `models.json` and run `/agentdeck-agents sync`.

## 0.1.0 — pristine baseline

Byte-identical copy of the macOS Agent Deck app's bundled resources at
`a-streetcoder/agent-deck@9efbe6c1dc2a`:

- 3 agents (`explorer`, `planner`, `reviewer`)
- 4 prompt templates
- 5 skills

Nothing added, nothing rewritten. `upstream.lock.json` records the commit and the
SHA-256 of every file; `scripts/verify-fidelity.mjs` proves the copy is identical
locally and against upstream.
