#!/usr/bin/env node
/**
 * Verify that the bundled Agent Deck resources are byte-identical to the
 * pinned upstream commit in upstream.lock.json.
 *
 *   node scripts/verify-fidelity.mjs            # verify local files vs lock
 *   node scripts/verify-fidelity.mjs --fetch    # also re-download upstream and compare
 *
 * Exit code 0 = identical, 1 = drift.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "upstream.lock.json"), "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const short = (s) => s.slice(0, 12);

let okLocal = 0;
let okRemote = 0;
const problems = [];

for (const [rel, expected] of Object.entries(lock.files)) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    problems.push(`MISSING  ${rel}`);
    continue;
  }
  const actual = sha256(readFileSync(abs));
  if (actual === expected) okLocal++;
  else problems.push(`DIFFERS  ${rel}\n           expected ${expected}\n           actual   ${actual}`);
}

const fetching = process.argv.includes("--fetch");
if (fetching) {
  const base = `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/agent-deck`;
  const remote = {
    "agents/": "bundled-agents",
    "prompts/": "bundled-prompts",
    "skills/": "bundled-skills",
  };
  for (const rel of Object.keys(lock.files)) {
    const dir = Object.keys(remote).find((d) => rel.startsWith(d));
    const upstreamPath = rel.replace(dir, `${remote[dir]}/`);
    const url = `${base}/${upstreamPath}`;
    const res = await fetch(url);
    if (!res.ok) {
      problems.push(`FETCH ${res.status}  ${url}`);
      continue;
    }
    const actual = sha256(Buffer.from(await res.arrayBuffer()));
    if (actual === lock.files[rel]) okRemote++;
    else problems.push(`UPSTREAM DIFFERS  ${rel}\n           lock     ${lock.files[rel]}\n           upstream ${actual}`);
  }
}

for (const p of problems) console.error(p);
const n = Object.keys(lock.files).length;
console.log(
  `\nlocal:    ${okLocal}/${n} identical\n` +
    (fetching ? `upstream: ${okRemote}/${n} identical\n` : "") +
    `(${lock.repository}@${short(lock.commit)})`,
);
process.exit(problems.length ? 1 : 0);
