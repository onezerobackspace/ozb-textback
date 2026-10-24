#!/usr/bin/env node
// Adds a client row to ozb_textback. A dry run by default: it checks the
// client and prints the SQL. Nothing is written without a flag.
//
//   node scripts/add-client.mjs scripts/clients/ozb.json             # dry run
//   node scripts/add-client.mjs scripts/clients/ozb.json --local     # local D1 (wrangler dev)
//   node scripts/add-client.mjs scripts/clients/ozb.json --remote    # the real database
//
// The JSON holds the clients columns (see migrations/0001_init.sql). The
// first text must be the exact wording given in the client's toll-free
// verification samples; the greeting must carry the texting disclosure.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { isNanp } from "../src/phone.js";
import { hasDisclosure, firstTextProblems } from "../src/rules.js";

const COLUMNS = ["name", "legal_name", "owner_name", "owner_cell", "twilio_subaccount_sid", "number",
  "greeting", "first_text", "lookup_landlines", "twilio_opt_out", "min_call_seconds", "daily_text_cap", "notes"];

/** What's wrong with a client, as a list of sentences (empty when it's fine). */
export function clientProblems(c) {
  const out = [];
  for (const k of ["name", "legal_name", "owner_name", "greeting", "first_text"]) if (!String(c[k] || "").trim()) out.push(`${k} is required`);
  if (!isNanp(c.owner_cell)) out.push("owner_cell must be a US number in E.164, like +14125550123");
  if (!isNanp(c.number)) out.push("number must be the client's Twilio number in E.164 (buy it first)");
  if (c.owner_cell && c.owner_cell === c.number) out.push("owner_cell and number must differ");
  if (c.twilio_subaccount_sid != null && !/^AC[0-9a-f]{32}$/i.test(c.twilio_subaccount_sid)) out.push("twilio_subaccount_sid must be an AC... SID, or null for the main account");
  if (c.greeting && !hasDisclosure(c.greeting)) out.push("greeting must say a text is coming, that rates may apply, and \"Reply STOP\"");
  if (c.first_text && c.name) out.push(...firstTextProblems(c.first_text, c.name).map((p) => `first_text ${p}`));
  return out;
}

const q = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** The INSERT for a client. */
export function clientSql(c, now = new Date().toISOString()) {
  const cols = COLUMNS.filter((k) => c[k] !== undefined);
  const vals = cols.map((k) => (k === "lookup_landlines" || k === "twilio_opt_out" ? q(c[k] ? 1 : 0) : q(c[k])));
  return `INSERT INTO clients (${[...cols, "status", "created_at"].join(", ")}) VALUES (${[...vals, "'active'", q(now)].join(", ")});`;
}

function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: node scripts/add-client.mjs <client.json> [--local | --remote]"); return 2; }
  const c = JSON.parse(readFileSync(file, "utf8"));
  const problems = clientProblems(c);
  if (problems.length) { console.error("Not added:\n- " + problems.join("\n- ")); return 1; }
  const sql = clientSql(c);
  console.log(sql);
  const where = argv.includes("--remote") ? "--remote" : argv.includes("--local") ? "--local" : null;
  if (!where) { console.log("\nDry run. Add --local or --remote to write it."); return 0; }
  const path = join(mkdtempSync(join(tmpdir(), "textback-")), "client.sql");
  writeFileSync(path, sql + "\n");
  const args = ["wrangler", "d1", "execute", "ozb_textback", where, "--file", path];
  // The remote database is on OZB's account, whose token is in ../.env.
  // Never pass --env-file to a local run.
  if (where === "--remote") args.push("--env-file", "../.env");
  const r = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
