import test from "node:test";
import assert from "node:assert/strict";
import {
  makeEnv, addClient, hook, missedCall, useFakeTwilio, rows, row, OZB, OZB_NUMBER, OWNER, CALLER,
} from "./helpers.mjs";
import { DISCLOSURE, hasDisclosure, spokenGreeting, splitGreeting } from "../src/rules.js";
import { CAP_NOTICE } from "../src/send.js";

test("an active client's call gets the greeting through the disclosure, then /voice/heard, then the rest and the beep", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const sid = "CA" + "1".repeat(32);
  const res = await hook(env, "/voice", { CallSid: sid, From: CALLER, To: OZB_NUMBER, StirVerstat: "TN-Validation-Passed-A" });
  assert.equal(res.headers.get("Content-Type"), "text/xml; charset=utf-8");
  const xml = await res.text();
  assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Hi, you&apos;ve reached One Zero Backspace. Sorry we missed your call. ' +
    "We&apos;ll text you at this number about your call. Message and data rates may apply. Reply STOP to opt out.</Say>" +
    '<Redirect method="POST">https://textback.onezerobackspace.com/voice/heard</Redirect></Response>');
  let call = row(env, "SELECT * FROM calls");
  assert.equal(call.from_number, CALLER);
  assert.equal(call.stir_verstat, "TN-Validation-Passed-A");
  assert.equal(call.heard_disclosure, 0);

  const heard = await (await hook(env, "/voice/heard", { CallSid: sid, From: CALLER, To: OZB_NUMBER })).text();
  assert.match(heard, /^<\?xml version="1.0" encoding="UTF-8"\?><Response><Say voice="Polly.Joanna">To leave a voicemail, stay on the line and speak after the tone\.<\/Say><Record /);
  assert.match(heard, /<Record maxLength="120" timeout="5" playBeep="true"/);
  assert.match(heard, /action="https:\/\/textback\.onezerobackspace\.com\/voice\/done"/);
  assert.match(heard, /recordingStatusCallback="https:\/\/textback\.onezerobackspace\.com\/recording"/);
  call = row(env, "SELECT * FROM calls");
  assert.equal(call.heard_disclosure, 1);
  assert.equal(call.texted, 0, "no text during the call");
});

test("splitGreeting cuts after the last part of the disclosure, wherever it is", () => {
  assert.deepEqual(splitGreeting("Thanks for calling Acme."), [`Thanks for calling Acme. ${DISCLOSURE}`, ""]);
  assert.deepEqual(splitGreeting("Acme here. Reply STOP to opt out of texts. We'll text you at this number. Msg and data rates may apply! Leave a message."),
    ["Acme here. Reply STOP to opt out of texts. We'll text you at this number. Msg and data rates may apply!", "Leave a message."]);
});

test("a caller who hangs up during the greeting isn't texted, however long the call lasted", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  for (const seconds of [1, 5, 8, 12]) await missedCall(env, { from: `+1412555010${seconds % 10}`, heard: false, seconds });
  assert.equal(fake.sent().length, 0);
  assert.deepEqual(rows(env, "SELECT DISTINCT why_not_texted FROM calls").map((r) => r.why_not_texted), ["hung-up-in-greeting"]);
});

test("a caller who heard the disclosure and hung up at the beep is texted from the status callback", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { heard: true, done: false, seconds: 14 });
  assert.equal(fake.sent().length, 1);
});

test("a database error at /voice still gives the caller a greeting and the beep, with no texting promise", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const real = env.DB.prepare;
  env.DB = { ...env.DB, prepare: (sql) => { if (sql.includes("INSERT INTO calls")) throw new Error("D1 network connection lost"); return real(sql); } };
  const log = console.log;
  console.log = () => {};
  let xml;
  try {
    xml = await (await hook(env, "/voice", { CallSid: "CA" + "4".repeat(32), From: CALLER, To: OZB_NUMBER })).text();
  } finally { console.log = log; }
  assert.match(xml, /Thanks for calling One Zero Backspace\. Sorry we missed your call\. Please leave a message after the tone\.<\/Say><Record /);
  assert.doesNotMatch(xml, /text you/);
  assert.equal(fake.sent().length, 0);
});

test("any other error in a webhook gets a quiet answer, never a 500", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  env.DB = { ...env.DB, prepare: () => { throw new Error("D1 down"); } };
  const log = console.log;
  console.log = () => {};
  try {
    const voice = await hook(env, "/voice", { CallSid: "CA" + "5".repeat(32), From: CALLER, To: OZB_NUMBER });
    assert.equal(voice.status, 200);
    assert.match(await voice.text(), /Sorry we missed your call\. Please leave a message after the tone\.<\/Say><Record /);
    const heard = await hook(env, "/voice/heard", { CallSid: "CA" + "5".repeat(32) });
    assert.match(await heard.text(), /^<\?xml[^>]*><Response><Record /);
    assert.equal((await hook(env, "/voice/status", { CallSid: "CA" + "5".repeat(32), CallStatus: "completed" })).status, 204);
    assert.equal((await hook(env, "/sms", { MessageSid: "SM" + "5".repeat(32), From: CALLER, To: OZB_NUMBER, Body: "hi" })).status, 200);
  } finally { console.log = log; }
});

