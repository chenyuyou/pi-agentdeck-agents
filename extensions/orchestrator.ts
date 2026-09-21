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
import { fileURLToPath } from "node:url";
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

function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    appendFileSync(logPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

/* --------------------------------------- overlay: reads + fallback models */

function packageRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return "";
  }
}

/** Primary model from the overlay (explicit model beats tier). Undefined = inherit. */
function primaryFor(type: string): string | undefined {
  try {
    const root = packageRoot();
    if (!root) return undefined;
    const overlay = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as {
      tiers?: Record<string, { model?: unknown }>;
      agents?: Record<string, { model?: unknown; tier?: unknown }>;
    };
    const a = overlay.agents?.[type] ?? {};
    if (typeof a.model === "string" && a.model.trim()) return a.model.trim();
    if (typeof a.tier === "string") {
      const m = overlay.tiers?.[a.tier]?.model;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function fallbacksFor(type: string): string[] {
  try {
    const root = packageRoot();
    if (!root) return [];
    const overlay = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as {
      tiers?: Record<string, { model?: unknown }>;
      agents?: Record<string, { model?: unknown; tier?: unknown; fallbackModels?: unknown }>;
    };
    const list = overlay.agents?.[type]?.fallbackModels;
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string" && !!m.trim()) : [];
  } catch {
    return [];
  }
}

/** defaultReads from the installed agent file (mac field the runtime ignores). */
function readsFor(type: string): string[] {
  try {
    const text = readFileSync(join(agentDir(), "agents", `${type}.md`), "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    const raw = m ? (m[1].match(/^defaultReads:\s*(.+)$/m)?.[1] ?? "") : "";
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const MODEL_ERROR_RE = /model|auth|api key|oauth|unavailable|not found|resolve|scope|thinking|provider/i;
const isModelError = (error?: string) => !!error && MODEL_ERROR_RE.test(error);

type AgentMeta = {
  name: string;
  description: string;
  whenToUse: string;
  model: string;
  outcome: string;
  tools: string;
  reads: string;
};

/** Delegation policy, mirroring the macOS app's light | balanced | strict wording. */
const POLICY_BULLETS: Record<string, string[]> = {
  light: [
    "- Act primarily as the coordinator for these agents when delegation would clearly improve the result.",
    "- Use the Agent tool for separable specialist work, large investigations, parallel research, or tasks where an available agent is clearly a better fit.",
    "- You may do straightforward implementation, inspection, explanation, and small fixes yourself when delegation would add unnecessary overhead.",
  ],
  balanced: [
    "- Act primarily as the orchestrator: clarify, plan, delegate, supervise, and synthesize results.",
    "- Delegate substantive implementation, investigation, planning, or review work to a relevant agent by default; work directly only for trivial, low-risk one-off changes where delegation would add unnecessary overhead.",
    "- Use the Agent tool for bounded specialist work. Choose the available agent whose routing guidance best matches the task and expected outcome.",
  ],
  strict: [
    "- Act primarily as the orchestrator: clarify, plan, delegate, supervise, and synthesize results.",
    "- For any substantive task, if an available agent could reasonably perform it, delegate it with the Agent tool.",
    "- Do not keep implementation, investigation, planning, or review work in the parent merely because you can do it yourself. Work directly only for trivial conversational replies, direct user clarification, plan/status updates, synthesis of agent results, or when no listed agent fits.",
  ],
};

function policyName(): string {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as { policy?: string };
    return raw.policy && POLICY_BULLETS[raw.policy] ? raw.policy : "balanced";
  } catch {
    return "balanced";
  }
}

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
        outcome: get("defaultExpectedOutcome"),
        tools: get("tools"),
        reads: get("defaultReads"),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * The catalog injected into the system prompt — the same shape the macOS app
 * appends (`nativeSubagentCatalogPrompt`): orchestration rules + delegation
 * policy + `Available agents:` lines carrying whenToUse, outcome and tools.
 */
function routingBlock(): string | undefined {
  const agents = readAgentMeta();
  if (agents.length === 0) return undefined;
  const policy = policyName();
  const lines = [
    ROUTING_MARKER,
    "Agent Deck orchestration (parent session):",
    "- Delegation happens only through the Agent tool (`subagent_type`); it is not automatic — if you do not call it, nothing is delegated.",
    ...POLICY_BULLETS[policy],
    "- Fresh agents cannot see this conversation, its context, tool results, or earlier agents' findings. Every delegation must be self-contained: goal, requirements, constraints, expected output, useful file reads.",
    "- Keep a short plan for multi-step work and update it as steps start, complete, block or change.",
    "- If you delegate planning to `planner`, convert its returned plan into your own working plan before implementing, unless the user only asked for a report.",
    "- Trust but verify: an agent's summary describes intent, not outcome.",
    "",
    `Available agents (policy: ${policy}):`,
  ];
  for (const a of agents) {
    const routing = (a.whenToUse || a.description || "Use when this specialist fits the task.").trim();
    const tools = a.tools
      ? `tools: ${a.tools
          .split(",")
          .map((t) => t.trim().replace(/^ext:[^/]+\//, ""))
          .join(", ")}`
      : "default tools";
    const outcome = a.outcome || "reportOnly";
    const reads = a.reads
      ? `; reads: ${a.reads
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ")}`
      : "";
    lines.push(`- ${a.name}: ${routing} [outcome: ${outcome}; ${tools}${reads}]`);
  }
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

    const reads = readsFor("reviewer");
    const prompt = [
      "Review the changes just made in this session. Do not edit files.",
      "",
      "Changed files:",
      ...list.map((f) => `- ${f}`),
      ...(reads.length ? ["", `Also check these prior-context files if present: ${reads.join(", ")}`] : []),
      "",
      "Inspect the real diff (`git diff`, `git diff --cached`) and report evidence-backed findings:",
      "- correctness and missed requirements",
      "- regressions and edge cases",
      "- missing or insufficient validation",
      "- maintainability and unnecessary complexity",
      "",
      "Lead with blocking issues. If there is nothing material, say so plainly.",
    ].join("\n");
    const label =
      list.length <= 2 ? list.map((f) => f.split("/").pop()).join(", ") : `${list.length} files`;
    const description = `auto-review: ${label}`;

    const attempt = (model?: string): Promise<{ id?: string; error?: string }> =>
      new Promise((resolve) => {
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
          const reply = raw as { success?: boolean; data?: { id?: string }; error?: string } | undefined;
          audit({
            action: "spawn-reply",
            requestId,
            model: model ?? "(pin)",
            success: reply?.success === true,
            error: reply?.error,
          });
          if (reply?.success && reply.data?.id) resolve({ id: reply.data.id });
          else resolve({ error: reply?.error ?? "no reply from subagent runtime" });
        });
        try {
          // description is required: the runtime renders record.description verbatim
          // and an unset value shows up in the UI as the literal string "undefined".
          const options: Record<string, unknown> = { runInBackground: true, description };
          if (model) options.model = model;
          pi.events.emit("subagents:rpc:spawn", { requestId, type: "reviewer", prompt, options });
        } catch (err) {
          audit({ action: "spawn-threw", error: String(err) });
          resolve({ error: String(err) });
          return;
        }
        setTimeout(() => {
          if (settled) return;
          try {
            if (typeof unsub === "function") unsub();
          } catch {
            /* ignore */
          }
          audit({ action: "spawn-timeout", requestId });
          resolve({ error: "no reply from subagent runtime" });
        }, 10_000);
      });

    void (async () => {
      // Explicit primary so a bad pin hard-errors (frontmatter pins only warn
      // and inherit, which would silently swallow the fallback chain).
      const seen = new Set<string>();
      const candidates: Array<string | undefined> = [];
      for (const m of [primaryFor("reviewer"), ...fallbacksFor("reviewer")]) {
        const key = m ?? "(inherit)";
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(m);
      }
      if (candidates.length === 0) candidates.push(undefined);
      for (let i = 0; i < candidates.length; i++) {
        const result = await attempt(candidates[i]);
        if (result.id) {
          if (ctx.hasUI) {
            ctx.ui.notify(`${PKG}: auto-review started for ${list.length} changed file(s)`, "info");
          }
          return;
        }
        const next = candidates[i + 1];
        if (next === undefined || !isModelError(result.error)) {
          if (ctx.hasUI) {
            ctx.ui.notify(`${PKG}: auto-review could not start (${result.error ?? "no reply"})`, "warning");
          }
          return;
        }
        audit({ action: "spawn-fallback", from: candidates[i] ?? "(inherit)", to: next, error: result.error });
        if (ctx.hasUI) ctx.ui.notify(`${PKG}: model failed, retrying reviewer with ${next}`, "warning");
      }
    })();
  });
}
