import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, addClient, hook, missedCall, useFakeTwilio, run, row, ORIGIN, OWNER, CALLER, OZB_NUMBER } from "./helpers.mjs";
import { vmLink, vmLinkValid } from "../src/vm.js";

const REC = "RE" + "2".repeat(32);

async function voicemail(env, { seconds = 42, from = CALLER } = {}) {
  const { sid } = await missedCall(env, { from, done: true });
  await hook(env, "/recording", {
    CallSid: sid, RecordingSid: REC, RecordingStatus: "completed", RecordingDuration: String(seconds),
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/x/Recordings/${REC}`,
  });
  return sid;
}

test("a voicemail is texted to the owner with a signed link that needs no Twilio login", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await voicemail(env);
  const notice = fake.sent().find((m) => m.To === OWNER);
  assert.equal(notice.From, OZB_NUMBER);
  assert.match(notice.Body, /^Voicemail from \(412\) 555-0123, 0:42: https:\/\/textback\.onezerobackspace\.com\/vm\/1\?e=\d+&s=[\w-]{22}$/);
  assert.doesNotMatch(notice.Body, /api\.twilio\.com/);
  const call = row(env, "SELECT * FROM calls");
  assert.equal(call.recording_sid, REC);
  assert.equal(call.voicemail_seconds, 42);
  assert.equal(call.owner_notified, 1);

  // The link plays the recording, fetched with the API key from the client's account.
  const link = notice.Body.slice(notice.Body.indexOf("https://"));
  const res = await run(env, new Request(link));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(await res.text(), "ID3-fake-mp3");
  const get = fake.calls.find((c) => c.method === "GET" && c.url.endsWith(`${REC}.mp3`));
  assert.match(get.url, new RegExp(`/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/`));
  assert.match(get.auth, /^Basic /);
});

test("a blocked caller's voicemail still reaches the owner", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await voicemail(env, { from: "+266696687", seconds: 125 });
  assert.match(fake.sent().find((m) => m.To === OWNER).Body, /^Voicemail from a blocked number, 2:05: /);
});

test("the owner is told once, even if Twilio repeats the callback", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  const sid = await voicemail(env);
  await hook(env, "/recording", { CallSid: sid, RecordingSid: REC, RecordingStatus: "completed", RecordingDuration: "42" });
  assert.equal(fake.sent().filter((m) => m.To === OWNER).length, 1);
});

test("an empty recording doesn't bother the owner", async (t) => {
  const fake = useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await voicemail(env, { seconds: 0 });
  assert.equal(fake.sent().filter((m) => m.To === OWNER).length, 0);
});

test("a voicemail link with a bad signature, a changed id or expiry, or past its date is refused", async (t) => {
  useFakeTwilio(t);
  const env = makeEnv();
  addClient(env);
  await voicemail(env);
  const good = new URL(await vmLink(env, 1));
  const e = good.searchParams.get("e");
  const s = good.searchParams.get("s");
  const status = async (u) => (await run(env, new Request(u))).status;
  assert.equal(await status(good.href), 200);
  assert.equal(await status(`${ORIGIN}/vm/1?e=${e}&s=${s.slice(0, -2)}xx`), 403);
  assert.equal(await status(`${ORIGIN}/vm/2?e=${e}&s=${s}`), 403);
  assert.equal(await status(`${ORIGIN}/vm/1?e=${Number(e) + 1}&s=${s}`), 403);
  assert.equal(await status(`${ORIGIN}/vm/1`), 403);
  const old = new URL(await vmLink(env, 1, { exp: Math.floor(Date.now() / 1000) - 60 }));
  assert.equal(await status(old.href), 403);
  // A link signed with another key.
  const other = new URL(await vmLink({ ...env, VM_LINK_KEY: "another-key" }, 1));
  assert.equal(await status(other.href), 403);
});

test("links can't be minted longer than 7 days, even with a valid signature", async () => {
  const env = makeEnv();
  const far = Math.floor(Date.now() / 1000) + 30 * 86400;
  const u = new URL(await vmLink(env, 1, { exp: far }));
  assert.equal(await vmLinkValid(env, "1", u.searchParams.get("e"), u.searchParams.get("s")), false);
});

test("a deleted recording's link says it's gone", async (t) => {
  useFakeTwilio(t, { gone: new Set([REC]) });
  const env = makeEnv();
  addClient(env);
  await voicemail(env);
  const res = await run(env, new Request(await vmLink(env, 1)));
  assert.equal(res.status, 410);
});