test("a greeting without the disclosure gets it added", () => {
  assert.equal(hasDisclosure("Thanks for calling Acme."), false);
  assert.equal(spokenGreeting("Thanks for calling Acme."), `Thanks for calling Acme. ${DISCLOSURE}`);
  assert.equal(spokenGreeting(OZB.greeting), OZB.greeting);
});

test("a paused client's caller hears a short message and the call ends: no record, no text", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { status: "paused", paused_at: "2026-10-20T00:00:00Z" });
  const { voice } = await missedCall(env);
  const xml = await voice.text();
  assert.match(xml, /can&apos;t take your call right now\. Please try again later/);
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<Record/);
  assert.equal(rows(env, "SELECT * FROM calls").length, 0);
  assert.equal(fake.sent().length, 0);
});

test("the first text goes out when the call completes, exactly as written, with a status callback", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { seconds: 25 });
  const sent = fake.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].To, CALLER);
  assert.equal(sent[0].From, OZB_NUMBER);
  assert.equal(sent[0].Body, OZB.first_text);
  assert.equal(sent[0].StatusCallback, "https://textback.onezerobackspace.com/status");
  const call = row(env, "SELECT * FROM calls");
  assert.equal(call.texted, 1);
  assert.equal(call.answered, 1);
  assert.equal(call.seconds, 25);
  assert.equal(row(env, "SELECT kind FROM messages").kind, "first");
});

test("voicemail end and call end both trigger, but only one text goes", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { done: true });
  assert.equal(fake.sent().length, 1);
});

test("a repeat of the status callback doesn't text twice or double-count minutes", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const { sid } = await missedCall(env, { seconds: 61 });
  await hook(env, "/voice/status", { CallSid: sid, From: CALLER, To: OZB_NUMBER, CallStatus: "completed", CallDuration: "61" });
  assert.equal(fake.sent().length, 1);
  assert.equal(row(env, "SELECT voice_minutes FROM usage").voice_minutes, 2);
});

test("one text per caller per 24 hours", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  await missedCall(env);
  assert.equal(fake.sent().length, 1);
  assert.deepEqual(rows(env, "SELECT why_not_texted FROM calls ORDER BY id").map((r) => r.why_not_texted), [null, "recent"]);
});

test("a first text more than 24 hours old doesn't block the next one", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  env.DB.db.prepare(`INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, status, at)
    VALUES (?, 'out', 'first', ?, ?, 'x', 'delivered', ?)`).run(id, OZB_NUMBER, CALLER, new Date(Date.now() - 25 * 3600_000).toISOString());
  await missedCall(env);
  assert.equal(fake.sent().length, 1);
});

test("a first text that failed doesn't count toward the 24 hours", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  env.DB.db.prepare(`INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, status, error_code, at)
    VALUES (?, 'out', 'first', ?, ?, 'x', 'undelivered', '30032', ?)`).run(id, OZB_NUMBER, CALLER, new Date(Date.now() - 3600_000).toISOString());
  await missedCall(env);
  assert.equal(fake.sent().length, 1);
});

test("opted-out callers aren't texted", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  env.DB.db.prepare("INSERT INTO opt_outs (client_id, phone, at, keyword) VALUES (?, ?, ?, 'STOP')").run(id, CALLER, new Date().toISOString());
  await missedCall(env);
  assert.equal(fake.sent().length, 0);
  assert.equal(row(env, "SELECT why_not_texted FROM calls").why_not_texted, "opted-out");
});

test("an opt-out with one client doesn't stop another client's text", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const other = addClient(env, { number: "+18885550111", owner_cell: "+14125550999", name: "Briggs Electric", first_text: "Briggs Electric: Sorry we missed your call. Reply STOP to opt out." });
  env.DB.db.prepare("INSERT INTO opt_outs (client_id, phone, at, keyword) VALUES (?, ?, ?, 'STOP')").run(other, CALLER, new Date().toISOString());
  await missedCall(env);
  assert.equal(fake.sent().length, 1);
});

