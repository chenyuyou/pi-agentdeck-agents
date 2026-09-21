/**
 * tool-description.ts — inject the agents' `whenToUse` into the Agent TOOL
 * DESCRIPTION (where the model actually reads about agents), not just the
 * system prompt.
 *
 * The macOS Agent Deck app routed the parent session by `whenToUse`. pi's
 * subagent runtime ignores that field, so `orchestrator.ts` injects it as a
 * system-prompt section. This module goes one step further and rewrites the
 * Agent tool description itself, using the runtime's supported extension point:
 * `toolDescriptionMode: "custom"` + `<agentDir>/agent-tool-description.md`.
 *
 * Generated file = upstream's own default description (kept byte-faithful, with
 * its `{{typeList}}` / `{{agentDir}}` placeholders live) + an appended routing
 * section listing each agent's `whenToUse` and model.
 *
 * Notes / limits (inherited from the host extension):
 *   - The description is read once, at tool registration → changes apply on the
 *     NEXT pi session. We therefore generate at load time and on session_start.
 *   - `toolDescriptionMode` lives in `subagents.json`, which we merge rather
 *     than overwrite. If it is `compact`, or `custom` with a file that is not
 *     ours, we back off and leave the user's choice alone.
 *
 * Self-contained on purpose (no relative imports) — see orchestrator.ts.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "<!-- pi-agentdeck-agents:tool-description -->";
const UPSTREAM_EXAMPLE = join("@tintinweb", "pi-subagents", "examples", "agent-tool-description.md");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}
const descriptionPath = () => join(agentDir(), "agent-tool-description.md");
const subagentsPath = () => join(agentDir(), "subagents.json");

type Settings = { toolRouting: boolean };

function settings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir(), "agentdeck.json"), "utf8")) as Partial<Settings>;
    return { toolRouting: typeof raw.toolRouting === "boolean" ? raw.toolRouting : true };
  } catch {
    return { toolRouting: true };
  }
}

/**
 * Agent directories in the runtime's own precedence order (project wins), so the
 * generated description lists exactly the agents that can be dispatched.
 */
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

