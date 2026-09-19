#!/usr/bin/env node
/**
 * Re-baseline the package against a newer upstream revision.
 *
 *   node scripts/rebaseline.mjs                 # pull upstream main into the baseline + lock
 *   node scripts/rebaseline.mjs --ref <sha|vN>  # pin to a specific upstream ref
 *   node scripts/rebaseline.mjs --check         # report drift, write nothing (exit 1 on drift)
 *
 * Only the 12 baseline resources are touched. The overlay (models.json,
 * extensions/) is never modified by this script.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "upstream.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const dryRun = argv.includes("--dry-run") || check;
const refArg = (() => {
  const i = argv.indexOf("--ref");
  return i === -1 ? undefined : argv[i + 1];
})();

const DIR_MAP = {
  "agents/": "bundled-agents",
  "prompts/": "bundled-prompts",
  "skills/": "bundled-skills",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function resolveRef(repo, ref) {
  if (ref && /^[0-9a-f]{7,40}$/i.test(ref)) return ref;
  const url = `https://api.github.com/repos/${repo}/commits/${ref ?? "main"}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`resolve ${ref ?? "main"}: HTTP ${res.status}`);
  return (await res.json()).sha;
}

function upstreamUrl(repo, sha, rel) {
  const dir = Object.keys(DIR_MAP).find((d) => rel.startsWith(d));
  const path = rel.replace(dir, `${DIR_MAP[dir]}/`);
  return `https://raw.githubusercontent.com/${repo}/${sha}/agent-deck/${path}`;
}

const repo = lock.repository;
const sha = await resolveRef(repo, refArg);
console.log(`upstream ${repo}@${sha.slice(0, 12)}${sha === lock.commit ? " (unchanged)" : ""}`);

const changes = [];
const updates = {};

for (const rel of Object.keys(lock.files)) {
  const res = await fetch(upstreamUrl(repo, sha, rel));
  if (!res.ok) {
    console.error(`FETCH ${res.status}  ${rel}`);
    process.exitCode = 1;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== lock.files[rel]) changes.push(rel);
  updates[rel] = { bytes, digest };
}

if (changes.length === 0) {
  console.log("baseline already matches upstream — nothing to do");
  process.exit(process.exitCode ?? 0);
}

console.log(`${changes.length} file(s) changed upstream:`);
for (const rel of changes) console.log(`  ${rel}`);

if (dryRun) {
  console.log("\n--check/--dry-run: no files written");
  process.exit(1);
}

for (const [rel, { bytes, digest }] of Object.entries(updates)) {
  writeFileSync(join(root, rel), bytes);
  lock.files[rel] = digest;
}
lock.commit = sha;
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(`\nre-baselined to ${sha.slice(0, 12)}; upstream.lock.json updated`);
console.log("Review the diff, bump the version, and run: npm run verify:fidelity");
