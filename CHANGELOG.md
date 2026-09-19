# Changelog

## 0.3.0 — pi-native glue

Everything the macOS app provided around its resources, implemented for pi.
Baseline unchanged (`verify:fidelity` still 12/12).

- **`contact_supervisor` implemented** (`extensions/supervisor.ts`): progress /
  question / blocker messages, JSONL log, pi event bus, supervisor-side
  notification. The overlay rewrites the app-only plain tool name to
  `ext:supervisor/contact_supervisor`, which also silences pi's
  "not a known built-in" warning for upstream agents.
- **Model tiers** in `models.json` (`tiers` + per-agent `tier`); `verify:models`
  now prints `$/Mtok` per pin.
- **Scope-aware seeding**: a project-local install (`pi install -l`) writes agents
  to `<project>/.pi/agents/` instead of the global directory.
- **`/route [task]`** — the app's agent library picker, in the TUI.
- **`/agentdeck`** — status, `sync`, and `doctor` (baseline hashes, runtime,
  supervisor tool, scope).
- **pi-native prompt templates** `prompts-pi/`: `/explore`, `/plan`, `/review`.
- **pi-native skills** `skills-pi/`: `pi-agent-authoring`, `pi-agentdeck`,
  `pi-mcp-setup` (upstream skills reference app-only UI).
- **CI** (`ci.yml`) and **upstream watch** (`upstream-watch.yml`) plus
  `scripts/rebaseline.mjs`.
- **`NOTICE`**, `UPSTREAM.md`, and a proposal for `agentPaths` in pi's
  `resources_discover` (`contrib/agentPaths-proposal.md`) that would remove the
  need to seed files at all.

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
