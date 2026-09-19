# Upstream tracking

This package is a **fork of content, not of behaviour**: the three resource
directories are copied verbatim from the macOS Agent Deck app so that later
changes are reviewable against something known-good.

## The rule

> `agents/`, `prompts/`, `skills/` are never edited here.

Every pi-specific need goes into a layer instead:

| Need | Where |
|---|---|
| per-agent model / thinking | `models.json` (`tiers`, `agents`) |
| map an app-only tool onto a pi implementation | `models.json` (`toolMap`) |
| new behaviour (tools, commands, surfacing) | `extensions/` |
| pi-native prompt templates / skills | `prompts-pi/`, `skills-pi/` |

## Pinned revision

`upstream.lock.json` records the upstream commit and the SHA-256 of all 12 files.
`npm run verify:fidelity` recomputes them; `npm run verify:upstream` also fetches
the live files.

## Pulling a new revision

```bash
node scripts/rebaseline.mjs            # fetch upstream main, update baseline + lock
node scripts/rebaseline.mjs --ref <sha>  # pin to a specific upstream commit
node scripts/rebaseline.mjs --check    # report drift without writing (exit 1 on drift)
```

`.github/workflows/upstream-watch.yml` runs `--check` weekly and opens a pull
request when upstream moves, so drift is a reviewable diff rather than a surprise.

After a re-baseline:

1. Read the diff — the change is upstream's, not ours.
2. Check that the overlay still applies cleanly (`/agentdeck sync` in pi, then
   confirm the installed agents have the expected `model:` and `ext:` tool).
3. Bump the version, update `CHANGELOG.md`, tag.

## Reverting to a pristine baseline

```bash
git checkout v0.1.0 -- agents prompts skills upstream.lock.json
```

`v0.1.0` is the untouched baseline; every later tag adds layers on top.
