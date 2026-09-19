/**
 * pi-agentdeck-agents
 *
 * Installs the bundled Agent Deck resources into pi's global agent directory so
 * a pi subagent extension can discover them in every project, on every machine.
 *
 * Two layers, deliberately separated:
 *
 *  1. BASELINE (v0.1.0) — agents/, prompts/, skills/ are byte-identical copies of
 *     the macOS Agent Deck app's bundled resources. They are never edited here;
 *     see upstream.lock.json and scripts/verify-fidelity.mjs.
 *
 *  2. OVERLAY (v0.2.0) — models.json holds per-agent model pins (the macOS app
 *     keeps those in its own Models UI, so upstream files have none). The overlay
 *     is merged into the agent frontmatter only as the file is installed into
 *     $PI_CODING_AGENT_DIR/agents/ — never written back into agents/.
 *
 * An agent file that already exists on disk is left alone unless you run
 * `/agentdeck-agents sync`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type AgentOverlay = { model?: string; thinking?: string };
type Overlay = { agents?: Record<string, AgentOverlay> };

function agentRootDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const base = configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
  return join(base, "agents");
}

function loadOverlay(): Overlay {
  try {
    return JSON.parse(readFileSync(join(ROOT, "models.json"), "utf8")) as Overlay;
  } catch {
    return {};
  }
}

/**
 * Merge overlay keys into a Markdown file's YAML frontmatter, replacing any
 * existing key of the same name and leaving the body untouched.
 */
function applyOverlay(content: string, overlay: AgentOverlay | undefined): string {
  const keys = (["model", "thinking"] as const).filter((k) => overlay?.[k]);
  if (!overlay || keys.length === 0) return content;

  const text = content.replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return content;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) return content;

  const wanted = new Set<string>(keys);
  const front = lines.slice(1, end).filter((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    return !(m && wanted.has(m[1]));
  });
  const additions = keys.map((k) => `${k}: ${overlay[k]}`);
  return ["---", ...front, ...additions, ...lines.slice(end)].join("\n");
}

/** Copy bundled agents into the global agent dir, applying the model overlay. */
function seed(force = false): { written: string[]; skipped: string[] } {
  const src = join(ROOT, "agents");
  const written: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(src)) return { written, skipped };

  const dst = agentRootDir();
  mkdirSync(dst, { recursive: true });
  const overlay = loadOverlay();

  for (const file of readdirSync(src).filter((f) => f.endsWith(".md")).sort()) {
    const target = join(dst, file);
    if (existsSync(target) && !force) {
      skipped.push(file);
      continue;
    }
    const name = file.replace(/\.md$/, "");
    const content = applyOverlay(readFileSync(join(src, file), "utf8"), overlay.agents?.[name]);
    writeFileSync(target, content, "utf8");
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
