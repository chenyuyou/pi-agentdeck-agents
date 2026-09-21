/**
 * orchestrator.ts — pi-native orchestration for the Agent Deck agents.
 *
 * Two features that the macOS Agent Deck app provided at its own layer:
 *
 *  C) ROUTING HINTS — the app routed the parent session using each agent's
 *     `whenToUse` frontmatter. pi's subagent runtime ignores `whenToUse`
 *     entirely, so it is injected here as a system-prompt section. It stays in
 *     sync with the agent directory (no generated file to go stale).
 *
 *  B) AUTO-REVIEW — after a turn that actually changed files, optionally spawn
 *     the bundled `reviewer` agent to review the change set. Off by default;
 *     toggled with `/agentdeck autoreview on|off`.
 *
 * Deliberately self-contained (no relative imports) so it loads regardless of
 * how the host resolves TS module specifiers.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const ROUTING_MARKER = "AGENT-ROUTING-V1";
const EDIT_TOOLS = new Set(["edit", "write"]);
const FILE_KEYS = ["file_path", "filePath", "path", "file", "filename", "target_file"];

/**
 * Auto-review spawns a BACKGROUND agent. In one-shot modes pi shuts the session
 * down (and disposes the extension event bus) as soon as the run ends, so the
 * background agent's completion emit lands on a dead bus and crashes the
 * process. Auto-review is only meaningful in long-lived sessions anyway.
 */
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);

type Settings = { autoreview: boolean; autoreviewTtlMinutes: number };

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}
const settingsPath = () => join(agentDir(), "agentdeck.json");
const lockPath = () => join(agentDir(), "agentdeck-autoreview.lock");
const logPath = () => join(agentDir(), "agentdeck-autoreview.jsonl");

function readSettings(): Settings {
  const defaults: Settings = { autoreview: false, autoreviewTtlMinutes: 10 };
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<Settings>;
    return {
      autoreview: typeof raw.autoreview === "boolean" ? raw.autoreview : defaults.autoreview,
      autoreviewTtlMinutes:
        typeof raw.autoreviewTtlMinutes === "number" && raw.autoreviewTtlMinutes > 0
          ? raw.autoreviewTtlMinutes
          : defaults.autoreviewTtlMinutes,
    };
  } catch {
    return defaults;
  }
}

function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  try {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    /* best effort */
  }
  return next;
}

