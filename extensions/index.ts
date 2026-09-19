/**
 * pi-agentdeck-agents
 *
 * Installs the bundled Agent Deck resources into pi's global agent directory so
 * a pi subagent extension can discover them in every project, on every machine.
 *
 * FIDELITY: the files under ../agents, ../prompts and ../skills are byte-identical
 * copies of the macOS Agent Deck app's bundled resources (see upstream.lock.json
 * and scripts/verify-fidelity.mjs). This extension never rewrites their content:
 * it copies them as-is, and it never overwrites a file that already exists unless
 * you explicitly run `/agentdeck-agents sync`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/** Copy bundled agents into the global agent dir. Existing files win unless force. */
function seed(force = false): { written: string[]; skipped: string[] } {
  const src = bundledAgentsDir();
  const written: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(src)) return { written, skipped };

  const dst = agentRootDir();
  mkdirSync(dst, { recursive: true });

  for (const file of readdirSync(src).filter((f) => f.endsWith(".md")).sort()) {
    const target = join(dst, file);
    if (existsSync(target) && !force) {
      skipped.push(file);
      continue;
    }
    writeFileSync(target, readFileSync(join(src, file), "utf8"), "utf8");
    written.push(file);
  }
  return { written, skipped };
}

function report(ctx: ExtensionContext, result: { written: string[]; skipped: string[] }): void {
  if (!ctx.hasUI) return;
  if (result.written.length) {
    ctx.ui.notify(`${PKG}: installed ${result.written.join(", ")} → ${agentRootDir()}`, "info");
  }
}

export default function (pi: ExtensionAPI) {
  // Seed at load time so agents exist before any session-level discovery.
  try {
    seed();
  } catch {
    /* non-fatal: a read-only FS just means no seeding */
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      report(ctx, seed());
    } catch {
      /* ignore */
    }
  });

  pi.registerCommand("agentdeck-agents", {
    description: `Show or (re)install the bundled ${PKG} agents ("sync" overwrites local copies)`,
    handler: async (args, ctx) => {
      const force = (args ?? "").trim() === "sync";
      const { written, skipped } = seed(force);
      const msg = written.length
        ? `${PKG}: wrote ${written.join(", ")} → ${agentRootDir()}`
        : `${PKG}: agents already present (${skipped.join(", ") || "none"}); run with "sync" to overwrite`;
      ctx.ui.notify(msg, "info");
    },
  });
}
