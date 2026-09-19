---
name: pi-agent-authoring
description: Use when creating or editing Pi subagent definitions (agent markdown files) — frontmatter fields, tool scoping, model pins, and where the files live.
---

# Authoring Pi subagents

A subagent is a Markdown file with YAML frontmatter; the body is its system prompt.
The subagent runtime discovers them in:

| Scope | Path |
|---|---|
| Project (wins) | `.pi/agents/<name>.md` |
| Project (shared) | `.agents/agents/<name>.md` |
| Global | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) |

## Frontmatter that matters

| Field | Notes |
|---|---|
| `name` | the `subagent_type` / `@handle`; falls back to the filename |
| `description` | shown in tool listing and `/agents` |
| `model` | `provider/modelId` or a fuzzy name; omit to inherit the parent |
| `thinking` | `off`…`max`; pi clamps unsupported levels down |
| `tools` | built-in names only (`read, bash, edit, write, grep, find, ls`), `*`/`all`, `none`, or `ext:<extension>` / `ext:<extension>/<tool>` |
| `disallowed_tools` | denylist applied after `tools` |
| `prompt_mode` | `replace` (standalone prompt) or `append` (parent twin) |
| `max_turns` | graceful stop after N agentic turns |
| `isolation` | `worktree` for an isolated git worktree |
| `allowed_subagents` | opt in to nested delegation |

## Gotcha: extension tools are not plain names

A plain name in `tools:` is matched against **built-ins only**. An unknown plain
name is reported as a typo. To give an agent a tool provided by an extension, use
the extension selector, e.g.:

```yaml
tools: read, grep, find, ls, bash, ext:supervisor/contact_supervisor
```

`ext:<name>` allows every tool of that extension; `ext:<name>/<tool>` narrows to one.
The extension name is its file's canonical name (`extensions/supervisor.ts` → `supervisor`)
or the pi package's short name.

## Authoring checklist

1. One clear job per agent; say what it must **not** do.
2. Restrict tools to the minimum (`read, grep, find, ls, bash` for analysis roles).
3. Pin a `model`/`thinking` only when the role justifies the cost.
4. Keep the body compact; it is the whole system prompt under `prompt_mode: replace`.
5. Verify with `/agents` after saving.
