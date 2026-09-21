# Changelog

## 0.5.0 — routing rules in the Agent tool description

The v0.4.0 routing block reached the model via the system prompt. This version also
puts it where the delegation decision is actually made: the Agent tool description.

- New `extensions/tool-description.ts` generates
  `<agentDir>/agent-tool-description.md` and merges `toolDescriptionMode: "custom"`
  into `<agentDir>/subagents.json` (merge, never overwrite).
- The generated file is upstream's own default description — `{{typeList}}` and
  `{{agentDir}}` stay live — plus a `## Routing rules (Agent Deck)` section built
  from each agent's `whenToUse` and model.
- `/agentdeck tooldesc on|off`, `/agentdeck-tooldesc [sync]`; `/agentdeck doctor`
  reports `tool desc: custom (injected)`.
- Safety: backs off from `compact` or a foreign `custom` file; off restores
  `full`. The host reads the description at tool registration, so changes apply on
  the next pi session.

Verified: after one session generates the file, the next session's model can quote
`## Routing rules (Agent Deck)` from its Agent tool description verbatim.

## 0.4.0 — orchestration: routing hints + auto-review

Two behaviours the macOS app provided at its own layer. Baseline unchanged
(`verify:fidelity` still 12/12).

- **Routing hints (C)** — the app routed the parent session with each agent's
  `whenToUse`; pi's subagent runtime ignores that field entirely. It is now
  injected as a system-prompt section (`sections.agent_routing`) on every turn,
  read live from the agent directory so it never goes stale. Preview with
  `/agentdeck-routing`.
- **Auto-review (B)** — after a turn that actually changed files (`edit`/`write`),
  optionally spawn the bundled `reviewer` agent over the change set via the
  subagent runtime's cross-extension RPC. **Off by default**; toggle with
  `/agentdeck autoreview on|off`. One review per 10 minutes (configurable in
  `~/.pi/agent/agentdeck.json`); decisions are audited to
  `~/.pi/agent/agentdeck-autoreview.jsonl`.
- New extension `extensions/orchestrator.ts`; `/agentdeck` now reports the
  auto-review state.

Note: pi package manifests must list extension **files** — an `extensions/`
directory entry only loads `index.ts`.

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