for (const [label, from, why] of [
  ["anonymous (Twilio's keypad spelling)", "+266696687", "anonymous"],
  ["anonymous (word)", "Anonymous", "anonymous"],
  ["restricted", "+7378742833", "anonymous"],
  ["a short code", "72345", "short-code"],
  ["an international number", "+442071234567", "invalid-number"],
  ["a number with a bad area code", "+11125550123", "invalid-number"],
  ["the owner's own cell", OWNER, "owner"],
  ["the client's own number", OZB_NUMBER, "own-number"],
]) {
  test(`no text to ${label}`, async (t) => {
    const fake = useFakeTwilio(t);
    const env = makeEnv();
    addClient(env);
    await missedCall(env, { from });
    assert.equal(fake.sent().length, 0);
    assert.equal(row(env, "SELECT why_not_texted FROM calls").why_not_texted, why);
  });
}

test("a Canadian caller is texted", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { from: "+14165550123" });
  assert.equal(fake.sent().length, 1);
});

test("a call whose caller ID failed Twilio's check isn't texted; a missing or C attestation is", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { from: "+14125550101", stir: "TN-Validation-Failed-A" });
  await missedCall(env, { from: "+14125550102", stir: "No-TN-Validation" });
  await missedCall(env, { from: "+14125550103", stir: "TN-Validation-Passed-C" });
  await missedCall(env, { from: "+14125550104" });
  assert.deepEqual(fake.sent().map((m) => m.To), ["+14125550102", "+14125550103", "+14125550104"]);
  assert.equal(row(env, "SELECT why_not_texted FROM calls WHERE from_number = '+14125550101'").why_not_texted, "caller-id-failed");
});

test("an hourly cap holds back a burst of first texts, and the owner is told once", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { hourly_text_cap: 2, daily_text_cap: 10 });
  for (const n of ["+14125550101", "+14125550102", "+14125550103", "+14125550104"]) await missedCall(env, { from: n });
  assert.equal(fake.sent().filter((m) => m.To !== OWNER).length, 2);
  assert.deepEqual(fake.sent().filter((m) => m.To === OWNER).map((m) => m.Body), [CAP_NOTICE]);
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM calls WHERE why_not_texted = 'hourly-cap'").n, 2);
});

test("the default caps are small enough to brake a spoofing run", () => {
  const env = makeEnv();
  const id = addClient(env, { daily_text_cap: undefined, hourly_text_cap: undefined });
  const c = row(env, "SELECT daily_text_cap, hourly_text_cap FROM clients WHERE id = ?", id);
  assert.ok(c.daily_text_cap <= 20 && c.hourly_text_cap <= 10, JSON.stringify(c));
});

test("landline lookup is off by default and skips landlines when on", async (t) => {
  const fake = useFakeTwilio(t, { lineTypes: { [CALLER]: "landline" } });
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  assert.equal(fake.calls.filter((c) => c.url.includes("lookups")).length, 0);
  assert.equal(fake.sent().length, 1);

  const env2 = makeEnv();
  addClient(env2, { lookup_landlines: 1 });
  await missedCall(env2);
  assert.equal(fake.calls.filter((c) => c.url.includes("lookups")).length, 1);
  assert.equal(fake.sent().length, 1, "no second text");
  assert.equal(row(env2, "SELECT why_not_texted FROM calls").why_not_texted, "landline");
});

test("a daily cap stops a flood of first texts", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { daily_text_cap: 2 });
  for (const n of ["+14125550101", "+14125550102", "+14125550103"]) await missedCall(env, { from: n });
  assert.equal(fake.sent().filter((m) => m.To !== OWNER).length, 2);
  assert.equal(row(env, "SELECT why_not_texted FROM calls WHERE from_number = '+14125550103'").why_not_texted, "daily-cap");
  assert.deepEqual(fake.sent().filter((m) => m.To === OWNER).map((m) => m.Body), [CAP_NOTICE]);
});

test("a send Twilio refuses with 21610 records an opt-out and doesn't count as texted", async (t) => {
  useFakeTwilio(t, { failTo: { [CALLER]: { status: 400, code: 21610 } } });
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  const call = row(env, "SELECT * FROM calls");
  assert.equal(call.texted, 0);
  assert.equal(call.why_not_texted, "send-failed-21610");
  assert.equal(row(env, "SELECT keyword FROM opt_outs WHERE phone = ?", CALLER).keyword, "error-21610");
  assert.equal(row(env, "SELECT COALESCE(SUM(texts_out), 0) AS n FROM usage").n, 0);
});

test("a subaccount client's text goes through its own account", async (t) => {
  const fake = useFakeTwilio(t);
  const { SUB, SUB_TOKEN } = await import("./helpers.mjs");
  const env = makeEnv();
  addClient(env, { twilio_subaccount_sid: SUB, number: "+18885550111", owner_cell: "+14125550999", name: "Briggs Electric",
    first_text: "Briggs Electric: Sorry we missed your call. Reply STOP to opt out." });
  await missedCall(env, { to: "+18885550111", account: SUB, token: SUB_TOKEN });
  const sent = fake.sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account, SUB);
  assert.equal(sent[0].From, "+18885550111");
});
