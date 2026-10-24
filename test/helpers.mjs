// Test helpers: D1 over node:sqlite with this worker's migrations, a fake
// Twilio behind globalThis.fetch (any other host throws: no real network), and
// signed webhook requests. Every SID, token and key here is made up.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/index.js";
import { twilioSignature } from "../src/twilio.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

export const ORIGIN = "https://textback.onezerobackspace.com";
export const MAIN = "AC" + "a".repeat(32);
export const SUB = "AC" + "b".repeat(32);
export const MAIN_TOKEN = "test-main-token";
export const SUB_TOKEN = "test-sub-token";
export const OZB_NUMBER = "+18335550100";
export const OWNER = "+14122924603";
export const CALLER = "+14125550123";

/** D1's API over SQLite. */
export function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { db, prepare: (sql) => stmt(sql) };
}

/**
 * A fake Twilio. Options:
 *   failTo:    { "+1...": { status, code } }  sends to these fail
 *   lineTypes: { "+1...": "landline" }
 *   deleteFails: Set of recording SIDs whose DELETE fails
 *   gone:      Set of recording SIDs that 404
 */
export function fakeTwilio(opts = {}) {
  const calls = [];
  let n = 0;
  const sent = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/Messages.json")).map((c) => ({ account: c.url.match(/Accounts\/(AC\w+)/)[1], ...Object.fromEntries(c.form) }));
  const fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url);
    if (u.hostname !== "api.twilio.com" && u.hostname !== "lookups.twilio.com") throw new Error(`no real network in tests: ${url}`);
    const form = init.body instanceof URLSearchParams ? init.body : new URLSearchParams(init.body || "");
    calls.push({ url, method, form, auth: init.headers?.Authorization });
    if (u.hostname === "lookups.twilio.com") {
      const num = decodeURIComponent(u.pathname.split("/").pop());
      return Response.json({ phone_number: num, line_type_intelligence: { type: opts.lineTypes?.[num] || "mobile" } });
    }
    if (method === "POST" && u.pathname.endsWith("/Messages.json")) {
      const fail = opts.failTo?.[form.get("To")];
      if (fail) return Response.json({ code: fail.code, message: "refused" }, { status: fail.status || 400 });
      return Response.json({ sid: `SM${String(++n).padStart(32, "0")}`, status: "queued" }, { status: 201 });
    }
    const rec = u.pathname.match(/Recordings\/(RE\w+)\.(mp3|json)$/);
    if (rec && method === "DELETE") {
      if (opts.deleteFails?.has(rec[1])) return new Response("boom", { status: 500 });
      return new Response(null, { status: 204 });
    }
    if (rec && method === "GET") {
      if (opts.gone?.has(rec[1])) return new Response("not found", { status: 404 });
      return new Response("ID3-fake-mp3", { headers: { "Content-Type": "audio/mpeg" } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, calls, sent };
}

/** Installs a fake Twilio for one test; returns it. Call restore() after (t.after). */
const REAL_FETCH = globalThis.fetch;
export function useFakeTwilio(t, opts) {
  const fake = fakeTwilio(opts);
  globalThis.fetch = fake.fetch;
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return fake;
}

export function makeEnv(extra = {}) {
  return {
    DB: d1(),
    PUBLIC_ORIGIN: ORIGIN,
    SAY_VOICE: "Polly.Joanna",
    PLAN_TEXTS: "300",
    PLAN_MINUTES: "60",
    TWILIO_ACCOUNT_SID: MAIN,
    TWILIO_AUTH_TOKEN: MAIN_TOKEN,
    [`TWILIO_AUTH_TOKEN_${SUB}`]: SUB_TOKEN,
    TWILIO_API_KEY_SID: "SK" + "c".repeat(32),
    TWILIO_API_KEY_SECRET: "test-key-secret",
    ADMIN_SECRET: "test-admin-secret",
    VM_LINK_KEY: "test-vm-link-key",
    ...extra,
  };
}

export const OZB = {
  name: "One Zero Backspace",
  legal_name: "One Zero Backspace LLC",
  owner_name: "Ryan Lowe",
  owner_cell: OWNER,
  twilio_subaccount_sid: null,
  number: OZB_NUMBER,
  greeting: "Thanks for calling One Zero Backspace. Sorry we missed you. We'll text you at this number about your call. Message and data rates may apply. Reply STOP to opt out. Please leave a message after the beep.",
  first_text: "One Zero Backspace: Sorry we missed your call. Reply here with what you need, or we'll call you back soon. Msg & data rates may apply. Reply STOP to opt out.",
};

/** Inserts a client and returns its id. */
export function addClient(env, c = {}) {
  const row = { ...OZB, status: "active", created_at: new Date().toISOString(), ...c };
  const cols = Object.keys(row);
  const r = env.DB.db.prepare(`INSERT INTO clients (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((k) => row[k]));
  return Number(r.lastInsertRowid);
}

/** A webhook request signed the way Twilio signs it. */
export async function signed(path, fields, { token = MAIN_TOKEN, account = MAIN, signUrl = ORIGIN + path, sendUrl = ORIGIN + path, signature } = {}) {
  const params = new URLSearchParams({ AccountSid: account, ...fields });
  const sig = signature === undefined ? await twilioSignature(token, signUrl, params) : signature;
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (sig !== null) headers["X-Twilio-Signature"] = sig;
  return new Request(sendUrl, { method: "POST", headers, body: params.toString() });
}

export const run = (env, request) => worker.fetch(request, env, { waitUntil() {} });

/** Sends a signed webhook and returns the response. */
export const hook = async (env, path, fields, opts) => run(env, await signed(path, fields, opts));

export const rows = (env, sql, ...args) => env.DB.db.prepare(sql).all(...args);
export const row = (env, sql, ...args) => env.DB.db.prepare(sql).get(...args);

/** A forwarded call that reaches the greeting, then ends after `seconds`. */
export async function missedCall(env, { from = CALLER, to = OZB_NUMBER, sid = "CA" + Math.random().toString(16).slice(2).padEnd(32, "0"), seconds = 20, done = false, account, token } = {}) {
  const opts = account ? { account, token } : undefined;
  const v = await hook(env, "/voice", { CallSid: sid, From: from, To: to, CallStatus: "ringing" }, opts);
  if (done) await hook(env, "/voice/done", { CallSid: sid, From: from, To: to }, opts);
  await hook(env, "/voice/status", { CallSid: sid, From: from, To: to, CallStatus: "completed", CallDuration: String(seconds) }, opts);
  return { sid, voice: v };
}
