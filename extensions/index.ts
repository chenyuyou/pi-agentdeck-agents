/**
 * pi-agentdeck-agents
 *
 * Installs the bundled Agent Deck resources into pi and adds the pi-native glue
 * the macOS app provided around them.
 *
 * LAYERS (kept separate on purpose):
 *   1. BASELINE  — agents/, prompts/, skills/ are byte-identical copies of the
 *                  macOS Agent Deck app's bundled resources (upstream.lock.json,
 *                  scripts/verify-fidelity.mjs).
 *   2. OVERLAY   — models.json supplies what the app keeps in its own UI:
 *                  per-agent model tiers and the mapping of the app-only
 *                  `contact_supervisor` tool onto this package's implementation.
 *                  Applied only as files are installed into the agent dir.
 *   3. GLUE      — this file: scope-aware seeding, supervisor surfacing on pi's
 *                  event bus, `/agentdeck` (status|sync|doctor), `/route`.
 *
 * Baseline content is never rewritten.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR_EVENT = "agentdeck:supervisor";
const SUPERVISOR_TOOL = "contact_supervisor";
const TOOL_MAP_MAX_PASSES = 4;

type AgentOverlay = { model?: string; thinking?: string; tier?: string; toolsAppend?: string[] };
type Overlay = {
  tiers?: Record<string, { model?: string; thinking?: string }>;
  toolMap?: Record<string, string>;
  toolAppend?: string[];
  agents?: Record<string, AgentOverlay>;
};

function agentBaseDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

/**
 * Project-local installs (`pi install -l`, i.e. this package lives under
 * `<project>/.pi/{npm,git}/...`) seed into the project's own agent dir instead of
 * touching the global one.
 */
function projectRootFromPackage(): string | undefined {
  const marker = `${sep}${CONFIG_DIR_NAME}${sep}`;
  const i = ROOT.indexOf(marker);
  if (i === -1) return undefined;
  const after = ROOT.slice(i + marker.length);
  if (after.startsWith(`npm${sep}`) || after.startsWith(`git${sep}`)) return ROOT.slice(0, i);
  return undefined;
}

function agentRootDir(): string {
  const project = projectRootFromPackage();
  if (project) return join(project, CONFIG_DIR_NAME, "agents");
  return join(agentBaseDir(), "agents");
}

function loadOverlay(): Overlay {
  try {
    return JSON.parse(readFileSync(join(ROOT, "models.json"), "utf8")) as Overlay;
  } catch {
    return {};
  }
}

function resolveModel(name: string, agent: AgentOverlay, overlay: Overlay): string | undefined {
  if (agent.model) return agent.model;
  const tier = agent.tier ? overlay.tiers?.[agent.tier] : undefined;
  return tier?.model;
}

/** Rewrite plain app-only tool names to their pi `ext:` selector, then append extras. */
function mapTools(line: string, overlay: Overlay, agent: AgentOverlay): string {
  let value = line.replace(/^[^:]*:\s*/, "");
  const map = overlay.toolMap ?? {};
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of parts) {
    // Repeat passes so chains (a->b->c) resolve, with a hard cap.
    let next = token;
    for (let i = 0; i < TOOL_MAP_MAX_PASSES && map[next]; i++) next = map[next];
    if (!seen.has(next)) {
      seen.add(next);
      out.push(next);
    }
  }
  for (const extra of [...(overlay.toolAppend ?? []), ...(agent.toolsAppend ?? [])]) {
    if (!seen.has(extra)) {
      seen.add(extra);
      out.push(extra);
    }
  }
  return `tools: ${out.join(", ")}`;
}

/**
 * Merge overlay keys into a Markdown file's YAML frontmatter, replacing existing
 * keys of the same name and leaving the body untouched.
 */
function applyOverlay(content: string, name: string, overlay: Overlay): string {
  const agent = overlay.agents?.[name] ?? {};
  const model = resolveModel(name, agent, overlay);
  const replacements: Record<string, string> = {};
  if (model) replacements.model = model;
  if (agent.thinking) replacements.thinking = agent.thinking;
  const wantsTools = Object.keys(overlay.toolMap ?? {}).length > 0 || (overlay.toolAppend ?? []).length > 0;

  if (!Object.keys(replacements).length && !wantsTools) return content;

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

  const front: string[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    const key = m?.[1];
    if (key === "tools" && wantsTools) {
      if (!seen.has("tools")) {
        front.push(mapTools(line, overlay, agent));
        seen.add("tools");
      }
      continue;
    }
    if (key && key in replacements) {
      if (!seen.has(key)) {
        front.push(`${key}: ${replacements[key]}`);
        seen.add(key);
      }
      continue;
    }
    if (key && seen.has(key)) continue; // de-duplicate
    front.push(line);
  }
  for (const [key, value] of Object.entries(replacements)) {
    if (!seen.has(key)) front.push(`${key}: ${value}`);
  }
  return ["---", ...front, ...lines.slice(end)].join("\n");
}

