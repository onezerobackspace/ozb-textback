import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, useFakeTwilio, missedCall, run, rows, row, ORIGIN, OZB_NUMBER, CALLER } from "./helpers.mjs";
import worker from "../src/index.js";
import { purgeOld } from "../src/retention.js";
import { clientProblems, clientSql } from "../scripts/add-client.mjs";
import { OZB } from "./helpers.mjs";
import { readFileSync } from "node:fs";

const days = (n) => new Date(Date.now() - n * 86400_000).toISOString();

test("retention deletes calls, texts and recordings older than 90 days, and keeps opt-outs", async (t) => {
  const fake = useFakeTwilio(t, { deleteFails: new Set(["RE" + "9".repeat(32)]) });
  const env = makeEnv();
  const id = addClient(env);
  const db = env.DB.db;
  const call = db.prepare(`INSERT INTO calls (client_id, call_sid, from_number, to_number, at, recording_sid) VALUES (?, ?, ?, ?, ?, ?)`);
  call.run(id, "CA-old-rec", CALLER, OZB_NUMBER, days(91), "RE" + "1".repeat(32));
  call.run(id, "CA-old-stuck", CALLER, OZB_NUMBER, days(95), "RE" + "9".repeat(32));
  call.run(id, "CA-old-none", CALLER, OZB_NUMBER, days(120), null);
  call.run(id, "CA-new", CALLER, OZB_NUMBER, days(89), "RE" + "3".repeat(32));
  const msg = db.prepare(`INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, at) VALUES (?, 'out', 'first', ?, ?, 'x', ?)`);
  msg.run(id, OZB_NUMBER, CALLER, days(91));
  msg.run(id, OZB_NUMBER, CALLER, days(10));
  db.prepare("INSERT INTO opt_outs (client_id, phone, at, keyword) VALUES (?, ?, ?, 'STOP')").run(id, CALLER, days(400));
  db.prepare("INSERT INTO usage (client_id, month, texts_out) VALUES (?, '2025-01', 5)").run(id);

  const r = await purgeOld(env);
  assert.equal(r.recordings, 1);
  const deletes = fake.calls.filter((c) => c.method === "DELETE").map((c) => c.url.match(/Recordings\/(RE\w+)/)[1]);
  assert.deepEqual(deletes.sort(), ["RE" + "1".repeat(32), "RE" + "9".repeat(32)], "only old recordings, and only ones we know");
  assert.deepEqual(rows(env, "SELECT call_sid FROM calls ORDER BY call_sid").map((x) => x.call_sid), ["CA-new", "CA-old-stuck"],
    "a recording Twilio wouldn't delete keeps its row for tomorrow's try");
  assert.equal(rows(env, "SELECT * FROM messages").length, 1);
  assert.equal(rows(env, "SELECT * FROM opt_outs").length, 1);
  assert.equal(rows(env, "SELECT * FROM usage").length, 1);
});

test("the cron runs the retention job", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  env.DB.db.prepare(`INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, at) VALUES (?, 'out', 'first', 'a', 'b', 'x', ?)`).run(id, days(100));
  const waits = [];
  const log = console.log;
  console.log = () => {};
  try {
    await worker.scheduled({ cron: "15 7 * * *" }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  } finally { console.log = log; }
  assert.equal(rows(env, "SELECT * FROM messages").length, 0);
});