function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    appendFileSync(logPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

type AgentMeta = { name: string; description: string; whenToUse: string; model: string };

/** Minimal frontmatter reader: `key: value` lines at column 0. */
function readAgentMeta(): AgentMeta[] {
  const dir = join(agentDir(), "agents");
  if (!existsSync(dir)) return [];
  const out: AgentMeta[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      const text = readFileSync(join(dir, file), "utf8").replace(/^\uFEFF/, "");
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      const fm = m ? m[1] : "";
      const get = (k: string) =>
        (fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      out.push({
        name: get("name") || file.replace(/\.md$/, ""),
        description: get("description"),
        whenToUse: get("whenToUse"),
        model: get("model"),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** The routing block injected into the system prompt (C). */
function routingBlock(): string | undefined {
  const agents = readAgentMeta().filter((a) => a.whenToUse);
  if (agents.length === 0) return undefined;
  const lines = [
    ROUTING_MARKER,
    "Subagent routing rules. Use the Agent tool with `run_in_background: false` when a task matches a role:",
    ...agents.map((a) => `- ${a.name}${a.model ? ` [${a.model}]` : ""}: ${a.whenToUse}`),
    "Do not delegate trivial or already-scoped work, and prefer direct tools when the target is known.",
    "Trust but verify: an agent's summary describes intent, not outcome.",
  ];
  return lines.join("\n");
}

function sessionId(ctx: ExtensionContext | undefined): string {
  try {
    return String((ctx?.sessionManager as { getSessionId?: () => string })?.getSessionId?.() ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** Tool parameter names differ between tools/versions; pick a plausible path. */
function extractFile(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of FILE_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.trim() && /path|file/i.test(key)) return value.trim();
  }
  return "";
}

function lockAgeMs(): number | undefined {
  try {
    const p = lockPath();
    if (!existsSync(p)) return undefined;
    return Date.now() - statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
}

function writeLock(files: string[], sid: string): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ at: new Date().toISOString(), sessionId: sid, files }) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

export default function (pi: ExtensionAPI) {
  // sessionId -> files changed by that session since its last settle
  const pendingEdits = new Map<string, Set<string>>();
  // toolCallId -> { sessionId, file } so a failed edit can be rolled back
  const editCalls = new Map<string, { sid: string; file: string }>();

  /* ---------------------------------------------------------------- C: routing */

  pi.on("before_agent_start", async (event, _ctx) => {
    const block = routingBlock();
    if (!block) return undefined;
    try {
      const options = event.systemPromptOptions as { sections?: Record<string, string> } | undefined;
      if (options && options.sections && typeof options.sections === "object") {
        options.sections["agent_routing"] = block;
        return undefined; // mutated in place; pi diffs sections and appends a patch
      }
    } catch {
      /* fall through to the full-prompt append below */
    }
    // Fallback for hosts without structured sections.
    return { systemPrompt: event.systemPrompt + "\n\n" + block };
  });

  /** Preview exactly what gets injected: `/agentdeck-routing`. */
  pi.registerCommand("agentdeck-routing", {
    description: "Show the agent routing block injected into the system prompt",
    handler: async (_args, ctx) => {
      const block = routingBlock();
      const text = block ?? `(no agents with whenToUse found in ${join(agentDir(), "agents")})`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  /* ------------------------------------------------------------ B: auto-review */

  // pi exposes tool `args` only on tool_execution_start / _update, not on _end.
  pi.on("tool_execution_start", async (event, ctx) => {
    const name = String(event.toolName ?? "");
    if (!EDIT_TOOLS.has(name)) return;
    const args = (event.args ?? {}) as Record<string, unknown>;
    const file = extractFile(args) || "(unknown file)";
    const sid = sessionId(ctx);
    const set = pendingEdits.get(sid) ?? new Set<string>();
    set.add(file);
    pendingEdits.set(sid, set);
    if (event.toolCallId) editCalls.set(String(event.toolCallId), { sid, file });
    if (readSettings().autoreview) {
      audit({ action: "edit", sessionId: sid, tool: name, file, argKeys: Object.keys(args) });
    }
  });

  // A failed edit should not trigger a review of a file that was never written.
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!event.isError) return;
    const call = editCalls.get(String(event.toolCallId ?? ""));
    if (!call) return;
    editCalls.delete(String(event.toolCallId));
    const set = pendingEdits.get(call.sid);
    if (set) {
      set.delete(call.file);
      if (set.size === 0) pendingEdits.delete(call.sid);
    }
    if (readSettings().autoreview) {
      audit({ action: "edit-failed", sessionId: call.sid, file: call.file });
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const settings = readSettings();
    if (!settings.autoreview) return;

    const mode = String((ctx as { mode?: string }).mode ?? "tui");
    if (!INTERACTIVE_MODES.has(mode)) {
      pendingEdits.clear();
      audit({ action: "skipped", reason: `non-interactive mode (${mode})`, files: [] });
      return;
    }

    const sid = sessionId(ctx);
    const files = pendingEdits.get(sid);
    if (!files || files.size === 0) return;
    pendingEdits.delete(sid);

    const age = lockAgeMs();
    const ttlMs = settings.autoreviewTtlMinutes * 60_000;
    if (age !== undefined && age < ttlMs) {
      audit({ action: "skipped", reason: "recent review", sessionId: sid, files: [...files] });
      return;
    }

    const list = [...files];
    writeLock(list, sid);
    audit({ action: "spawn", sessionId: sid, files: list });

    const requestId = `agentdeck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;

    let settled = false;
    const unsub = pi.events.on(replyChannel, (raw: unknown) => {
      settled = true;
      try {
        if (typeof unsub === "function") unsub();
      } catch {
        /* ignore */
      }
      const reply = raw as { success?: boolean; error?: string } | undefined;
      audit({ action: "spawn-reply", requestId, success: reply?.success === true, error: reply?.error });
      if (reply?.success !== true && ctx.hasUI) {
        ctx.ui.notify(`${PKG}: auto-review could not start (${reply?.error ?? "no reply"})`, "warning");
      }
    });

    const prompt = [
      "Review the changes just made in this session. Do not edit files.",
      "",
      "Changed files:",
      ...list.map((f) => `- ${f}`),
      "",
      "Inspect the real diff (`git diff`, `git diff --cached`) and report evidence-backed findings:",
      "- correctness and missed requirements",
      "- regressions and edge cases",
      "- missing or insufficient validation",
      "- maintainability and unnecessary complexity",
      "",
      "Lead with blocking issues. If there is nothing material, say so plainly.",
    ].join("\n");

    try {
      pi.events.emit("subagents:rpc:spawn", {
        requestId,
        type: "reviewer",
        prompt,
        options: { runInBackground: true },
      });
    } catch (err) {
      audit({ action: "spawn-threw", error: String(err) });
      return;
    }

    // No reply usually means no subagent runtime is installed.
    setTimeout(() => {
      if (settled) return;
      try {
        if (typeof unsub === "function") unsub();
      } catch {
        /* ignore */
      }
      audit({ action: "spawn-timeout", requestId });
      if (ctx.hasUI) {
        ctx.ui.notify(`${PKG}: auto-review got no response — is a subagent runtime installed?`, "warning");
      }
    }, 10_000);

    if (ctx.hasUI) {
      ctx.ui.notify(`${PKG}: auto-review started for ${list.length} changed file(s)`, "info");
    }
  });
}
