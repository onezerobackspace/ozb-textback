import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, hook, row, OZB_NUMBER, CALLER } from "./helpers.mjs";

test("VOICE_SAMPLER plays the greeting once per voice, numbered, then hangs up with no call row, voicemail or text", async () => {
  const env = makeEnv({ VOICE_SAMPLER: "Polly.Danielle-Generative, Google.en-US-Chirp3-HD-Charon" });
  addClient(env);
  const res = await hook(env, "/voice", { CallSid: "CA" + "1".repeat(32), From: CALLER, To: OZB_NUMBER, CallStatus: "ringing" });
  const body = await res.text();
  assert.match(body, /Voice 1\.<\/Say><Say voice="Polly\.Danielle-Generative">Hi, you&apos;ve reached/);
  assert.match(body, /Voice 2\.<\/Say><Say voice="Google\.en-US-Chirp3-HD-Charon">/);
  assert.match(body, /That's all 2\. Goodbye\.<\/Say><Hangup\/><\/Response>/);
  assert.doesNotMatch(body, /<Record|<Redirect/);
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM calls").n, 0);
});

test("without VOICE_SAMPLER the call goes through the normal greeting", async () => {
  const env = makeEnv();
  addClient(env);
  const body = await (await hook(env, "/voice", { CallSid: "CA" + "2".repeat(32), From: CALLER, To: OZB_NUMBER, CallStatus: "ringing" })).text();
  assert.match(body, /<Redirect method="POST">/);
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM calls").n, 1);
});
