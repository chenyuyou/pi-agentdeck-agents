/**
 * supervisor.ts — the pi-native implementation of the macOS Agent Deck app's
 * `contact_supervisor` tool.
 *
 * Upstream agent files list `contact_supervisor` in `tools:` and their prompts
 * tell the agent to "ask the supervisor one focused question". In the macOS app
 * that tool is provided by a bundled bridge extension; pi had no equivalent, so
 * the tools were effectively missing. This registers the tool for real.
 *
 * Semantics: non-blocking. The message is emitted on pi's shared event bus,
 * appended to a JSONL log, and rendered as a notification by the supervisor-side
 * extension (index.ts). The child continues working; the human can steer it.
 *
 * Canonical extension name (for `ext:` tool selectors): `supervisor`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUPERVISOR_EVENT = "agentdeck:supervisor";

function logPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const base = configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
  return join(base, "agentdeck-supervisor.jsonl");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "contact_supervisor",
    label: "Contact supervisor",
    description:
      "Send a progress update, a focused question, or a blocker to the supervising session. " +
      "Non-blocking: it returns as soon as the message is delivered. Continue working with your " +
      "best judgement rather than waiting for a reply.",
    promptSnippet: "Report progress, ask a focused question, or raise a blocker to the supervisor",
    promptGuidelines: [
      "Use contact_supervisor when you hit a decision that needs a human product/architecture call, " +
        "or when a blocker means you cannot safely continue. Do not use it for routine narration.",
    ],
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("progress"), Type.Literal("question"), Type.Literal("blocker")]),
      message: Type.String({ description: "One focused message. Plain text, shortest form that is unambiguous." }),
      options: Type.Optional(
        Type.Array(Type.String({ description: "For kind=question: concrete options you are choosing between." })),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const record = {
        at: new Date().toISOString(),
        kind: params.kind,
        message: params.message,
        options: params.options ?? [],
        cwd: ctx?.cwd ?? null,
      };

      // Durable, greppable log — independent of whether a TUI is attached.
      try {
        const p = logPath();
        mkdirSync(dirname(p), { recursive: true });
        appendFileSync(p, JSON.stringify(record) + "\n", "utf8");
      } catch {
        /* logging is best-effort */
      }

      // Shared bus: the supervisor-side extension surfaces this to the operator.
      try {
        pi.events.emit(SUPERVISOR_EVENT, record);
      } catch {
        /* ignore */
      }

      const text =
        `Delivered to supervisor (${params.kind}).` +
        (params.kind === "question"
          ? " Continue with your recommended option unless a steering message arrives."
          : " Continue.");
      return { content: [{ type: "text", text }], details: record };
    },
  });
}
