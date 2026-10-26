import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, useFakeTwilio, missedCall, hook, run, rows, row, ORIGIN, OZB_NUMBER, OWNER, CALLER, MAIN, newCallSid } from "./helpers.mjs";
import { overageOf, usageWarnings } from "../src/spend.js";
import { triggersFor } from "../scripts/usage-triggers.mjs";
import { FORWARDS_PER_DAY } from "../src/sms.js";
import { CALLS_PER_HOUR, FLOOD_MESSAGE, SAFE_MESSAGE } from "../src/voice.js";
import { easternMonth } from "../src/store.js";

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ALERTS = { ALERT_TO: "ryan@alerts.test", SPEND_ALERT_AT: "15", SPEND_PAUSE_AT: "40" };

test("overage: 3¢ a text and 5¢ a minute over the plan, not charged under $5", () => {
  const plan = { texts: 300, minutes: 60 };
  assert.deepEqual(overageOf(250, 30, plan), { overTexts: 0, overMinutes: 0, amount: 0, charged: false });
  assert.deepEqual(overageOf(400, 60, plan), { overTexts: 100, overMinutes: 0, amount: 3, charged: false });
  assert.deepEqual(overageOf(500, 80, plan), { overTexts: 200, overMinutes: 20, amount: 7, charged: true });
});

test("the usage-trigger script makes a $15 alert and a $40 pause, monthly, on total spend", () => {
  const [alert, pause] = triggersFor();
  assert.equal(alert.TriggerValue, "15");
  assert.equal(pause.TriggerValue, "40");
  for (const t of [alert, pause]) {
    assert.equal(t.UsageCategory, "totalprice");
    assert.equal(t.Recurring, "monthly");
    assert.equal(t.TriggerBy, "price");
    assert.equal(t.CallbackUrl, `${ORIGIN}/usage-trigger`);
  }
});

test("a day's forwarded texts are capped, and the owner is told once", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  const ins = env.DB.db.prepare("INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, at) VALUES (?, 'relay', 'forward', ?, ?, 'From x: hi', ?)");
  for (let i = 0; i < FORWARDS_PER_DAY; i++) ins.run(id, OZB_NUMBER, OWNER, ago(2 + (i % 20)));
  await hook(env, "/sms", { MessageSid: "SM" + "7".repeat(32), From: CALLER, To: OZB_NUMBER, Body: "hello?" });
  await hook(env, "/sms", { MessageSid: "SM" + "8".repeat(32), From: CALLER, To: OZB_NUMBER, Body: "hello again" });
  const toOwner = fake.sent().filter((m) => m.To === OWNER);
  assert.equal(toOwner.length, 1);
  assert.match(toOwner[0].Body, /aren't being passed on until tomorrow/);
});

test("a flood of calls gets a short goodbye with no voicemail, and isn't texted", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  const ins = env.DB.db.prepare("INSERT INTO calls (client_id, call_sid, from_number, to_number, at) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < CALLS_PER_HOUR; i++) ins.run(id, newCallSid(), "+14125550100", OZB_NUMBER, ago(0.5));
  const sid = newCallSid();
  const res = await hook(env, "/voice", { CallSid: sid, From: CALLER, To: OZB_NUMBER, CallStatus: "ringing" });
  const twimlText = await res.text();
  assert.ok(twimlText.includes(FLOOD_MESSAGE));
  assert.ok(!twimlText.includes("<Record"));
  assert.equal(row(env, "SELECT why_not_texted FROM calls WHERE call_sid = ?", sid).why_not_texted, "call-flood");
});

test("the $15 alarm emails Ryan once and pauses nothing", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv(ALERTS);
  const id = addClient(env);
  const fire = () => hook(env, "/usage-trigger", { UsageTriggerSid: "UT" + "1".repeat(32), TriggerValue: "15", CurrentValue: "15.42", UsageCategory: "totalprice", IdempotencyToken: "tok-15" });
  assert.equal((await fire()).status, 204);
  assert.equal((await fire()).status, 204, "Twilio's retry");
  const mails = env.EMAIL.sent.filter((m) => m.to === "ryan@alerts.test");
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Text-back spend alert: One Zero Backspace \(\$15\.42/);
  assert.equal(row(env, "SELECT texts_paused_at FROM clients WHERE id = ?", id).texts_paused_at, null);
});

