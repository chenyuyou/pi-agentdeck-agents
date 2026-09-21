/**
 * supervisor.ts — the macOS Agent Deck supervisor bridge, complete.
 *
 * The app's `contact-supervisor-bridge.ts` gives CHILD agents a
 * `contact_supervisor` tool and gives the PARENT `list_supervisor_requests` /
 * `answer_supervisor_request`. Our v0.3.0 only implemented the child half
 * (fire-and-forget notification); this file implements the full request/answer
 * loop.
 *
 * Semantics
 *   - kind "progress"  → recorded, never blocks. Fire-and-forget.
 *   - kind "question"  → recorded as a PENDING request; the child waits for an
 *     answer (default 180s, `/agentdeck` configurable), then continues. A
 *     timeout returns "decide yourself and note the assumption" rather than
 *     stalling the run.
 *   - kind "blocker"   → same as question, but surfaced as a warning.
 *
 * Transport: a small JSON store at ~/.pi/agent/agentdeck-supervisor-requests.json.
 * The child polls it while waiting; the parent (model or human) writes to it.
 * A file rather than the event bus because background agent runners may live in
 * a different process — this works either way.
 *
 * Self-contained on purpose (no relative imports) — see orchestrator.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PKG = "pi-agentdeck-agents";
const MAX_REQUESTS = 50;
const DEFAULT_TIMEOUT_S = 180;

type RequestRecord = {
  id: string;
  at: string;
  kind: "progress" | "question" | "blocker";
  message: string;
  options: string[];
  cwd: string | null;
  answered: boolean;
  answer?: string;
  answeredAt?: string;
};

type Store = { requests: RequestRecord[] };

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}
const storePath = () => join(agentDir(), "agentdeck-supervisor-requests.json");

function readStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<Store>;
    return { requests: Array.isArray(raw.requests) ? (raw.requests as RequestRecord[]) : [] };
  } catch {
    return { requests: [] };
  }
}

function writeStore(store: Store): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    const trimmed = store.requests.slice(-MAX_REQUESTS);
    writeFileSync(storePath(), JSON.stringify({ requests: trimmed }, null, 2) + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

function settings(): { supervisorTimeoutSeconds: number } {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as {
      supervisorTimeoutSeconds?: number;
    };
    const value = raw.supervisorTimeoutSeconds;
    return { supervisorTimeoutSeconds: typeof value === "number" && value >= 0 ? value : DEFAULT_TIMEOUT_S };
  } catch {
    return { supervisorTimeoutSeconds: DEFAULT_TIMEOUT_S };
  }
}

const newId = () => `sup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function pending(store: Store): RequestRecord[] {
  return store.requests.filter((r) => r.kind !== "progress" && !r.answered);
}

export default function (pi: ExtensionAPI) {
  /* ------------------------------------------------------------ child side */

  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact supervisor",
    description:
      "Ask the supervising session a focused question, raise a blocker, or report progress. " +
      "kind=progress returns immediately. kind=question/blocker waits for an answer (default 180s) " +
      "and returns it; on timeout, decide yourself and record the assumption. " +
      "Use progress for decisions (not narration) and keep messages short.",
    promptSnippet: "Report progress, ask a focused question, or raise a blocker to the supervisor",
    promptGuidelines: [
      "Use contact_supervisor when a decision needs a human product/architecture call, or when a blocker " +
        "means you cannot safely continue. One focused message, not routine narration.",
    ],
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("progress"), Type.Literal("question"), Type.Literal("blocker")]),
      message: Type.String({ description: "One focused message. Plain text, shortest unambiguous form." }),
      options: Type.Optional(
        Type.Array(Type.String({ description: "For kind=question: concrete options you are choosing between." })),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const record: RequestRecord = {
        id: newId(),
        at: new Date().toISOString(),
        kind: params.kind,
        message: params.message,
        options: params.options ?? [],
        cwd: ctx?.cwd ?? null,
        answered: params.kind === "progress",
      };
      const store = readStore();
      store.requests.push(record);
      writeStore(store);

      try {
        pi.events.emit("agentdeck:supervisor", record);
      } catch {
        /* ignore */
      }

      if (params.kind === "progress") {
        return {
          content: [{ type: "text", text: "Progress delivered to supervisor. Continue." }],
          details: { id: record.id, kind: "progress" },
        };
      }

      const timeoutSeconds = settings().supervisorTimeoutSeconds;
      const deadline = Date.now() + timeoutSeconds * 1000;
      const poll = async () => {
        while (Date.now() < deadline) {
          if (signal?.aborted) return undefined;
          const current = readStore().requests.find((r) => r.id === record.id);
          if (current?.answered && typeof current.answer === "string") return current.answer;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return undefined;
      };
      const answer = await poll();

      const text = answer
        ? `Supervisor answered: ${answer}`
        : `No supervisor reply within ${timeoutSeconds}s. Continue with your recommended option and state the assumption you made.`;
      return { content: [{ type: "text", text }], details: { id: record.id, kind: params.kind, answered: Boolean(answer), answer } };
    },
  });

  /* ----------------------------------------------------------- parent side */

  pi.registerTool({
    name: "list_supervisor_requests",
    label: "List supervisor requests",
    description:
      "List questions and blockers that subagents are waiting on. Call this when a subagent may be blocked, " +
      "then answer with answer_supervisor_request. Nothing else unblocks a waiting child.",
    promptSnippet: "List pending questions/blockers from subagents that are waiting for a decision",
    promptGuidelines: [
      "Use list_supervisor_requests when a subagent is waiting, or before asking the user something a child already asked.",
    ],
    parameters: Type.Object({ includeAnswered: Type.Optional(Type.Boolean({ description: "Include already answered requests." })) }),
    async execute(_toolCallId, params) {
      const store = readStore();
      const items = params.includeAnswered ? store.requests : pending(store);
      if (items.length === 0) {
        return { content: [{ type: "text", text: "No pending supervisor requests." }], details: { count: 0 } };
      }
      const lines = items.map((r) => {
        const options = r.options.length ? ` options: [${r.options.join(" | ")}]` : "";
        const state = r.answered ? ` (answered: ${r.answer ?? ""})` : "";
        return `- ${r.id} · ${r.kind} · ${r.message}${options}${state}`;
      });
      return {
        content: [{ type: "text", text: `Supervisor requests:\n${lines.join("\n")}` }],
        details: { count: items.length, ids: items.map((r) => r.id) },
      };
    },
  });

  pi.registerTool({
    name: "answer_supervisor_request",
    label: "Answer supervisor request",
    description: "Answer a pending subagent question or blocker by id. The waiting child receives the text and continues.",
    parameters: Type.Object({
      requestId: Type.String({ description: "Request id from list_supervisor_requests." }),
      answer: Type.String({ description: "The decision or guidance, in one or two sentences." }),
    }),
    async execute(_toolCallId, params) {
      const store = readStore();
      const record = store.requests.find((r) => r.id === params.requestId);
      if (!record) {
        return { content: [{ type: "text", text: `Unknown request id ${params.requestId}.` }], details: { ok: false } };
      }
      record.answered = true;
      record.answer = params.answer;
      record.answeredAt = new Date().toISOString();
      writeStore(store);
      try {
        pi.events.emit("agentdeck:supervisor-answer", { id: record.id, answer: params.answer });
      } catch {
        /* ignore */
      }
      return {
        content: [{ type: "text", text: `Answered ${record.id}. The waiting child will resume with: ${params.answer}` }],
        details: { ok: true, id: record.id },
      };
    },
  });

  /** Human shortcut: answer without going through the model. */
  pi.registerCommand("agentdeck-answer", {
    description: "List or answer pending subagent supervisor requests: /agentdeck-answer [<id> <answer>]",
    handler: async (args, ctx) => {
      const say = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.log(text);
      };
      const raw = (args ?? "").trim();
      if (!raw) {
        const items = pending(readStore());
        if (items.length === 0) {
          say(`${PKG}: no pending supervisor requests`);
          return;
        }
        say(
          `${PKG}: pending requests\n` +
            items
              .map((r) => `- ${r.id} · ${r.kind} · ${r.message}${r.options.length ? ` [${r.options.join(" | ")}]` : ""}`)
              .join("\n") +
            `\nAnswer with: /agentdeck-answer <id> <answer>`,
        );
        return;
      }
      const [id, ...rest] = raw.split(/\s+/);
      const answer = rest.join(" ").trim();
      if (!answer) {
        say(`${PKG}: usage /agentdeck-answer <id> <answer>`, "warning");
        return;
      }
      const store = readStore();
      const record = store.requests.find((r) => r.id === id);
      if (!record) {
        say(`${PKG}: unknown request id ${id}`, "warning");
        return;
      }
      record.answered = true;
      record.answer = answer;
      record.answeredAt = new Date().toISOString();
      writeStore(store);
      say(`${PKG}: answered ${id} → ${answer}`);
    },
  });

  /* --------------------------------------------------- surface new requests */

  pi.on("session_start", async (_event, ctx) => {
    const items = pending(readStore());
    if (items.length && ctx.hasUI) {
      ctx.ui.notify(`${PKG}: ${items.length} subagent request(s) pending — /agentdeck-answer`, "info");
    }
  });
}
