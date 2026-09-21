/**
 * flow.ts — task-adaptive orchestration: start the right agent from the shape of
 * the task, not only when the model happens to feel like delegating.
 *
 * This is the macOS Agent Deck app's "parent-session routing rule" made concrete
 * on pi, using three supported hooks:
 *
 *   input              → classify the prompt and (optionally) auto-start an agent
 *   tool_call          → optionally gate the first edit behind a plan
 *   subagents:*        → know which agents ran and when they finished
 *
 * Classification is heuristic (deterministic, no extra model call). Every
 * decision is appended to ~/.pi/agent/agentdeck-flow.jsonl so behaviour is
 * auditable and tunable with `/agentdeck-flow test <text>`.
 *
 * Settings live in ~/.pi/agent/agentdeck.json (shared with the other extensions):
 *   { "autoSpawn": false, "planGate": false }
 *
 * Self-contained on purpose (no relative imports) — see orchestrator.ts.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const EDIT_TOOLS = new Set(["edit", "write"]);
const MAX_GATE_BLOCKS = 2;
/** Prefixed onto prompts we inject, so a child session never re-classifies them. */
const SPAWN_MARKER = "[agentdeck-flow]";
/** Auto-start and gating only make sense in long-lived sessions. */
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);

type Classification = "explore" | "plan" | "review" | "none";
type Settings = { autoSpawn: boolean; planGate: boolean };

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

function readSettings(): Settings {
  const fallback: Settings = { autoSpawn: false, planGate: false };
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as Partial<Settings>;
    return {
      autoSpawn: typeof raw.autoSpawn === "boolean" ? raw.autoSpawn : fallback.autoSpawn,
      planGate: typeof raw.planGate === "boolean" ? raw.planGate : fallback.planGate,
    };
  } catch {
    return fallback;
  }
}

/* --------------------------------- spend tracking (cost guard) -------------- */

type Spend = { date: string; total: number; notified80: boolean; notified100: boolean };

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function spendPath(): string {
  return join(agentDir(), "agentdeck-spend.json");
}

function readSpend(): Spend {
  const fresh = (): Spend => ({ date: todayKey(), total: 0, notified80: false, notified100: false });
  try {
    const raw = JSON.parse(readFileSync(spendPath(), "utf8")) as Partial<Spend>;
    if (raw.date !== todayKey() || typeof raw.total !== "number") return fresh();
    return {
      date: raw.date,
      total: raw.total,
      notified80: raw.notified80 === true,
      notified100: raw.notified100 === true,
    };
  } catch {
    return fresh();
  }
}

