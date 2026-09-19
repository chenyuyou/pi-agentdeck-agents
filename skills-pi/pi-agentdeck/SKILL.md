---
name: pi-agentdeck
description: Use when working on the pi-agentdeck-agents package itself — baseline vs overlay layers, fidelity verification, and how to add a version.
---

# pi-agentdeck-agents internals

The package has three layers. Keep them separate; that is what makes "is this the
same as upstream?" answerable.

| Layer | Files | Rule |
|---|---|---|
| Baseline | `agents/`, `prompts/`, `skills/` | **never edit** — byte-identical to the macOS Agent Deck app at the commit in `upstream.lock.json` |
| Overlay | `models.json`, `extensions/` | everything pi needs that the app kept in its own UI |
| Verification | `scripts/verify-fidelity.mjs`, `scripts/verify-models.mjs`, `upstream.lock.json` | proves the baseline is untouched |

## Commands

```bash
npm run verify:fidelity   # baseline vs locked sha256
npm run verify:upstream   # baseline vs the live upstream files
npm run verify:models     # every model pin resolves locally
node scripts/rebaseline.mjs            # pull a new upstream revision into the baseline
node scripts/rebaseline.mjs --check    # report drift without writing
```

## Adding a version

1. Never edit `agents/`, `prompts/`, `skills/`.
2. Put changes in `models.json` (models/tiers/tool mapping) or a new extension.
3. Bump `version`, add a `CHANGELOG.md` entry, tag `vX.Y.Z`.
4. `verify:fidelity` must still pass.

## Installing into a project

`pi install -l <source>` puts the package under `<project>/.pi/...`; the seeder
detects that and writes agents to `<project>/.pi/agents/` instead of globally.
