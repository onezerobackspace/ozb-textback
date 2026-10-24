import test from "node:test";
import assert from "node:assert/strict";
import { twilioSignature, authTokenFor } from "../src/twilio.js";
import { makeEnv, addClient, signed, run, useFakeTwilio, ORIGIN, MAIN, SUB, SUB_TOKEN, OZB_NUMBER, CALLER } from "./helpers.mjs";

const voiceFields = { CallSid: "CA" + "1".repeat(32), From: CALLER, To: OZB_NUMBER };

test("the signature matches Twilio's documented example", async () => {
  // From Twilio's "Webhooks security" page: token 12345, this URL and these params.
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
  const sig = await twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params);
  assert.equal(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

test("a correctly signed webhook is accepted", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const res = await run(env, await signed("/voice", voiceFields));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Record /);
});

test("a wrong signature is refused with 403", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const res = await run(env, await signed("/voice", voiceFields, { signature: "bm90LXRoZS1yaWdodC1zaWc=" }));
  assert.equal(res.status, 403);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 0);
});

test("a missing signature is refused", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const res = await run(env, await signed("/voice", voiceFields, { signature: null }));
  assert.equal(res.status, 403);
});

test("a signature made for another host or path is refused", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  assert.equal((await run(env, await signed("/voice", voiceFields, { signUrl: "https://evil.example/voice" }))).status, 403);
  assert.equal((await run(env, await signed("/voice", voiceFields, { signUrl: ORIGIN + "/sms" }))).status, 403);
  // Sent to some other hostname with a signature for that hostname: still the public origin is what counts.
  assert.equal((await run(env, await signed("/voice", voiceFields, { signUrl: "https://ozb-textback.example.workers.dev/voice", sendUrl: "https://ozb-textback.example.workers.dev/voice" }))).status, 403);
});

test("a body changed after signing is refused", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const good = await signed("/voice", voiceFields);
  const sig = good.headers.get("X-Twilio-Signature");
  const tampered = new Request(good.url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
    body: new URLSearchParams({ AccountSid: MAIN, ...voiceFields, From: "+14125559999" }).toString(),
  });
  assert.equal((await run(env, tampered)).status, 403);
});

test("an account we have no token for is refused, and the main token can't sign for a subaccount", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const stranger = "AC" + "f".repeat(32);
  assert.equal((await run(env, await signed("/voice", voiceFields, { account: stranger }))).status, 403);
  assert.equal((await run(env, await signed("/voice", voiceFields, { account: SUB }))).status, 403); // signed with the main token
});

test("a subaccount's webhooks are checked with that subaccount's token", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env, { twilio_subaccount_sid: SUB, number: "+18885550111", owner_cell: "+14125550999", name: "Briggs Electric",
    first_text: "Briggs Electric: Sorry we missed your call. Reply STOP to opt out." });
  const res = await run(env, await signed("/voice", { ...voiceFields, To: "+18885550111" }, { account: SUB, token: SUB_TOKEN }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Record /);
});

test("a signed request from one account can't drive another account's number", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env); // OZB's number, on the main account
  const res = await run(env, await signed("/voice", voiceFields, { account: SUB, token: SUB_TOKEN }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /not in service/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 0);
});

test("authTokenFor ignores anything that isn't an account SID", () => {
  const env = makeEnv();
  assert.equal(authTokenFor(env, MAIN), env.TWILIO_AUTH_TOKEN);
  assert.equal(authTokenFor(env, SUB), SUB_TOKEN);
  assert.equal(authTokenFor(env, "ADMIN_SECRET"), null);
  assert.equal(authTokenFor(env, ""), null);
  assert.equal(authTokenFor({ ...env, TWILIO_AUTH_TOKEN: "" }, MAIN), null);
});

test("GET on a webhook path is refused", async () => {
  const env = makeEnv();
  const res = await run(env, new Request(ORIGIN + "/voice"));
  assert.equal(res.status, 405);
});
