/**
 * loop.ts — the macOS app's **Loops**, in its recommended shape:
 * Analyze → Fix → Validate, with a goal, a validation command, an iteration cap
 * and a run artifact (see agent-deck-documentation/concepts/loops.md).
 *
 * The app runs loops as app-managed orchestration over native agent runs; here
 * the same cycle is driven from pi with the subagent runtime's spawn RPC plus
 * its completion events. A loop is *user-launched* — nothing here fires on its
 * own — which is exactly the app's stance: heuristic auto-start is not part of
 * its design.
 *
 *   /agentdeck-loop <goal>        run Analyze → Fix → Validate until it passes
 *   /agentdeck-loop status        show the current run
 *   /agentdeck-loop stop          abort after the in-flight step
 *
 * Settings (in ~/.pi/agent/agentdeck.json):
 *   { "loop": { "command": "npm test", "maxIterations": 3, "maker": "general-purpose", "stepTimeoutSeconds": 900 } }
 *
 * Self-contained on purpose (no relative imports) — see orchestrator.ts.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);

type LoopSettings = { command: string; maxIterations: number; maker: string; stepTimeoutSeconds: number };

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

function loopSettings(): LoopSettings {
  const fallback: LoopSettings = {
    command: "",
    maxIterations: 3,
    maker: "general-purpose",
    stepTimeoutSeconds: 900,
  };
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as { loop?: Partial<LoopSettings> };
    const loop = raw.loop ?? {};
    return {
      command: typeof loop.command === "string" ? loop.command : fallback.command,
      maxIterations:
        typeof loop.maxIterations === "number" && loop.maxIterations > 0
          ? Math.min(loop.maxIterations, 10)
          : fallback.maxIterations,
      maker: typeof loop.maker === "string" && loop.maker.trim() ? loop.maker.trim() : fallback.maker,
      stepTimeoutSeconds:
        typeof loop.stepTimeoutSeconds === "number" && loop.stepTimeoutSeconds > 0
          ? loop.stepTimeoutSeconds
          : fallback.stepTimeoutSeconds,
    };
  } catch {
    return fallback;
  }
}

type Step = { phase: "analyze" | "fix" | "validate" | "done"; iteration: number; agentId?: string; note: string; at: string };
type Run = {
  id: string;
  goal: string;
  cwd: string;
  startedAt: string;
  iteration: number;
  phase: Step["phase"];
  steps: Step[];
  plan?: string;
  validation?: { command: string; ok: boolean; output: string };
  stopRequested?: boolean;
  finished?: boolean;
  outcome?: string;
};

function runPath(id: string): string {
  return join(agentDir(), "agentdeck-loop", `${id}.json`);
}

function persist(run: Run, ctx?: ExtensionContext): void {
  try {
    const p = runPath(run.id);
    mkdirSync(join(agentDir(), "agentdeck-loop"), { recursive: true });
    writeFileSync(p, JSON.stringify(run, null, 2) + "\n", "utf8");
  } catch {
    /* best effort */
  }
  if (ctx?.hasUI) {
    const last = run.steps[run.steps.length - 1];
    if (last) ctx.ui.notify(`${PKG} loop ${run.id}: ${last.note}`, "info");
  }
}

export default function (pi: ExtensionAPI) {
  const runs = new Map<string, Run>();
  let active: Run | undefined;
  const waiters = new Map<string, (e: { status?: string; result?: unknown; error?: unknown }) => void>();

  /* -- completion plumbing -------------------------------------------------- */

  for (const channel of ["subagents:completed", "subagents:failed"]) {
    pi.events.on(channel, (raw: unknown) => {
      const data = raw as { id?: string; status?: string; result?: unknown; error?: unknown } | undefined;
      if (!data?.id) return;
      const waiter = waiters.get(data.id);
      if (!waiter) return;
      waiters.delete(data.id);
      waiter(data);
    });
  }

/* Overlay helpers: per-agent fallback chains + defaultReads (self-contained). */
function packageRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return "";
  }
}