test("an unsigned usage-trigger call is refused", async () => {
  const env = makeEnv(ALERTS);
  addClient(env);
  const res = await run(env, new Request(`${ORIGIN}/usage-trigger`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `AccountSid=${MAIN}&TriggerValue=40` }));
  assert.equal(res.status, 403);
});

test("the $40 alarm pauses texting to callers: the greeting stops promising a text, voicemail still works, and it resumes from /admin", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv(ALERTS);
  const id = addClient(env);
  await hook(env, "/usage-trigger", { UsageTriggerSid: "UT" + "2".repeat(32), TriggerValue: "40", CurrentValue: "40.10", UsageCategory: "totalprice", IdempotencyToken: "tok-40" });
  const c = row(env, "SELECT texts_paused_at, texts_paused_why FROM clients WHERE id = ?", id);
  assert.ok(c.texts_paused_at);
  assert.match(c.texts_paused_why, /\$40\.10/);
  assert.ok(env.EMAIL.sent.some((m) => /^Texting paused: One Zero Backspace/.test(m.subject)));

  const sid = newCallSid();
  const v = await (await hook(env, "/voice", { CallSid: sid, From: CALLER, To: OZB_NUMBER, CallStatus: "ringing" })).text();
  assert.ok(v.includes(SAFE_MESSAGE) && v.includes("<Record"), "a plain greeting and the beep");
  assert.ok(!/text you/i.test(v), "no texting promise");
  await hook(env, "/voice/done", { CallSid: sid, From: CALLER, To: OZB_NUMBER });
  await hook(env, "/voice/status", { CallSid: sid, From: CALLER, To: OZB_NUMBER, CallStatus: "completed", CallDuration: "30" });
  assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 0, "no first text");
  assert.equal(row(env, "SELECT why_not_texted FROM calls WHERE call_sid = ?", sid).why_not_texted, "spend-paused");

  // The owner's reply isn't relayed; the owner is told why.
  await hook(env, "/sms", { MessageSid: "SM" + "3".repeat(32), From: OWNER, To: OZB_NUMBER, Body: `To ${CALLER.slice(2)}: on my way` });
  assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 0);
  assert.match(fake.sent().at(-1).Body, /on hold/);

  const res = await run(env, new Request(`${ORIGIN}/admin/clients/${id}/texting`, { method: "POST", headers: { "x-admin-secret": env.ADMIN_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) }));
  assert.equal(res.status, 200);
  assert.equal(row(env, "SELECT texts_paused_at FROM clients WHERE id = ?", id).texts_paused_at, null);
  await missedCall(env, { from: "+14125550177" });
  assert.equal(fake.sent().filter((m) => m.To === "+14125550177").length, 1, "texting again");
});

test("usage emails at 80% and 100% of the plan, once each a month", async () => {
  const env = makeEnv();
  const id = addClient(env);
  const month = easternMonth();
  env.DB.db.prepare("INSERT INTO usage (client_id, month, texts_out, texts_in, voice_minutes) VALUES (?, ?, 150, 95, 10)").run(id, month);
  assert.deepEqual((await usageWarnings(env)).sent, [{ client: id, level: 80 }]);
  assert.match(env.EMAIL.sent.at(-1).subject, /80%/);
  assert.match(env.EMAIL.sent.at(-1).text, /245 of the 300 texts/);
  assert.deepEqual((await usageWarnings(env)).sent, [], "once");
  env.DB.db.prepare("UPDATE usage SET texts_out = 260, texts_in = 140 WHERE client_id = ?").run(id);
  assert.deepEqual((await usageWarnings(env)).sent, [{ client: id, level: 100 }]);
  assert.match(env.EMAIL.sent.at(-1).text, /so far that's \$3\.00/);
  assert.deepEqual((await usageWarnings(env)).sent, []);
});
