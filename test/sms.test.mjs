import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, hook, missedCall, useFakeTwilio, rows, row, OZB_NUMBER, OWNER, CALLER } from "./helpers.mjs";
import { classify, parseOwnerText, STOP_WORDS } from "../src/rules.js";
import { FORWARDS_PER_SENDER, PAUSED_NOTICE } from "../src/sms.js";

let sid = 0;
const text = (env, from, body, extra = {}) =>
  hook(env, "/sms", { MessageSid: `SM${String(++sid).padStart(32, "9")}`, From: from, To: OZB_NUMBER, Body: body, NumMedia: "0", ...extra });
const tick = () => new Promise((r) => setTimeout(r, 5));
const replies = (fake) => fake.sent().filter((m) => m.To !== OWNER);
const toOwner = (fake) => fake.sent().filter((m) => m.To === OWNER).map((m) => m.Body);

test("Twilio's keywords: recorded, and not answered again when Twilio answers them", async (t) => {
  for (const word of [...STOP_WORDS, "stop", " Stop "]) {
    const fake = useFakeTwilio(t);
    const env = makeEnv();
    addClient(env);
    const res = await text(env, CALLER, word);
    assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    assert.ok(row(env, "SELECT 1 AS x FROM opt_outs WHERE phone = ?", CALLER), word);
    const toCaller = fake.sent().filter((m) => m.To === CALLER);
    assert.equal(toCaller.length, 0, `no confirmation of our own for ${word}`);
    // The owner hears about it.
    assert.match(fake.sent().find((m) => m.To === OWNER).Body, /^From \(412\) 555-0123: .* \(opted out of texts\)$/);
  }
});

test("Twilio's OptOutType (Advanced Opt-Out) means Twilio already answered", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { twilio_opt_out: 0 });
  await text(env, CALLER, "Stop please", { OptOutType: "STOP" });
  assert.ok(row(env, "SELECT 1 AS x FROM opt_outs WHERE phone = ?", CALLER));
  assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 0);
});

test("with Twilio's handling off, this worker confirms STOP once", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { twilio_opt_out: 0 });
  await text(env, CALLER, "STOP");
  const conf = fake.sent().filter((m) => m.To === CALLER);
  assert.equal(conf.length, 1);
  assert.match(conf[0].Body, /^One Zero Backspace: You're unsubscribed/);
});

test("plain-language opt-outs are recorded and confirmed once, and stop all later texts", async (t) => {
  for (const msg of ["stop texting me", "Please stop sending me these", "Opt out", "Don't text me", "remove me from your list", "wrong number", "Wrong number, sorry", "Stop!"]) {
    const fake = useFakeTwilio(t);
    const env = makeEnv();
    addClient(env);
    await text(env, CALLER, msg);
    assert.ok(row(env, "SELECT 1 AS x FROM opt_outs WHERE phone = ?", CALLER), msg);
    const conf = fake.sent().filter((m) => m.To === CALLER);
    assert.equal(conf.length, 1, msg);
    assert.match(conf[0].Body, /You're unsubscribed.*Reply START/);
    // A missed call afterwards gets no text, and the owner's reply isn't sent.
    await missedCall(env);
    await text(env, OWNER, "Sorry about that");
    assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 1, msg);
    assert.match(fake.sent().at(-1).Body, /opted out of texts\. Call them instead\./);
  }
});

test("ordinary messages that mention stop or text aren't opt-outs", () => {
  for (const msg of ["Can you stop by Tuesday and text me the quote?", "Yes please", "The water won't stop", "text me when you're close",
    "I called the wrong number earlier, I meant to book the roof job", "Sorry, I gave you the wrong number for my wife, use 412-555-0188",
    "How do I opt out of the newsletter?"]) {
    assert.equal(classify(msg).kind, "text", msg);
  }
});

test("a text that only mentions a wrong number is passed on with a note, and nobody is opted out", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "I called the wrong number earlier, I meant to book the roof job");
  assert.equal(rows(env, "SELECT * FROM opt_outs").length, 0);
  assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 0);
  assert.deepEqual(toOwner(fake), ["From (412) 555-0123: I called the wrong number earlier, I meant to book the roof job (might be asking to stop texts: check before replying)"]);
  await text(env, OWNER, "No problem, what day works?");
  assert.equal(fake.sent().find((m) => m.To === CALLER).Body, "One Zero Backspace: No problem, what day works?");
});

