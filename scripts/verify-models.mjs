#!/usr/bin/env node
/**
 * Verify every model pinned by the overlay resolves in the local pi catalog,
 * and print its cost. Degrades to a skip when there is no local catalog.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const overlay = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const storePath = join(agentDir, "models-store.json");

function resolveModel(name) {
  const agent = overlay.agents?.[name] ?? {};
  if (agent.model) return agent.model;
  if (agent.tier) return overlay.tiers?.[agent.tier]?.model;
  return undefined;
}

if (!existsSync(storePath)) {
  console.log(`skip: ${storePath} not found (no local model catalog)`);
  for (const name of Object.keys(overlay.agents ?? {})) console.log(`-     ${name}: ${resolveModel(name) ?? "(inherit)"}`);
  process.exit(0);
}

const store = JSON.parse(readFileSync(storePath, "utf8"));
const costs = new Map();
for (const [provider, body] of Object.entries(store)) {
  for (const m of body?.models ?? []) {
    costs.set(`${provider}/${m.id}`, m.cost ?? {});
  }
}

const money = (c) => (c ? `$${c.input ?? "?"}/$${c.output ?? "?"}` : "?/?");

let missing = 0;
for (const name of Object.keys(overlay.agents ?? {})) {
  const model = resolveModel(name);
  if (!model) {
    console.log(`-     ${name.padEnd(9)} (inherit parent)`);
    continue;
  }
  const chain = [model, ...((overlay.agents?.[name]?.fallbackModels ?? []).filter((m) => typeof m === "string"))];
  const bad = chain.filter((m) => !costs.has(m));
  missing += bad.length;
  const shown = chain.map((m, i) => (i === 0 ? m : `~${m}`)).join(" ");
  if (bad.length === 0) {
    console.log(`ok    ${name.padEnd(9)} ${shown.padEnd(40)} ${money(costs.get(model))} per Mtok`);
  } else {
    for (const m of bad) console.log(`MISS  ${name.padEnd(9)} ${m} not in ${storePath}`);
    console.log(`ok    ${name.padEnd(9)} ${shown.padEnd(40)} ${money(costs.get(model))} per Mtok`);
  }
}

console.log(missing ? `\n${missing} model(s) unavailable locally` : `\nall pins and fallbacks resolve locally`);
process.exit(missing ? 1 : 0);
