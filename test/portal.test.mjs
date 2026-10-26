import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, useFakeTwilio, missedCall, hook, run, rows, row, ORIGIN, OZB_NUMBER, CALLER } from "./helpers.mjs";
import { middleOf, checkWording, FIRST_TEXT_SUFFIX } from "../src/portal.js";
import { OZB } from "./helpers.mjs";

const admin = (env, path, init = {}) => run(env, new Request(ORIGIN + path, {
  ...init, headers: { "x-admin-secret": env.ADMIN_SECRET, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
}));

const MIDDLE = "Sorry we missed your call. Reply here with what you need, or we'll call you back soon.";

test("middleOf takes the business name and the fixed ending off a first text", () => {
  assert.equal(middleOf(OZB.first_text, OZB.name), MIDDLE);
  assert.equal(OZB.first_text, `${OZB.name}: ${MIDDLE} ${FIRST_TEXT_SUFFIX}`);
});

test("checkWording keeps the disclosure, one text and no links", () => {
  const c = { name: "Jacobson Electric" };
  const ok = checkWording(c, { greeting: OZB.greeting, middle: "Sorry we missed you. Reply with what you need and we'll call back." });
  assert.equal(ok.first_text, `Jacobson Electric: Sorry we missed you. Reply with what you need and we'll call back. ${FIRST_TEXT_SUFFIX}`);
  assert.match(checkWording(c, { greeting: "Hi, leave a message.", middle: MIDDLE }).problems[0], /greeting must say a text is coming/);
  assert.match(checkWording(c, { greeting: OZB.greeting, middle: "See jacobsonelectric.com for hours" }).problems.join(" "), /links/);
  assert.match(checkWording(c, { greeting: OZB.greeting, middle: "x".repeat(120) }).problems.join(" "), /one text/);
  assert.match(checkWording(c, { greeting: OZB.greeting, middle: "Hi" }).problems.join(" "), /Say something/);
});

test("the portal overview: usage, recent calls with outcome, reply and voicemail, and wording versions", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  await missedCall(env, { voicemail: 42 });
  await hook(env, "/sms", { MessageSid: "SM" + "1".repeat(32), From: CALLER, To: OZB_NUMBER, Body: "Need a quote for a site" });
  await missedCall(env, { from: "+17245550193", heard: false });

  const res = await admin(env, `/admin/clients/${id}/portal`);
  assert.equal(res.status, 200);
  const o = await res.json();
  assert.equal(o.number, OZB_NUMBER);
  assert.equal(o.middle, MIDDLE);
  assert.equal(o.suffix, FIRST_TEXT_SUFFIX);
  assert.equal(o.calls.length, 2);
  const [hungUp, texted] = o.calls;
  assert.equal(hungUp.outcome, "hung-up-in-greeting");
  assert.equal(hungUp.voicemail_seconds, 0);
  assert.equal(texted.outcome, "texted");
  assert.equal(texted.reply, "Need a quote for a site");
  assert.equal(texted.voicemail_seconds, 42);
  assert.equal(o.calls_this_month, 2);
  assert.ok(o.usage.texts >= 2, "the first text and the reply both count");
  assert.deepEqual(o.usage.allowance, { texts: 300, minutes: 60 });
  // A client added without a version gets its current wording as version 1.
  assert.equal(o.versions.length, 1);
  assert.equal(o.versions[0].by, "Setup");
  assert.equal(o.versions[0].current, true);
});

test("needs the admin secret", async () => {
  const env = makeEnv();
  const id = addClient(env);
  const res = await run(env, new Request(`${ORIGIN}/admin/clients/${id}/portal`));
  assert.equal(res.status, 401);
});

test("saving wording updates what callers get, keeps a version, and the next call records it", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  const greeting = "Hi, you've reached One Zero Backspace. We'll text you at this number about your call. Message and data rates may apply. Reply STOP to opt out. Leave a message after the tone.";
  const middle = "Sorry we missed you. Reply with what you need and we'll call back today.";
  const res = await admin(env, `/admin/clients/${id}/wording`, { method: "PUT", body: JSON.stringify({ greeting, middle, by: "ryan@onezerobackspace.com" }) });
  assert.equal(res.status, 200);
  const o = await res.json();
  assert.equal(o.greeting, greeting);
  assert.equal(o.middle, middle);
  assert.equal(o.versions.length, 2);
  assert.equal(o.versions[0].by, "ryan@onezerobackspace.com");
  assert.equal(o.versions[1].current, false);
  const c = row(env, "SELECT greeting, first_text FROM clients WHERE id = ?", id);
  assert.equal(c.first_text, `One Zero Backspace: ${middle} ${FIRST_TEXT_SUFFIX}`);

  const { sid } = await missedCall(env);
  const call = row(env, "SELECT wording_version FROM calls WHERE call_sid = ?", sid);
  assert.equal(call.wording_version, o.versions[0].id);
  const sent = rows(env, "SELECT body FROM messages WHERE kind = 'first'");
  assert.equal(sent.at(-1).body, c.first_text, "the next caller gets the new text");
});

test("bad wording is refused with the reasons, and nothing changes", async () => {
  const env = makeEnv();
  const id = addClient(env);
  const res = await admin(env, `/admin/clients/${id}/wording`, { method: "PUT", body: JSON.stringify({ greeting: "Leave a message.", middle: "Visit www.example.com" }) });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.problems.length >= 2);
  assert.equal(row(env, "SELECT greeting FROM clients WHERE id = ?", id).greeting, OZB.greeting);
  assert.equal(rows(env, "SELECT * FROM wording_versions").length, 0);
});

test("a client whose wording is published by hand (OZB) can't change it from the portal", async () => {
  const env = makeEnv();
  const id = addClient(env, { wording_editable: 0 });
  const res = await admin(env, `/admin/clients/${id}/wording`, { method: "PUT", body: JSON.stringify({ greeting: OZB.greeting, middle: "Sorry we missed you, we'll call back soon." }) });
  assert.equal(res.status, 409);
  assert.equal((await run(env, new Request(`${ORIGIN}/texting/${id}`))).status, 404, "no generated page either");
});

test("a voicemail plays only for its own client's call, and downloads as an attachment", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  const id = addClient(env);
  const other = addClient(env, { number: "+18335550199", owner_cell: "+14125550111" });
  await missedCall(env, { voicemail: 30 });
  const callId = row(env, "SELECT id FROM calls").id;
  const ok = await admin(env, `/admin/clients/${id}/calls/${callId}/voicemail?download=1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Content-Type"), "audio/mpeg");
  assert.match(ok.headers.get("Content-Disposition"), /^attachment/);
  assert.equal(await ok.text(), "ID3-fake-mp3");
  assert.equal((await admin(env, `/admin/clients/${other}/calls/${callId}/voicemail`)).status, 404);
});

test("/texting/<id> quotes the current wording word for word", async () => {
  const env = makeEnv();
  const id = addClient(env);
  const res = await run(env, new Request(`${ORIGIN}/texting/${id}`));
  assert.equal(res.status, 200);
  const html = await res.text();
  const plain = html.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'");
  assert.ok(plain.includes(OZB.first_text));
  assert.ok(plain.includes("Reply STOP to opt out"));
});