test("START after STOP opts back in; Twilio answers it, so we don't", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "STOP");
  await text(env, CALLER, "START");
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM opt_outs").n, 0);
  assert.equal(fake.sent().filter((m) => m.To === CALLER).length, 0);
});

test("YES from someone who never opted out is an answer, passed to the owner", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "Yes");
  assert.equal(fake.sent().at(-1).To, OWNER);
  assert.equal(fake.sent().at(-1).Body, "From (412) 555-0123: Yes");
});

test("HELP is answered by Twilio, or by us when Twilio's handling is off, with the published wording", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "HELP");
  assert.equal(fake.sent().length, 0);

  const env2 = makeEnv();
  addClient(env2, { twilio_opt_out: 0 });
  await text(env2, CALLER, "help");
  const help = fake.sent().at(-1);
  assert.equal(help.To, CALLER);
  assert.equal(help.Body, "One Zero Backspace: Missed-call text-back. Msg frequency varies. Msg & data rates may apply. Help: help@onezerobackspace.com or (412) 292-4603. Reply STOP to opt out.");

  await text(env2, CALLER, "STOP");
  await text(env2, CALLER, "START");
  assert.equal(fake.sent().at(-1).Body, "One Zero Backspace: You're subscribed again to replies about your calls. Msg & data rates may apply. Reply STOP to opt out.");
});

test("a caller's text is passed to the owner's cell", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "Need a quote for a website");
  const [m] = fake.sent();
  assert.equal(m.To, OWNER);
  assert.equal(m.From, OZB_NUMBER);
  assert.equal(m.Body, "From (412) 555-0123: Need a quote for a website");
  assert.equal(row(env, "SELECT direction FROM messages WHERE kind = 'forward'").direction, "relay");
});

test("a flood from one sender is held after a few an hour, with one notice; others still get through", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  for (let i = 0; i < FORWARDS_PER_SENDER + 15; i++) await text(env, CALLER, `spam ${i}`);
  await text(env, "+14125550177", "Real customer here");
  const owner = toOwner(fake);
  assert.equal(owner.filter((b) => b.startsWith("From (412) 555-0123:")).length, FORWARDS_PER_SENDER);
  assert.equal(owner.filter((b) => b.startsWith("More texts from (412) 555-0123")).length, 1);
  assert.equal(owner.at(-1), "From (412) 555-0177: Real customer here");
  // Every text is still saved.
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'inbound'").n, FORWARDS_PER_SENDER + 16);
});

test("a picture is mentioned, not forwarded", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "here", { NumMedia: "2" });
  assert.equal(fake.sent()[0].Body, "From (412) 555-0123: here [+2 pictures, not forwarded: see Twilio]");
});

test("a Twilio retry of the same message is handled once", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const fields = { MessageSid: "SM" + "7".repeat(32), From: CALLER, To: OZB_NUMBER, Body: "hello", NumMedia: "0" };
  await hook(env, "/sms", fields);
  await hook(env, "/sms", fields);
  assert.equal(fake.sent().length, 1);
  assert.equal(row(env, "SELECT texts_in FROM usage").texts_in, 1);
});

test("the owner's reply goes to the latest caller the owner heard from, named, with a receipt", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { from: "+14125550111", voicemail: 10 });
  await tick();
  await missedCall(env, { from: CALLER, voicemail: 12 });
  await text(env, OWNER, "On my way, 20 minutes");
  const m = replies(fake).at(-1);
  assert.equal(m.To, CALLER);
  assert.equal(m.From, OZB_NUMBER);
  assert.equal(m.Body, "One Zero Backspace: On my way, 20 minutes");
  assert.equal(row(env, "SELECT direction FROM messages WHERE kind = 'reply'").direction, "relay");
  assert.equal(fake.sent().at(-1).To, OWNER);
  assert.equal(fake.sent().at(-1).Body, "Sent to (412) 555-0123.");
});

test("a reply already starting with the business name isn't named twice", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "Hi");
  await text(env, OWNER, "One Zero Backspace: Hi, this is Ryan.");
  assert.equal(replies(fake).at(-1).Body, "One Zero Backspace: Hi, this is Ryan.");
});