/** Copy bundled agents into the agent dir. Existing files win unless force. */
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
    writeFileSync(target, applyOverlay(readFileSync(join(src, file), "utf8"), name, overlay), "utf8");
    written.push(file);
  }
  return { written, skipped };
}

function bundledAgentNames(): string[] {
  try {
    return readdirSync(join(ROOT, "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function describeAgents(): { name: string; description: string; whenToUse: string; model?: string; thinking?: string }[] {
  const overlay = loadOverlay();
  const out = [];
  for (const name of bundledAgentNames()) {
    try {
      const text = readFileSync(join(ROOT, "agents", `${name}.md`), "utf8");
      const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
      const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim();
      out.push({
        name,
        description: get("description") ?? "",
        whenToUse: get("whenToUse") ?? "",
        model: resolveModel(name, overlay.agents?.[name] ?? {}, overlay),
        thinking: get("thinking"),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Notify in the TUI, print in headless modes so commands stay scriptable. */
function report(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else console.log(text);
}

function baselineHashes(): { ok: number; total: number; bad: string[] } {
  const bad: string[] = [];
  let total = 0;
  let ok = 0;
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));
    for (const [rel, expected] of Object.entries(lock.files as Record<string, string>)) {
      total++;
      const abs = join(ROOT, rel);
      const actual = existsSync(abs) ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "missing";
      if (actual === expected) ok++;
      else bad.push(rel);
    }
  } catch {
    return { ok: 0, total: 0, bad: ["upstream.lock.json unreadable"] };
  }
  return { ok, total, bad };
}

/* Orchestration settings live in one small file, shared with orchestrator.ts. */
const SETTINGS_FILE = "agentdeck.json";

type OrchestrationSettings = { autoreview: boolean; autoreviewTtlMinutes: number };

function readOrchestrationSettings(): OrchestrationSettings {
  const fallback: OrchestrationSettings = { autoreview: false, autoreviewTtlMinutes: 10 };
  try {
    const raw = JSON.parse(readFileSync(join(agentBaseDir(), SETTINGS_FILE), "utf8")) as Partial<OrchestrationSettings>;
    return {
      autoreview: typeof raw.autoreview === "boolean" ? raw.autoreview : fallback.autoreview,
      autoreviewTtlMinutes:
        typeof raw.autoreviewTtlMinutes === "number" && raw.autoreviewTtlMinutes > 0
          ? raw.autoreviewTtlMinutes
          : fallback.autoreviewTtlMinutes,
    };
  } catch {
    return fallback;
  }
}

function writeOrchestrationSettings(patch: Partial<OrchestrationSettings>): OrchestrationSettings {
  const next = { ...readOrchestrationSettings(), ...patch };
  try {
    mkdirSync(agentBaseDir(), { recursive: true });
    writeFileSync(join(agentBaseDir(), SETTINGS_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* best effort */
  }
  return next;
}

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;

  // Seed at load time so agents exist before any session-level discovery.
  try {
    seed();
  } catch {
    /* read-only FS: no seeding */
  }

  // Supervisor side: surface contact_supervisor messages from child agents.
  try {
    pi.events.on(SUPERVISOR_EVENT, (data: unknown) => {
      const d = data as { kind?: string; message?: string; options?: string[] };
      if (!d?.message) return;
      try {
        pi.appendEntry("agentdeck:supervisor", d);
      } catch {
        /* bridges without entry support */
      }
      const ctx = lastCtx;
      if (ctx?.hasUI) {
        const opts = d.options?.length ? ` [${d.options.join(" | ")}]` : "";
        ctx.ui.notify(`↩︎ ${PKG} ${d.kind ?? "message"}: ${d.message}${opts}`, d.kind === "blocker" ? "warning" : "info");
      }
    });
  } catch {
    /* no event bus */
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    try {
      const { written } = seed();
      if (written.length && ctx.hasUI) {
        ctx.ui.notify(`${PKG}: installed ${written.join(", ")} → ${agentRootDir()}`, "info");
      }
    } catch {
      /* ignore */
    }
  });

  /**
   * `/route [task]` — pick a bundled agent and delegate to it. The pi-native
   * equivalent of the macOS app's agent library.
   */
  pi.registerCommand("route", {
    description: "Pick a bundled Agent Deck agent (explorer/planner/reviewer) and delegate a task to it",
    handler: async (args, ctx) => {
      const agents = describeAgents();
      if (!agents.length) {
        report(ctx, `${PKG}: no bundled agents found`, "warning");
        return;
      }
      const labels = agents.map(
        (a) => `${a.name.padEnd(9)} ${(a.model ?? "inherit").padEnd(32)} ${a.description}`,
      );
      const picked = ctx.hasUI
        ? await ctx.ui.select("Delegate to which agent?", labels)
        : labels[0];
      if (!picked) return;
      const name = picked.trim().split(/\s+/)[0];

      let task = (args ?? "").trim();
      if (!task && ctx.hasUI) task = ((await ctx.ui.input(`Task for ${name}`)) ?? "").trim();
      if (!task) {
        report(ctx, `${PKG}: no task given`, "warning");
        return;
      }
      const instruction =
        `Use the Agent tool with subagent_type "${name}" and run_in_background: false to complete this task, ` +
        `then report its result:\n\n${task}`;
      if (ctx.hasUI) await pi.sendUserMessage(instruction);
      else console.log(instruction);
    },
  });

  /**
   * `/agentdeck` — status, `sync` to re-install agents, `doctor` to check the setup.
   */
  pi.registerCommand("agentdeck", {
    description: `Bundled Agent Deck agents: status, "sync" (reinstall), "doctor" (check setup)`,
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();

      if (sub === "sync") {
        const { written } = seed(true);
        report(ctx, `${PKG}: wrote ${written.join(", ") || "nothing"} → ${agentRootDir()}`);
        return;
      }

      if (sub.startsWith("autoreview")) {
        const value = sub.replace("autoreview", "").trim();
        if (value === "on" || value === "off") {
          const next = writeOrchestrationSettings({ autoreview: value === "on" });
          report(
            ctx,
            `${PKG}: auto-review ${next.autoreview ? "ON" : "OFF"}` +
              (next.autoreview
                ? ` — after a turn that edits files, the bundled \`reviewer\` agent reviews it (at most one per ${next.autoreviewTtlMinutes} min)`
                : ""),
          );
        } else {
          const s = readOrchestrationSettings();
          report(ctx, `${PKG}: auto-review is ${s.autoreview ? "ON" : "OFF"} (use \`/agentdeck autoreview on|off\`)`);
        }
        return;
      }

      if (sub === "doctor") {
        const base = baselineHashes();
        const tools = (() => {
          try {
            return pi.getAllTools().map((t) => t.name);
          } catch {
            return [] as string[];
          }
        })();
        const runtime = tools.some((t) => t === "Agent" || t === "subagent" || t === "task");
        const lines = [
          `agents dir:      ${agentRootDir()}`,
          `bundled agents:  ${bundledAgentNames().join(", ") || "none"}`,
          `baseline:        ${base.ok}/${base.total} identical${base.bad.length ? ` (bad: ${base.bad.join(", ")})` : ""}`,
          `subagent tools:  ${runtime ? "present" : "NOT FOUND — install a subagent runtime"}`,
          `supervisor tool: ${tools.includes(SUPERVISOR_TOOL) ? "registered" : "not registered"}`,
          `auto-review:     ${readOrchestrationSettings().autoreview ? "ON" : "OFF"}`,
          `scope:           ${projectRootFromPackage() ? "project-local" : "global"}`,
        ];
        report(ctx, `${PKG} doctor\n${lines.join("\n")}`, runtime ? "info" : "warning");
        return;
      }

      const overlay = loadOverlay();
      const rows = describeAgents().map(
        (a) =>
          `${a.name.padEnd(9)} ${(resolveModel(a.name, overlay.agents?.[a.name] ?? {}, overlay) ?? "inherit").padEnd(32)} ${a.whenToUse || a.description}`,
      );
      report(
        ctx,
        `${PKG} — ${bundledAgentNames().length} agents (${agentRootDir()})\n${rows.join("\n")}\n` +
          `auto-review: ${readOrchestrationSettings().autoreview ? "ON" : "OFF"}\n` +
          `Commands: /route [task] · /agentdeck sync · /agentdeck autoreview on|off · /agentdeck doctor · /agentdeck-routing`,
      );
    },
  });
}