function frontmatterGet(text: string, key: string): string {
  const fm = text.replace(/^\uFEFF/, "").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return (fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

type AgentMeta = {
  name: string;
  description: string;
  whenToUse: string;
  outcome: string;
  tools: string;
  reads: string;
};

/** Delegation policy wording mirrors the macOS app (light | balanced | strict). */
const POLICY_BULLETS: Record<string, string[]> = {
  light: [
    "- Act primarily as the coordinator for these agents when delegation would clearly improve the result.",
    "- Use the Agent tool for separable specialist work, large investigations, parallel research, or tasks where an available agent is clearly a better fit.",
    "- You may do straightforward implementation, inspection, explanation, and small fixes yourself when delegation would add unnecessary overhead.",
  ],
  balanced: [
    "- Act primarily as the orchestrator: clarify, plan, delegate, supervise, and synthesize results.",
    "- Delegate substantive implementation, investigation, planning, or review work to a relevant agent by default; work directly only for trivial, low-risk one-off changes where delegation would add unnecessary overhead.",
    "- Choose the agent whose routing guidance best matches the task and expected outcome.",
  ],
  strict: [
    "- Act primarily as the orchestrator: clarify, plan, delegate, supervise, and synthesize results.",
    "- For any substantive task, if an available agent could reasonably perform it, delegate it.",
    "- Work directly only for trivial conversational replies, direct user clarification, plan/status updates, synthesis of agent results, or when no listed agent fits.",
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

function readAgentMeta(): AgentMeta[] {
  const out: AgentMeta[] = [];
  const seen = new Set<string>();
  for (const dir of candidateAgentDirs()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const name = frontmatterGet(text, "name") || file.replace(/\.md$/, "");
        if (seen.has(name)) continue; // project shadows global
        seen.add(name);
        out.push({
          name,
          description: frontmatterGet(text, "description"),
          whenToUse: frontmatterGet(text, "whenToUse"),
          outcome: frontmatterGet(text, "defaultExpectedOutcome"),
          tools: frontmatterGet(text, "tools"),
          reads: frontmatterGet(text, "defaultReads"),
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

/** Prefer the installed runtime's own example (stays current); else our copy. */
function baseTemplate(): string {
  for (const candidate of [
    join(agentDir(), "npm", "node_modules", UPSTREAM_EXAMPLE),
    join(process.cwd(), ".pi", "npm", "node_modules", UPSTREAM_EXAMPLE),
    join(ROOT, "templates", "agent-tool-description.md"),
  ]) {
    try {
      if (existsSync(candidate)) {
        const text = readFileSync(candidate, "utf8");
        if (text.trim()) return text.replace(/\s+$/, "");
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

function routingSection(): string | undefined {
  const agents = readAgentMeta();
  if (agents.length === 0) return undefined;
  const policy = policyName();
  const lines = [
    MARKER,
    "",
    "## Agent Deck orchestration",
    "",
    "Delegation happens only through this tool (`subagent_type`). It is not automatic — if you do not call it, nothing is delegated.",
    "",
    ...POLICY_BULLETS[policy],
    "- Fresh agents cannot see this conversation, its context, tool results or earlier agents' findings. Every delegation must be self-contained: goal, requirements, constraints, expected output, useful file reads.",
    "- If you delegate planning to `planner`, convert its returned plan into your own working plan before implementing, unless the user only asked for a report.",
    "- Trust but verify: an agent's summary describes intent, not outcome.",
    "",
    `Choose by role (policy: ${policy}):`,
    "",
  ];
  for (const a of agents) {
    const routing = (a.whenToUse || a.description || "Use when this specialist fits the task.").trim();
    const tools = a.tools
      ? `tools: ${a.tools
          .split(",")
          .map((t) => t.trim().replace(/^ext:[^/]+\//, ""))
          .join(", ")}`
      : "default tools";
    const reads = a.reads
      ? `; reads: ${a.reads
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ")}`
      : "";
    lines.push(`- \`${a.name}\`: ${routing} [outcome: ${a.outcome || "reportOnly"}; ${tools}${reads}]`);
  }
  return lines.join("\n");
}

/** Build the full custom description: upstream default + routing section. */
function buildDescription(): string | undefined {
  const base = baseTemplate();
  const routing = routingSection();
  if (!base) return routing; // vendored/examples file missing: still useful
  if (!routing) return base;
  const lines = base.split("\n");
  const at = lines.findIndex((l) => l.includes("{{typeList}}"));
  if (at === -1) lines.push("", routing);
  else lines.splice(at + 1, 0, "", routing);
  return lines.join("\n") + "\n";
}

type SyncResult = {
  file?: string;
  wroteFile: boolean;
  wroteMode: boolean;
  mode?: string;
  reason?: string;
};

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Generate the file + point the runtime at it. Never clobbers user choices. */
function sync(force = false): SyncResult {
  if (!settings().toolRouting) return { wroteFile: false, wroteMode: false, reason: "disabled by settings" };

  const desired = buildDescription();
  if (!desired) return { wroteFile: false, wroteMode: false, reason: "no template and no agents" };

  const path = descriptionPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  let wroteFile = false;
  const ours = existing === undefined || existing.includes(MARKER);
  if (!ours && !force) {
    return { wroteFile: false, wroteMode: false, reason: `${path} is not ours — left untouched` };
  }
  if (existing !== desired) {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(path, desired, "utf8");
    wroteFile = true;
  }

  const sub = readJson(subagentsPath());
  const current = typeof sub.toolDescriptionMode === "string" ? sub.toolDescriptionMode : "full";
  if (current !== "custom" && current !== "full" && !force) {
    // e.g. "compact" — an explicit choice we must not override.
    return { file: path, wroteFile, wroteMode: false, mode: current, reason: `toolDescriptionMode is "${current}"` };
  }
  let wroteMode = false;
  if (current !== "custom") {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(subagentsPath(), JSON.stringify({ ...sub, toolDescriptionMode: "custom" }, null, 2) + "\n", "utf8");
    wroteMode = true;
  }
  return { file: path, wroteFile, wroteMode, mode: "custom" };
}

/** Revert to the stock description (keeps the file; "full" ignores it). */
function disable(): SyncResult {
  const path = descriptionPath();
  const ours = existsSync(path) && readFileSync(path, "utf8").includes(MARKER);
  if (!ours) return { wroteFile: false, wroteMode: false, reason: "nothing of ours to disable" };
  const sub = readJson(subagentsPath());
  if (sub.toolDescriptionMode !== "custom") {
    return { wroteFile: false, wroteMode: false, mode: String(sub.toolDescriptionMode ?? "full") };
  }
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(subagentsPath(), JSON.stringify({ ...sub, toolDescriptionMode: "full" }, null, 2) + "\n", "utf8");
  return { file: path, wroteFile: false, wroteMode: true, mode: "full" };
}

export default function (pi: ExtensionAPI) {
  let last: SyncResult = { wroteFile: false, wroteMode: false };

  const run = (force = false) => {
    try {
      last = settings().toolRouting ? sync(force) : disable();
    } catch {
      /* best effort — never break startup over a description file */
    }
    return last;
  };

  // Load-time: if our package happens to load first, this lands early enough to
  // be picked up now; otherwise it applies on the next session (documented).
  run();

  pi.on("session_start", async (_event, ctx) => {
    const result = run();
    if (!ctx.hasUI) return;
    if (result.wroteFile || result.wroteMode) {
      ctx.ui.notify(
        `pi-agentdeck-agents: Agent tool description updated (${result.mode ?? "?"}) — applies next pi session`,
        "info",
      );
    }
  });

  pi.registerCommand("agentdeck-tooldesc", {
    description: "Regenerate the Agent tool description with whenToUse routing (or report status)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      const result = arg === "sync" ? run(true) : run();
      const lines = [
        `file:   ${result.file ?? descriptionPath()}`,
        `mode:   ${result.mode ?? "(unchanged)"}`,
        `wrote:  file=${result.wroteFile} mode=${result.wroteMode}`,
        result.reason ? `reason: ${result.reason}` : "",
        "Changes to the Agent tool description apply on the next pi session.",
      ].filter(Boolean);
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      else console.log(lines.join("\n"));
    },
  });
}
