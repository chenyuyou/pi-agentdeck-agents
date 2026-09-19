---
name: pi-mcp-setup
description: Use when adding, importing, or repairing MCP servers for the Pi coding agent (pi-mcp-adapter), including config paths and verification.
---

# MCP servers for Pi

Pi talks MCP through the `pi-mcp-adapter` extension, not through a built-in tool.

## Where config lives

| Purpose | Path |
|---|---|
| Pi's MCP config | `$PI_CODING_AGENT_DIR/mcp.json` (default `~/.pi/agent/mcp.json`) |
| OAuth tokens / dynamic registration | `$PI_CODING_AGENT_DIR/mcp-auth.json` |
| Project MCP config | `.pi/mcp.json` |
| Community config (read-only) | `~/.config/mcp/mcp.json` |

## Typical flow

1. Confirm the adapter is installed: `pi list` should show `pi-mcp-adapter`.
2. Add the server to `~/.pi/agent/mcp.json` (or import from Claude Code / Codex
   config when the extension offers an import path).
3. For HTTP servers that need OAuth, authenticate through the extension's flow;
   tokens land in `mcp-auth.json`, never in `mcp.json`.
4. Restart the session (`/reload` or a new session) so tool registration refreshes.
5. Verify the server's tools appear before relying on them.

## Safety

- An MCP server runs with your permissions. Review the command and its arguments
  before adding it; do not paste unknown `npx -y` packages.
- Never commit tokens; prefer env vars referenced from the config over inline values.
