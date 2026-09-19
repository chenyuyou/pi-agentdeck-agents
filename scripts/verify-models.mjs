#!/usr/bin/env node
/**
 * Verify every model pinned in models.json is known to the local pi install.
 * Degrades to a skip when there is no local model catalog.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const overlay = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const storePath = join(agentDir, "models-store.json");

if (!existsSync(storePath)) {
  console.log(`skip: ${storePath} not found (no local model catalog)`);
  process.exit(0);
}

const store = JSON.parse(readFileSync(storePath, "utf8"));
const known = new Set();
for (const [provider, body] of Object.entries(store)) {
  for (const m of body?.models ?? []) known.add(`${provider}/${m.id}`);
}

let missing = 0;
for (const [agent, cfg] of Object.entries(overlay.agents ?? {})) {
  if (!cfg.model) {
    console.log(`-     ${agent}: (no model pin, inherits parent)`);
    continue;
  }
  if (known.has(cfg.model)) console.log(`ok    ${agent}: ${cfg.model}`);
  else {
    missing++;
    console.log(`MISS  ${agent}: ${cfg.model} not in ${storePath}`);
  }
}

console.log(missing ? `\n${missing} pin(s) unavailable locally` : `\nall pins resolve locally`);
process.exit(missing ? 1 : 0);
