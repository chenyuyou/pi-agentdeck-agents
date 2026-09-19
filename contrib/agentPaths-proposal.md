# Proposal: let pi packages contribute agent directories

**Problem.** `resources_discover` lets an extension contribute `skillPaths`,
`promptPaths` and `themePaths`, but there is no `agentPaths`. pi packages can
therefore ship skills and prompt templates natively (`pi.skills`, `pi.prompts`)
but **cannot** ship subagent definitions without writing files into
`$PI_CODING_AGENT_DIR/agents/` on load. `pi-agentdeck-agents` does exactly that
today, which is the only reason it has to touch the filesystem.

**Proposal.** Add `agentPaths` to the `resources_discover` contract, mirroring
the existing three.

```ts
pi.on("resources_discover", async (_event, _ctx) => {
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
    agentPaths: ["/path/to/agents"], // new
  };
});
```

and a package manifest key:

```json
{ "pi": { "agents": ["./agents"] } }
```

**Sketch of the implementation** (source layout, `src/core/resource-loader.ts`):

1. Extend the `resources_discover` result type with `agentPaths?: string[]`.
2. Collect them in `ResourceLoader.reload()` next to
   `appendSystemPromptSourcePaths`, following the same path resolution
   (`~` expansion, absolutisation, dedupe).
3. Expose `getAgentSourcePaths()`.

Consumers pick it up the way the subagent extensions already resolve agents:
search project `.pi/agents`, project `.agents/agents`, then the discovered
`agentPaths`, then the global dir — so a package-provided agent is overridable
by a project-local file of the same name.

**Why it matters.**

- Removes filesystem writes at load time (the only side effect a resource pack
  needs today).
- Makes project-local installs (`pi install -l`) first-class: the agents come
  from the project package, no global pollution.
- Lets pi's `pi config` UI show and toggle agents like other resources.
- `pi-agentdeck-agents` would drop its seeder extension to a few lines: the
  overlay (model pins, tool mapping) could then be expressed as a transform in
  the loader, or shipped as agent files generated at install time.

**Compatibility.** Purely additive: extensions that do not return `agentPaths`
behave exactly as before.

**Tests to add.**

- Discovery: a package declaring `pi.agents` makes its agents available.
- Precedence: project `.pi/agents/<name>.md` overrides a package agent of the
  same name.
- Dedupe: the same directory contributed twice (and via `--extension`) loads once.
- Reload: `resources_discover` with `reason: "reload"` replaces, not duplicates.