test("a call the owner never heard about can't take over a reply meant for a texter", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "Can you quote the gutter job at 12 Elm St?");
  await tick();
  // A hang-up (or a spoofed call) right after: no voicemail, so the owner never saw it.
  await missedCall(env, { from: "+14125550166", heard: false, seconds: 2 });
  await text(env, OWNER, "Sure, $1,800, I'll be at 12 Elm at 9 tomorrow");
  assert.equal(replies(fake).at(-1).To, CALLER);
  assert.equal(fake.sent().at(-1).Body, "Sent to (412) 555-0123.");
});

test("the owner's reply goes to whoever texted last, even after a call", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { from: "+14125550111", voicemail: 8 });
  await tick();
  await text(env, CALLER, "Are you open Saturday?");
  await text(env, OWNER, "Yes, 9 to 1");
  assert.equal(replies(fake).at(-1).To, CALLER);
  assert.equal(replies(fake).at(-1).Body, "One Zero Backspace: Yes, 9 to 1");
});

test('"To 412-555-0199: message" picks someone else who contacted the line, and later replies follow them', async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, "+14125550199", "Is my estimate ready?");
  await tick();
  await missedCall(env, { from: CALLER, voicemail: 9 });
  await text(env, OWNER, "To (412) 555-0199: Your estimate is ready");
  assert.equal(replies(fake).at(-1).To, "+14125550199");
  assert.equal(replies(fake).at(-1).Body, "One Zero Backspace: Your estimate is ready");
  assert.equal(fake.sent().at(-1).Body, "Sent to (412) 555-0199.");
  await tick();
  await text(env, OWNER, "Call me with questions");
  assert.equal(replies(fake).at(-1).To, "+14125550199");
});

test('"To ..." can\'t reach a number that never called or texted the line (a spoofed owner can\'t use it as a relay)', async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, OWNER, "To 724-555-0100: Your account is locked, call 1-800-555-0000");
  assert.equal(replies(fake).length, 0);
  assert.match(fake.sent().at(-1).Body, /^Not sent: \(724\) 555-0100 hasn't called or texted this line in the last 60 days/);
  // A contact older than 60 days doesn't count either.
  const id = row(env, "SELECT id FROM clients").id;
  env.DB.db.prepare(`INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, at) VALUES (?, 'in', 'inbound', '+17245550100', ?, 'hi', ?)`)
    .run(id, OZB_NUMBER, new Date(Date.now() - 61 * 86400_000).toISOString());
  await text(env, OWNER, "To 724-555-0100: hello");
  assert.equal(replies(fake).length, 0);
});

test("the owner is told when a reply can't go", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, OWNER, "Hello?");
  assert.equal(fake.sent().at(-1).To, OWNER);
  assert.match(fake.sent().at(-1).Body, /^Not sent: no one has called or texted yet/);
  await text(env, OWNER, "To 555: hi");
  assert.match(fake.sent().at(-1).Body, /^Not sent: "555" isn't a US number/);
});

test("anonymous callers are skipped when finding who to reply to", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { from: CALLER, voicemail: 5 });
  await tick();
  await missedCall(env, { from: "+266696687", voicemail: 5 });
  await text(env, OWNER, "Got your message");
  assert.equal(replies(fake).at(-1).To, CALLER);
});

test("owner replies are capped per hour", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "hi");
  const { REPLIES_PER_HOUR } = await import("../src/sms.js");
  for (let i = 0; i <= REPLIES_PER_HOUR; i++) await text(env, OWNER, `reply ${i}`);
  assert.equal(replies(fake).length, REPLIES_PER_HOUR);
  assert.match(fake.sent().at(-1).Body, /^Not sent: over 30 replies in the last hour/);
});

test("parseOwnerText", () => {
  assert.deepEqual(parseOwnerText("To 4125550123: hi there"), { to: "+14125550123", body: "hi there" });
  assert.deepEqual(parseOwnerText("to +1 (412) 555-0123 - hi"), { to: "+14125550123", body: "hi" });
  assert.deepEqual(parseOwnerText("Today at 3: works"), { body: "Today at 3: works" });
  assert.deepEqual(parseOwnerText("Tomorrow is fine"), { body: "Tomorrow is fine" });
  assert.equal(parseOwnerText("To 10:30 works for me").body, "To 10:30 works for me");
  assert.deepEqual(parseOwnerText("To 555: hi"), { error: "bad-number", raw: "555" });
});

