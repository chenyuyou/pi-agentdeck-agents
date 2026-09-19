/**
 * pi-agentdeck-agents
 *
 * Installs the bundled Agent Deck style agents (explorer / planner / reviewer)
 * into pi's global agent directory so a pi subagent extension can discover them
 * in every project, on every machine.
 *
 * The files are the same Markdown + YAML frontmatter format used by the macOS
 * Agent Deck app and by @tintinweb/pi-subagents / @gotgenes/pi-subagents.
 *
 * Seeding rules:
 *   - never touched: a file that exists and was not created by this package
 *   - updated:       a file carrying our marker comment (safe to refresh)
 *   - forced:        `pi` command `/agentdeck-agents sync` (overwrites either way)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MARKER = "managed_by: pi-agentdeck-agents";
const PKG = "pi-agentdeck-agents";

function agentRootDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const base = configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
  return join(base, "agents");
}

function bundledAgentsDir(): string {
  // extensions/index.ts -> ../agents
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

/** Copy bundled agents into the global agent dir. Returns the files written. */
function seed(force = false): string[] {
  const src = bundledAgentsDir();
  if (!existsSync(src)) return [];
  const dst = agentRootDir();
  mkdirSync(dst, { recursive: true });

  const written: string[] = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".md")).sort()) {
    const source = readFileSync(join(src, file), "utf8");
    const target = join(dst, file);
    if (!existsSync(target)) {
      writeFileSync(target, source, "utf8");
      written.push(file);
      continue;
    }
    const current = readFileSync(target, "utf8");
    if (current === source) continue;
    // Only refresh files this package owns, unless forced.
    if (force || current.includes(MARKER)) {
      writeFileSync(target, source, "utf8");
      written.push(file);
    }
  }
  return written;
}

function report(ctx: ExtensionContext, written: string[], force: boolean): void {
  if (!written.length) return;
  if (!ctx.hasUI) return;
  ctx.ui.notify(`${PKG}: ${force ? "installed" : "updated"} ${written.join(", ")} → ${agentRootDir()}`, "info");
}

export default function (pi: ExtensionAPI) {
  // Seed at load time so the agents exist before any session-level discovery.
  try {
    seed();
  } catch {
    /* non-fatal: a read-only FS just means no seeding */
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      report(ctx, seed(), false);
    } catch {
      /* ignore */
    }
  });

  pi.registerCommand("agentdeck-agents", {
    description: `Reinstall the bundled ${PKG} agent files (use "sync" to overwrite local edits)`,
    handler: async (args, ctx) => {
      const force = (args ?? "").trim() === "sync";
      const written = seed(force);
      ctx.ui.notify(
        written.length
          ? `${PKG}: wrote ${written.join(", ")} → ${agentRootDir()}`
          : `${PKG}: agents already up to date`,
        "info",
      );
    },
  });
}