function fallbacksFor(type: string): string[] {
  try {
    const root = packageRoot();
    if (!root) return [];
    const overlay = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as {
      agents?: Record<string, { fallbackModels?: unknown }>;
    };
    const list = overlay.agents?.[type]?.fallbackModels;
    return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string" && !!m.trim()) : [];
  } catch {
    return [];
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

function readsFor(type: string): string[] {
  try {
    const base =
      process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const text = readFileSync(join(base, "agents", `${type}.md`), "utf8");
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

const spawn = (
    type: string,
    prompt: string,
    ctx: ExtensionContext,
    description?: string,
    modelOverride?: string,
  ): Promise<{ id?: string; error?: string }> =>
    new Promise((resolve) => {
      const requestId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const channel = `subagents:rpc:spawn:reply:${requestId}`;
      let settled = false;
      const unsub = pi.events.on(channel, (raw: unknown) => {
        settled = true;
        try {
          if (typeof unsub === "function") unsub();
        } catch {
          /* ignore */
        }
        const reply = raw as { success?: boolean; data?: { id?: string }; error?: string };
        if (reply?.success && reply.data?.id) resolve({ id: reply.data.id });
        else resolve({ error: reply?.error ?? "no reply from subagent runtime" });
      });
      try {
        // description is required: the runtime renders record.description verbatim
        // and an unset value shows up in the UI as the literal string "undefined".
        const options: Record<string, unknown> = {
          runInBackground: true,
          description: description ?? type,
        };
        if (modelOverride) options.model = modelOverride;
        pi.events.emit("subagents:rpc:spawn", { requestId, type, prompt, options });
      } catch (err) {
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
        resolve({ error: "no reply from subagent runtime" });
      }, 10_000);
    });

  const MODEL_ERROR_RE = /model|auth|api key|oauth|unavailable|not found|resolve|scope|thinking|provider/i;

  const waitFor = (id: string, timeoutMs: number): Promise<{ status?: string; result?: unknown; error?: unknown } | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve(undefined);
      }, timeoutMs);
      waiters.set(id, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });

  const runStep = async (run: Run, type: string, prompt: string, ctx: ExtensionContext, note: string) => {
    run.steps.push({ phase: run.phase, iteration: run.iteration, note, at: new Date().toISOString() });
    persist(run, ctx);
    const description = `loop ${run.phase}: ${run.goal.replace(/\s+/g, " ").trim().slice(0, 44)}`;
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
    if (candidates.length === 0) candidates.push(undefined);
    let id: string | undefined;
    let lastError: string | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const result = await spawn(type, prompt, ctx, description, candidates[i]);
      if (result.id) {
        id = result.id;
        break;
      }
      lastError = result.error;
      const next = candidates[i + 1];
      if (next === undefined || !(lastError && MODEL_ERROR_RE.test(lastError))) break;
      run.steps.push({
        phase: run.phase,
        iteration: run.iteration,
        note: `model failed, retrying ${type} with ${next}`,
        at: new Date().toISOString(),
      });
      persist(run, ctx);
      if (ctx.hasUI) ctx.ui.notify(`${PKG} loop: model failed, retrying ${type} with ${next}`, "warning");
    }
    if (!id) {
      if (ctx.hasUI) ctx.ui.notify(`${PKG} loop: could not start ${type} (${lastError ?? "no id"})`, "warning");
      return undefined;
    }
    run.steps[run.steps.length - 1].agentId = id;
    persist(run, ctx);
    const settings = loopSettings();
    const event = await waitFor(id, settings.stepTimeoutSeconds * 1000);
    if (!event) {
      if (ctx.hasUI) ctx.ui.notify(`${PKG} loop: ${type} did not report back in time`, "warning");
      return undefined;
    }
    const resultText = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
    return { ok: event.status !== "error" && event.status !== "aborted" && event.status !== "stopped", text: resultText };
  };

  const validate = (command: string, cwd: string): { ok: boolean; output: string } => {
    if (!command.trim()) return { ok: true, output: "(no validation command configured)" };
    try {
      const out = execSync(command, { cwd, encoding: "utf8", timeout: 10 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, output: String(out).slice(-4000) };
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
      const text = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message || "command failed";
      return { ok: false, output: String(text).slice(-4000) };
    }
  };

  const execute = async (run: Run, ctx: ExtensionContext) => {
    const settings = loopSettings();
    try {
      for (run.iteration = 1; run.iteration <= settings.maxIterations; run.iteration++) {
        if (run.stopRequested) break;

        if (run.iteration === 1) {
          run.phase = "analyze";
          const reads = readsFor("planner");
          const analysis = await runStep(
            run,
            "planner",
            [
              "[agentdeck-loop] Analyse this goal and produce an implementation plan.",
              "Include: goal and non-goals, approach and why, files to change, ordered steps, risks, and how to verify.",
              "Do not edit files.",
              ...(reads.length
                ? ["", `Read these files first if present (they carry prior context): ${reads.join(", ")}`]
                : []),
              "",
              `Goal: ${run.goal}`,
            ].join("\n"),
            ctx,
            `iteration ${run.iteration}: asking planner for a plan`,
          );
          if (analysis?.text) run.plan = analysis.text;
        }

        run.phase = "fix";
        const previous = run.validation && !run.validation.ok ? run.validation.output : "";
        const fix = await runStep(
          run,
          settings.maker,
          [
            "[agentdeck-loop] Implement the change for this goal, then stop.",
            "Work only in the current repository. Keep the change scoped and run the project's own tests if they exist.",
            "",
            `Goal: ${run.goal}`,
            run.plan ? `\nPlan to follow:\n${run.plan.slice(0, 6000)}` : "",
            previous ? `\nThe previous attempt failed validation:\n${previous.slice(0, 3000)}\nFix the cause, not the symptom.` : "",
          ].join("\n"),
          ctx,
          `iteration ${run.iteration}: asking ${settings.maker} to implement`,
        );
        if (!fix) {
          run.outcome = "maker step failed";
          break;
        }

        run.phase = "validate";
        const check = validate(settings.command, run.cwd);
        run.validation = { command: settings.command, ok: check.ok, output: check.output };
        persist(run, ctx);
        if (check.ok) {
          run.outcome = settings.command.trim()
            ? `validation passed (${settings.command})`
            : "maker finished (no validation command configured)";
          break;
        }
        run.outcome = `validation still failing after iteration ${run.iteration}`;
      }
      if (run.stopRequested) run.outcome = "stopped by user";
    } catch (err) {
      run.outcome = `loop error: ${String(err)}`;
    } finally {
      run.phase = "done";
      run.finished = true;
      persist(run, ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`${PKG} loop ${run.id} finished: ${run.outcome ?? "done"}`, run.outcome?.includes("passed") ? "info" : "warning");
      }
      active = undefined;
    }
  };

  /* -- commands ------------------------------------------------------------- */

  pi.registerCommand("agentdeck-loop", {
    description: "Run an Analyze→Fix→Validate loop: /agentdeck-loop <goal> | status | stop",
    handler: async (args, ctx) => {
      const settings = loopSettings();
      const raw = (args ?? "").trim();
      const say = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.log(text);
      };
      const mode = String((ctx as { mode?: string }).mode ?? "tui");

      if (raw === "status") {
        if (!active) {
          say(`${PKG} loop: no run in progress`);
          return;
        }
        const { id, goal, iteration, phase, outcome } = active;
        say(`${PKG} loop ${id}\n  goal: ${goal}\n  iteration ${iteration}/${settings.maxIterations} · phase ${phase}${outcome ? ` · ${outcome}` : ""}`);
        return;
      }
      if (raw === "stop") {
        if (!active) {
          say(`${PKG} loop: nothing to stop`);
          return;
        }
        active.stopRequested = true;
        persist(active, ctx);
        say(`${PKG} loop ${active.id}: stopping after the in-flight step`);
        return;
      }
      if (!raw) {
        say(
          `${PKG} loop settings\n  validation: ${settings.command || "(none — the loop stops after the maker step)"}\n` +
            `  maker:      ${settings.maker}\n  iterations: ${settings.maxIterations}\n` +
            `  Usage: /agentdeck-loop <goal> | status | stop\n  Configure via ~/.pi/agent/agentdeck.json → loop { command, maker, maxIterations }`,
        );
        return;
      }
      if (active) {
        say(`${PKG} loop ${active.id} is still running — /agentdeck-loop stop first`, "warning");
        return;
      }
      if (!INTERACTIVE_MODES.has(mode)) {
        say(`${PKG} loop: only available in interactive sessions (mode: ${mode})`, "warning");
        return;
      }

      const run: Run = {
        id: `loop-${Date.now().toString(36)}`,
        goal: raw,
        cwd: ctx.cwd,
        startedAt: new Date().toISOString(),
        iteration: 1,
        phase: "analyze",
        steps: [],
      };
      runs.set(run.id, run);
      active = run;
      persist(run, ctx);
      say(
        `${PKG} loop ${run.id} started\n  goal: ${raw}\n  maker: ${settings.maker} · max ${settings.maxIterations} iteration(s)\n` +
          `  validation: ${settings.command || "(none)"}\n  /agentdeck-loop status · stop`,
      );
      void execute(run, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    // Discovery hint until the first loop run creates the dir (fresh installs
    // need it most; after that /agentdeck-loop status covers visibility).
    const dir = join(agentDir(), "agentdeck-loop");
    if (existsSync(dir)) return;
    const settings = loopSettings();
    ctx.ui.notify(
      `${PKG} loop ready — /agentdeck-loop <goal> (maker: ${settings.maker}${settings.command ? `, validation: ${settings.command}` : ", no validation command"})`,
      "info",
    );
  });
}
