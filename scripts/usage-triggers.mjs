#!/usr/bin/env node
// Sets up the two monthly spending alarms (Twilio usage triggers on total
// spend) for one Twilio account: SPEND_ALERT_AT emails Ryan, SPEND_PAUSE_AT
// pauses texting to callers (src/spend.js). Run once per account: OZB's main
// account, and each client's subaccount when it's made. A dry run by default.
//
//   node scripts/usage-triggers.mjs                    # main account, dry run
//   node scripts/usage-triggers.mjs AC0123...          # a subaccount, dry run
//   node scripts/usage-triggers.mjs AC0123... --create # make them
//
// Reads TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET from
// ../.env. A trigger whose name already exists on the account is left alone.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CALLBACK = "https://textback.onezerobackspace.com/usage-trigger";

/** What to make on an account: [{ FriendlyName, TriggerValue, ... }]. */
export function triggersFor({ alertAt = 15, pauseAt = 40 } = {}) {
  const base = { CallbackUrl: CALLBACK, CallbackMethod: "POST", UsageCategory: "totalprice", TriggerBy: "price", Recurring: "monthly" };
  return [
    { ...base, FriendlyName: `OZB text-back: alert at $${alertAt}`, TriggerValue: String(alertAt) },
    { ...base, FriendlyName: `OZB text-back: pause texting at $${pauseAt}`, TriggerValue: String(pauseAt) },
  ];
}

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

async function main(argv) {
  const env = readEnv(new URL("../../.env", import.meta.url));
  const account = argv.find((a) => /^AC[0-9a-f]{32}$/i.test(a)) || env.TWILIO_ACCOUNT_SID;
  if (!account || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET) { console.error("Missing TWILIO_ACCOUNT_SID or the API key in ../.env"); return 2; }
  const auth = "Basic " + Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${account}/Usage/Triggers.json`;
  const listed = await fetch(`${url}?PageSize=100`, { headers: { Authorization: auth } });
  if (!listed.ok) { console.error(`Couldn't list triggers on ${account}: ${listed.status} ${await listed.text()}`); return 1; }
  const have = new Set(((await listed.json()).usage_triggers || []).map((t) => t.friendly_name));
  const create = argv.includes("--create");
  for (const t of triggersFor()) {
    if (have.has(t.FriendlyName)) { console.log(`already there: ${t.FriendlyName}`); continue; }
    if (!create) { console.log(`would create on ${account}: ${t.FriendlyName} -> ${t.CallbackUrl}`); continue; }
    const res = await fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(t) });
    if (!res.ok) { console.error(`failed: ${t.FriendlyName}: ${res.status} ${await res.text()}`); return 1; }
    console.log(`created: ${t.FriendlyName} (${(await res.json()).sid})`);
  }
  if (!create) console.log("\nDry run. Add --create to make them.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