test("a paused client's line still honours STOP but passes nothing on", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { status: "paused" });
  await text(env, CALLER, "hello");
  assert.equal(fake.sent().length, 0);
  await text(env, CALLER, "stop texting me");
  assert.ok(row(env, "SELECT 1 AS x FROM opt_outs"));
});

test("a paused client's owner is told, once a day, that replies aren't being sent", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { status: "paused" });
  await text(env, OWNER, "On my way");
  await text(env, OWNER, "Running 5 late");
  assert.deepEqual(fake.sent().map((m) => [m.To, m.Body]), [[OWNER, PAUSED_NOTICE]]);
});

test("status callbacks update the message, never backwards", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  const { twilio_sid: msid } = row(env, "SELECT twilio_sid FROM messages WHERE kind = 'first'");
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "delivered" });
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "sent" });
  assert.equal(row(env, "SELECT status FROM messages WHERE twilio_sid = ?", msid).status, "delivered");
});

test("30032 (number not verified yet) is recorded, and the call doesn't count as texted", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  const { twilio_sid: msid } = row(env, "SELECT twilio_sid FROM messages WHERE kind = 'first'");
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "undelivered", ErrorCode: "30032" });
  const m = row(env, "SELECT * FROM messages WHERE twilio_sid = ?", msid);
  assert.equal(m.status, "undelivered");
  assert.equal(m.error_code, "30032");
  const call = row(env, "SELECT texted, why_not_texted FROM calls");
  assert.deepEqual({ ...call }, { texted: 0, why_not_texted: "undelivered-30032" });
  // A failed text isn't counted as used.
  assert.equal(row(env, "SELECT texts_out FROM usage").texts_out, 0);
  // A repeat of the failure doesn't take it off twice.
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "failed", ErrorCode: "30032" });
  assert.equal(row(env, "SELECT texts_out FROM usage").texts_out, 0);
  // The caller's next call tries again.
  await missedCall(env);
  assert.equal(fake.sent().filter((x) => x.To === CALLER).length, 2);
});

test("a caller's text that can't reach the owner's phone (30032) is emailed instead", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await text(env, CALLER, "Need a quote for a deck");
  const { twilio_sid: msid } = row(env, "SELECT twilio_sid FROM messages WHERE kind = 'forward'");
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "undelivered", ErrorCode: "30032" });
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "undelivered", ErrorCode: "30032" });
  assert.equal(env.EMAIL.sent.length, 1);
  assert.equal(env.EMAIL.sent[0].to, "ryan@onezerobackspace.com");
  assert.match(env.EMAIL.sent[0].text, /^From \(412\) 555-0123: Need a quote for a deck\n\n\(This text couldn't reach your phone: Twilio error 30032/);
});

test("21610 on a status callback records the opt-out", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  const { twilio_sid: msid } = row(env, "SELECT twilio_sid FROM messages WHERE kind = 'first'");
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "failed", ErrorCode: "21610" });
  assert.equal(row(env, "SELECT keyword FROM opt_outs WHERE phone = ?", CALLER).keyword, "error-21610");
});

test("a status callback signed by another account can't touch a message", async (t) => {
  useFakeTwilio(t);
  const { SUB, SUB_TOKEN } = await import("./helpers.mjs");
  const env = makeEnv();
  addClient(env);
  await missedCall(env);
  const { twilio_sid: msid } = row(env, "SELECT twilio_sid FROM messages WHERE kind = 'first'");
  await hook(env, "/status", { MessageSid: msid, MessageStatus: "failed", ErrorCode: "21610" }, { account: SUB, token: SUB_TOKEN });
  assert.equal(row(env, "SELECT status FROM messages WHERE twilio_sid = ?", msid).status, "queued");
  assert.equal(rows(env, "SELECT * FROM opt_outs").length, 0);
});

test("usage counts texts out, texts in and voice minutes for the month", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await missedCall(env, { seconds: 125 });            // 3 minutes, 1 text out
  await text(env, CALLER, "Thanks, call me after 5");  // 1 in, 1 forwarded to the owner
  await text(env, OWNER, "Will do");                   // 1 in, 1 relayed, 1 receipt to the owner
  const u = row(env, "SELECT * FROM usage");
  assert.match(u.month, /^\d{4}-\d{2}$/);
  assert.equal(u.voice_minutes, 3);
  assert.equal(u.texts_out, 4);
  assert.equal(u.texts_in, 2);
});