function writeSpend(spend: Spend): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    // tmp + rename: two processes (the background agent runner also loads this
    // extension) can write spend concurrently; a partial file would lose all of it.
    const tmp = `${spendPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(spend, null, 2) + "\n", "utf8");
    renameSync(tmp, spendPath());
  } catch {
    /* best effort */
  }
}

function readBudgetDaily(): number {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as {
      budget?: { dailyUsd?: unknown };
    };
    const value = raw.budget?.dailyUsd;
    return typeof value === "number" && value >= 0 ? value : 10;
  } catch {
    return 10;
  }
}

function addSpend(amount: number): Spend {
  const spend = readSpend();
  spend.total = Math.round((spend.total + amount) * 10000) / 10000;
  writeSpend(spend);
  return spend;
}

/**
 * Returns true when automatic work may proceed. Notifies once per day at 80%
 * and at 100%, and pauses automatic spawns once the budget is exhausted.
 * Explicit user actions (model-initiated spawns, /agentdeck-loop) are unaffected.
 */
function checkBudget(ctx: ExtensionContext | undefined, why: string): boolean {
  const budget = readBudgetDaily();
  if (!(budget > 0)) return true;
  const spend = readSpend();
  const pct = spend.total / budget;
  const notify = (text: string, level: "info" | "warning") => {
    if (ctx?.hasUI) ctx.ui.notify(text, level);
    else console.log(text);
  };
  if (pct >= 1) {
    if (!spend.notified100) {
      spend.notified100 = true;
      writeSpend(spend);
      notify(`${PKG}: daily subagent budget exhausted ($${spend.total.toFixed(3)} / $${budget.toFixed(2)}). Pausing automatic spawns.`, "warning");
    }
    audit({ action: "budget-paused", why, total: spend.total, budget });
    return false;
  }
  if (pct >= 0.8 && !spend.notified80) {
    spend.notified80 = true;
    writeSpend(spend);
    notify(`${PKG}: daily subagent spend at 80% ($${spend.total.toFixed(3)} / $${budget.toFixed(2)}).`, "warning");
  }
  return true;
}

function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    appendFileSync(join(agentDir(), "agentdeck-flow.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ classify */

const RE = {
  review: /\b(review|audit|critique|second opinion)\b|审查|评审|复查|检查一下|有没有问题|帮我看下有没有|代码审查/i,
  explore:
    /\b(explore|recon|scout|where is|where's|how does|how do i find|locate|map out|understand the)\b|调研|了解|摸清|梳理|看看.*(结构|实现|流程)|在哪|怎么实现|是什么结构/i,
  // Strong imperatives: an unambiguous "go change code" signal.
  implStrong:
    /\b(implement|add|refactor|migrate|rewrite|fix|upgrade|wire up|integrate)\b|实现一下|实现一个|新增|重构|迁移|改造|修复|加个|加上|改一下|接入|集成/i,
  // Heavy structural verbs — a typo fix is trivial, a refactor is not.
  implHeavy: /\b(implement|refactor|migrate|rewrite|upgrade|wire up|integrate)\b|新增|重构|迁移|改造|接入|集成|加个|加上/i,
  // Weak cues that only count outside an interrogative sentence.
  implWeak: /\b(change|build|update|extend|support)\b|实现|改|调整|支持/i,
  interrogative: /(怎么|如何|为什么|是什么|在哪|什么结构|哪个)|\b(how|where|what|why|which)\b/i,
  trivial: /\b(typo|one[- ]line|rename|whitespace|spelling)\b|错别字|错字|拼写|改个名|改.{0,3}注释|加.{0,3}注释|小改/i,
};

export function classify(text: string): { kind: Classification; why: string } {
  const t = text.trim();
  if (!t) return { kind: "none", why: "empty" };
  if (t.startsWith("/")) return { kind: "none", why: "slash command" };
  // Already an explicit delegation instruction — do not start a second agent.
  if (/\b(agent tool|subagent_type)\b|用\s*(explorer|planner|reviewer)|派给|让\s*(explorer|planner|reviewer)/i.test(t))
    return { kind: "none", why: "explicit delegation instruction" };
  const words = t.split(/\s+/).length;
  const strong = RE.implStrong.test(t);
  const heavy = RE.implHeavy.test(t);
  const weak = RE.implWeak.test(t);
  const explore = RE.explore.test(t);
  const review = RE.review.test(t);
  const trivial = RE.trivial.test(t);
  const question = RE.interrogative.test(t);

  if (trivial && !heavy) return { kind: "none", why: "trivial marker" };
  if (review && !strong) return { kind: "review", why: "review intent" };
  if (strong) return { kind: "plan", why: explore ? "implementation + exploration" : "implementation intent" };
  // "how does X work" is reconnaissance, not a change request.
  if (question && explore) return { kind: "explore", why: "interrogative exploration" };
  if (weak && !question) return { kind: "plan", why: "implementation cue" };
  if (explore) return { kind: "explore", why: "exploration intent" };
  if (t.length >= 120 || words >= 20) return { kind: "plan", why: "long, open-ended request" };
  return { kind: "none", why: "short and specific" };
}

/* --------------------------------------------------------------- spawn text */

/* --------------------------------------- overlay: reads + fallback models */

/** Agent dirs in the runtime's precedence order (project first). */
function candidateAgentDirs(): string[] {
  const dirs: string[] = [];
  try {
    const project = join(process.cwd(), CONFIG_DIR_NAME, "agents");
    if (existsSync(project)) dirs.push(project);
  } catch {
    /* ignore */
  }
  dirs.push(join(agentDir(), "agents"));
  return dirs;
}

function packageRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return "";
  }
}

type OverlayAgent = { model?: string; tier?: string; thinking?: string; fallbackModels?: string[] };
type Overlay = { tiers?: Record<string, { model?: string }>; agents?: Record<string, OverlayAgent> };

/** Primary model from the overlay (explicit model beats tier). Undefined = inherit. */
function primaryFor(type: string): string | undefined {
  try {
    const overlay = readOverlay();
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

function readOverlay(): Overlay {
  try {
    const root = packageRoot();
    if (!root) return {};
    return JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as Overlay;
  } catch {
    return {};
  }
}

function agentTypeName(kind: Exclude<Classification, "none">): string {
  return kind === "explore" ? "explorer" : kind === "plan" ? "planner" : "reviewer";
}

function fallbacksFor(type: string): string[] {
  try {
    const list = readOverlay().agents?.[type]?.fallbackModels;
    return Array.isArray(list) ? list.filter((m) => typeof m === "string" && m.trim()) : [];
  } catch {
    return [];
  }
}

/** defaultReads from the installed agent file (mac field the runtime ignores). */
/** defaultReads from the agent file (mac field the runtime ignores). Project wins. */
function readsFor(type: string): string[] {
  for (const dir of candidateAgentDirs()) {
    try {
      const file = join(dir, `${type}.md`);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      const raw = m ? (m[1].match(/^defaultReads:\s*(.+)$/m)?.[1] ?? "") : "";
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* try the next dir */
    }
  }
  return [];
}

const MODEL_ERROR_RE = /model|auth|api key|oauth|unavailable|not found|resolve|scope|thinking|provider/i;
const isModelError = (error?: string) => !!error && MODEL_ERROR_RE.test(error);

function spawnPrompt(kind: Exclude<Classification, "none">, task: string, reads: string[]): string {
  const readFirst = reads.length
    ? [`Read these files first if present (they carry prior context): ${reads.join(", ")}`, ""]
    : [];
  if (kind === "explore") {
    return [
      SPAWN_MARKER,
      ...readFirst,
      "Reconnaissance pass for the request below. Report entry points, relevant files, data flow, existing patterns, constraints and unknowns.",
      "Do not recommend implementation approaches and do not edit files.",
      "",
      "Request:",
      task,
    ].join("\n");
  }
  if (kind === "plan") {
    return [
      SPAWN_MARKER,
      ...readFirst,
      "Produce a concise, evidence-backed implementation plan for the request below: goal and non-goals, recommended approach and why, files/components, ordered steps, risks, validation.",
      "Do not edit files. The parent session will implement after reading your plan.",
      "",
      "Request:",
      task,
    ].join("\n");
  }
  return [
    SPAWN_MARKER,
    ...readFirst,
    "Review the current state of this repository for the request below. Inspect the real diff (`git diff`, `git diff --cached`).",
    "Report evidence-backed findings: correctness, missed requirements, regressions, missing validation. Do not edit files.",
    "",
    "Request:",
    task,
  ].join("\n");
}

/* --------------------------------------------------------------- per-session */

type TaskState = {
  kind: Classification;
  planned: boolean;
  gateBlocks: number;
  spawnId?: string;
  autoSpawned: boolean;
};

const tasks = new Map<string, TaskState>();

function sessionId(ctx: ExtensionContext | undefined): string {
  try {
    return String((ctx?.sessionManager as { getSessionId?: () => string })?.getSessionId?.() ?? "unknown");
  } catch {
    return "unknown";
  }
}

export default function (pi: ExtensionAPI) {
  /** Spawn through the runtime's cross-extension RPC; resolve with the agent id. */
  const spawnAgent = (kind: Exclude<Classification, "none">, task: string, ctx: ExtensionContext): Promise<string | undefined> => {
    const type = agentTypeName(kind);
    const reads = readsFor(type);
    const prompt = spawnPrompt(kind, task, reads);
    // description is required: the runtime renders record.description verbatim
    // and an unset value shows up in the UI as the literal string "undefined".
    const head = task.replace(/\s+/g, " ").trim().slice(0, 48);
    const description = `auto: ${kind}${head ? ` — ${head}` : ""}`;

    const attempt = (model?: string): Promise<{ id?: string; error?: string }> =>
      new Promise((resolve) => {
        const requestId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const channel = `subagents:rpc:spawn:reply:${requestId}`;
        let done = false;
        const unsub = pi.events.on(channel, (raw: unknown) => {
          done = true;
          try {
            if (typeof unsub === "function") unsub();
          } catch {
            /* ignore */
          }
          const reply = raw as { success?: boolean; data?: { id?: string }; error?: string };
          audit({
            action: "spawn-reply",
            kind,
            requestId,
            model: model ?? "(pin)",
            success: reply?.success === true,
            id: reply?.data?.id,
            error: reply?.error,
          });
          if (reply?.success && reply.data?.id) resolve({ id: reply.data.id });
          else resolve({ error: reply?.error ?? "spawn failed" });
        });
        try {
          const options: Record<string, unknown> = { runInBackground: true, description };
          if (model) options.model = model;
          pi.events.emit("subagents:rpc:spawn", { requestId, type, prompt, options });
        } catch (err) {
          // Release the reply listener: an emit that throws never gets a reply.
          try {
            if (typeof unsub === "function") unsub();
          } catch {
            /* ignore */
          }
          audit({ action: "spawn-threw", kind, error: String(err) });
          resolve({ error: String(err) });
          return;
        }
        setTimeout(() => {
          if (done) return;
          try {
            if (typeof unsub === "function") unsub();
          } catch {
            /* ignore */
          }
          audit({ action: "spawn-timeout", kind, requestId });
          resolve({ error: "no reply from subagent runtime" });
        }, 10_000);
      });

    return (async () => {
      // Explicit primary so a bad pin hard-errors (frontmatter pins only warn
      // and inherit, which would silently swallow the fallback chain).
      const seen = new Set<string>();
      const candidates: Array<string | undefined> = [];
      for (const m of [primaryFor(type), ...fallbacksFor(type)]) {
        const key = m ?? "(inherit)";
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(m);
      }
      // No explicit pin and no fallbacks leaves one candidate: inherit the parent
      // model. After explicit pins we deliberately do NOT fall back to inherit —
      // a silent model change is worse than a visible failure.
      if (candidates.length === 0) candidates.push(undefined);
      for (let i = 0; i < candidates.length; i++) {
        const result = await attempt(candidates[i]);
        if (result.id) return result.id;
        const isLast = i === candidates.length - 1;
        audit({ action: "spawn-failed", kind, model: candidates[i] ?? "(inherit)", error: result.error, isLast });
        // Fail over only on model-looking errors; anything else fails fast.
        if (isLast || !isModelError(result.error)) {
          // Always surface the terminal failure — a model error used to be
          // swallowed here, leaving auto-start silently doing nothing.
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${PKG}: could not auto-start ${kind} (${result.error ?? "no subagent runtime?"})`,
              "warning",
            );
          }
          return undefined;
        }
        const next = candidates[i + 1];
        audit({ action: "spawn-fallback", kind, from: candidates[i] ?? "(inherit)", to: next ?? "(inherit)", error: result.error });
        if (ctx.hasUI) ctx.ui.notify(`${PKG}: model failed, retrying ${type} with ${next ?? "the parent model"}`, "warning");
      }
      return undefined;
    })();
  };

  /* -- 1. classify each new task and optionally start an agent up front ------ */

  pi.on("input", async (event, ctx) => {
    const source = String((event as { source?: string }).source ?? "interactive");
    // Never react to our own injections, and never to mid-run steers.
    if (source === "extension") return undefined;
    if ((event as { streamingBehavior?: string }).streamingBehavior) return undefined;

    const sid = sessionId(ctx);
    const text = String(event.text ?? "");
    const mode = String((ctx as { mode?: string }).mode ?? "tui");

    // Our own spawn prompts must never be classified again. Child sessions load
    // this extension too, so without this the planner/reviewer prompts would
    // recursively try to start more agents (observed: spawn-timeout entries).
    if (text.includes(SPAWN_MARKER)) {
      audit({ action: "skip", sessionId: sid, reason: "our own spawn prompt" });
      return undefined;
    }
    if (!INTERACTIVE_MODES.has(mode)) {
      audit({ action: "skip", sessionId: sid, reason: `non-interactive mode (${mode})`, chars: text.length });
      return undefined;
    }

    const { kind, why } = classify(text);
    const settings = readSettings();
    const state: TaskState = { kind, planned: false, gateBlocks: 0, autoSpawned: false };
    tasks.set(sid, state);
    audit({ action: "classify", sessionId: sid, mode, kind, why, chars: text.length });

    if (!settings.autoSpawn || kind === "none") return undefined;

    if (!checkBudget(ctx, "auto-spawn")) return undefined;
    state.autoSpawned = true;
    void spawnAgent(kind, text.trim(), ctx).then((id) => {
      if (id) {
        state.spawnId = id;
        audit({ action: "auto-spawn", sessionId: sid, kind, id });
        if (ctx.hasUI) ctx.ui.notify(`${PKG}: started \`${kind}\` agent for this task`, "info");
      }
    });
    return undefined; // do not alter the user's prompt
  });

  /* -- 2. learn when the agents finish (from the runtime's own events) ------- */

  for (const channel of ["subagents:completed", "subagents:failed"]) {
    pi.events.on(channel, (raw: unknown) => {
      const data = raw as {
        id?: string;
        type?: string;
        status?: string;
        usage?: { cost?: { total?: number } };
      } | undefined;
      if (!data?.type) return;
      // A planner run satisfies the gate. Correlate by the agent id we started
      // when we have one; only a model-initiated planner (no spawnId) falls back
      // to opening every planning session, since the completion event carries no
      // session id to correlate on.
      if (data.type === "planner") {
        let matched = false;
        for (const state of tasks.values()) {
          if (state.kind === "plan" && state.spawnId && state.spawnId === data.id) {
            state.planned = true;
            matched = true;
          }
        }
        if (!matched) {
          for (const state of tasks.values()) {
            if (state.kind === "plan" && !state.spawnId) state.planned = true;
          }
        }
      }
      // Central spend accounting: EVERY subagent completion lands here, whatever
      // spawned it (flow auto-start, orchestrator auto-review, loop steps, or the
      // model itself), because this listener is the only one that accumulates.
      // Moving this call would silently split the budget guard from its data.
      const cost = Number(data.usage?.cost?.total ?? 0);
      if (Number.isFinite(cost) && cost > 0) addSpend(cost);
      audit({ action: channel === "subagents:completed" ? "agent-completed" : "agent-failed", type: data.type, id: data.id });
    });
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    tasks.delete(sessionId(ctx));
  });

  /* -- 3. optionally gate the first edit behind a plan ----------------------- */

  pi.on("tool_call", async (event, ctx) => {
    const settings = readSettings();
    if (!settings.planGate) return undefined;
    if (!EDIT_TOOLS.has(String(event.toolName ?? ""))) return undefined;

    const sid = sessionId(ctx);
    const state = tasks.get(sid);
    if (!state || state.kind !== "plan" || state.planned) return undefined;
    if (state.gateBlocks >= MAX_GATE_BLOCKS) return undefined; // never deadlock

    state.gateBlocks++;
    audit({ action: "gate-block", sessionId: sid, tool: event.toolName, attempt: state.gateBlocks });
    return {
      block: true,
      reason:
        "Plan first: a `planner` agent is producing an implementation plan for this task. " +
        "Wait for its result (or call the Agent tool with subagent_type \"planner\" yourself), then apply the edits. " +
        "If you already have a plan, state it in one message and retry — the gate opens after one more attempt.",
    };
  });

  /* -- 4. status / tuning surface ------------------------------------------- */

  pi.registerCommand("agentdeck-flow", {
    description: "Task-adaptive agent flow: status, on/off (auto-start), gate on/off, test <text>",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const [cmd, ...rest] = raw.split(/\s+/);
      const say = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.log(text);
      };

      const patch = (p: Partial<Settings>) => {
        const next = { ...readSettings(), ...p };
        try {
          const current = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as Record<string, unknown>;
          mkdirSync(agentDir(), { recursive: true });
          writeFileSync(join(agentDir(), "agentdeck.json"), JSON.stringify({ ...current, ...next }, null, 2) + "\n", "utf8");
        } catch {
          /* best effort */
        }
        return next;
      };

      if (cmd === "on" || cmd === "off") {
        const next = patch({ autoSpawn: cmd === "on" });
        say(`${PKG}: auto-start agents for new tasks → ${next.autoSpawn ? "ON" : "OFF"}`);
        return;
      }
      if (cmd === "gate") {
        const value = rest[0];
        if (value === "on" || value === "off") {
          const next = patch({ planGate: value === "on" });
          say(`${PKG}: plan gate → ${next.planGate ? "ON" : "OFF"} (blocks at most ${MAX_GATE_BLOCKS} edit attempts)`);
        } else {
          say(`${PKG}: plan gate is ${readSettings().planGate ? "ON" : "OFF"} (\`/agentdeck-flow gate on|off\`)`);
        }
        return;
      }
      if (cmd === "test") {
        const sample = rest.join(" ");
        const { kind, why } = classify(sample);
        say(`classify(${JSON.stringify(sample)})\n  → ${kind}   (${why})`);
        return;
      }

      const s = readSettings();
      const state = tasks.get(sessionId(ctx));
      const lines = [
        `${PKG} flow`,
        `auto-start:  ${s.autoSpawn ? "ON" : "OFF"}   (start explorer/planner/reviewer from the task shape)`,
        `plan gate:   ${s.planGate ? "ON" : "OFF"}   (require a plan before the first edit)`,
        `this task:   ${state ? `${state.kind}${state.planned ? " · planned" : ""}${state.spawnId ? ` · started ${state.spawnId}` : ""}` : "(none yet)"}`,
        `log:         ${join(agentDir(), "agentdeck-flow.jsonl")}`,
        `Commands: /agentdeck-flow on|off · gate on|off · test <text>`,
      ];
      say(lines.join("\n"));
    },
  });
}