test("the cron in wrangler.toml is the one documented", () => {
  assert.match(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"), /crons = \["15 7 \* \* \*"\]/);
});

const adminReq = (path, { secret = "test-admin-secret", method = "GET", body } = {}) => new Request(ORIGIN + path, {
  method, headers: { ...(secret != null ? { "x-admin-secret": secret } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test("admin endpoints need the secret", async () => {
  const env = makeEnv();
  addClient(env);
  assert.equal((await run(env, adminReq("/admin/clients", { secret: null }))).status, 401);
  assert.equal((await run(env, adminReq("/admin/clients", { secret: "wrong" }))).status, 401);
  assert.equal((await run(env, adminReq("/admin/usage", { secret: "" }))).status, 401);
  // An unset ADMIN_SECRET never matches, not even an empty header.
  assert.equal((await run({ ...env, ADMIN_SECRET: "" }, adminReq("/admin/clients", { secret: "" }))).status, 401);
  const ok = await run(env, adminReq("/admin/clients"));
  assert.equal(ok.status, 200);
  const { clients } = await ok.json();
  assert.equal(clients[0].name, "One Zero Backspace");
});

test("admin usage reports the month against the plan's allowance", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  await missedCall(env, { seconds: 30 });
  const month = row(env, "SELECT month FROM usage").month;
  env.DB.db.prepare("UPDATE usage SET texts_out = 290, texts_in = 15, voice_minutes = 61 WHERE client_id = ?").run(id);
  const res = await run(env, adminReq(`/admin/usage?month=${month}`));
  const data = await res.json();
  assert.deepEqual(data.allowance, { texts: 300, minutes: 60 });
  assert.equal(data.clients[0].texts, 305);
  assert.equal(data.clients[0].over_texts, 5);
  assert.equal(data.clients[0].over_minutes, 1);
  assert.equal((await run(env, adminReq("/admin/usage?month=Oct"))).status, 400);
});

test("admin can pause and resume a client", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  assert.equal((await run(env, adminReq(`/admin/clients/${id}/status`, { method: "POST", body: { status: "paused" } }))).status, 200);
  assert.equal(row(env, "SELECT status FROM clients").status, "paused");
  assert.ok(row(env, "SELECT paused_at FROM clients").paused_at);
  await missedCall(env);
  assert.equal(fake.sent().length, 0);
  await run(env, adminReq(`/admin/clients/${id}/status`, { method: "POST", body: { status: "active" } }));
  assert.equal(row(env, "SELECT paused_at FROM clients").paused_at, null);
  assert.equal((await run(env, adminReq(`/admin/clients/${id}/status`, { method: "POST", body: { status: "gone" } }))).status, 400);
  assert.equal((await run(env, adminReq(`/admin/clients/999/status`, { method: "POST", body: { status: "paused" } }))).status, 404);
});

test("add-client checks the client and builds the INSERT", () => {
  const good = { ...OZB };
  assert.deepEqual(clientProblems(good), []);
  const sql = clientSql(good, "2026-10-23T00:00:00Z");
  assert.match(sql, /^INSERT INTO clients \(name, legal_name, owner_name, owner_cell, twilio_subaccount_sid, number, greeting, first_text, status, created_at\)/);
  assert.match(sql, /We''ll text you at this number/);
  assert.match(sql, /NULL/);

  const bad = clientProblems({ ...OZB, number: "", greeting: "Hi, leave a message.", first_text: "Sorry we missed you! 20% off this week" });
  assert.ok(bad.some((p) => p.startsWith("number ")));
  assert.ok(bad.some((p) => p.startsWith("greeting ")));
  assert.ok(bad.some((p) => p.includes("names the business")));
  assert.ok(bad.some((p) => p.includes("Reply STOP")));
  assert.ok(bad.some((p) => p.includes("offer")));
});

test("OZB's own client file passes everything but the number, which isn't bought yet", () => {
  const ozb = JSON.parse(readFileSync(new URL("../scripts/clients/ozb.json", import.meta.url), "utf8"));
  assert.deepEqual(clientProblems(ozb), ["number must be the client's Twilio number in E.164 (buy it first)"]);
  assert.deepEqual(clientProblems({ ...ozb, number: OZB_NUMBER }), []);
  assert.equal(ozb.first_text, OZB.first_text, "the tests use the real first text");
  assert.ok(ozb.first_text.length <= 160, `one segment: ${ozb.first_text.length} characters`);
});
