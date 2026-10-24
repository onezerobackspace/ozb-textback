// The forwarded call: greeting, voicemail, then the first text.
//
// Twilio requests, in order:
//   /voice        when the forwarded call arrives (the number's Voice URL)
//   /voice/done   when the voicemail ends: <Record action>
//   /recording    when the recording is ready: <Record recordingStatusCallback>
//   /voice/status when the call is over (the number's call status callback)
//
// The first text goes from /voice/done or /voice/status, whichever comes
// first (src/send.js maybeFirstText). /voice/status is the one that always
// comes, however the call ends, even when the caller hangs up during the
// greeting; /voice/done comes sooner for a caller who reaches the beep. Not at
// /voice: the caller hasn't heard the texting disclosure yet.

import { twiml, xml, accountOf } from "./twilio.js";
import { spokenGreeting } from "./rules.js";
import { clientById, clientForCall, bump, nowIso } from "./store.js";
import { maybeFirstText, sendText } from "./send.js";
import { isAnonymous, isNanp, pretty, clock } from "./phone.js";
import { vmLink } from "./vm.js";

const origin = (env) => (env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
const say = (env, text) => `<Say voice="${xml(env.SAY_VOICE || "Polly.Joanna")}">${xml(text)}</Say>`;

export const PAUSED_MESSAGE = "Sorry, we can't take your call right now. Please try again later. Goodbye.";
export const UNKNOWN_MESSAGE = "Sorry, this number is not in service. Goodbye.";

/** POST /voice */
export async function voice(env, params, accountSid) {
  const client = await clientForCall(env, params, accountSid);
  if (!client) return twiml(`${say(env, UNKNOWN_MESSAGE)}<Hangup/>`);
  if (client.status !== "active") return twiml(`${say(env, PAUSED_MESSAGE)}<Hangup/>`);

  const callSid = params.get("CallSid") || "";
  await env.DB.prepare(
    `INSERT INTO calls (client_id, call_sid, from_number, to_number, forwarded_from, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (call_sid) DO NOTHING`,
  ).bind(client.id, callSid, params.get("From") || "", params.get("To") || "",
    params.get("ForwardedFrom") || params.get("CalledVia") || null, nowIso()).run();

  const o = origin(env);
  return twiml(
    say(env, spokenGreeting(client.greeting)) +
    `<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" method="POST" action="${o}/voice/done"` +
    ` recordingStatusCallback="${o}/recording" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`,
  );
}

async function callAndClient(env, params, accountSid) {
  const call = await env.DB.prepare("SELECT * FROM calls WHERE call_sid = ?1").bind(params.get("CallSid") || "").first();
  if (!call) return {};
  const client = await clientById(env, call.client_id);
  // The account that signed must own the client's number.
  if (!client || accountOf(client, env) !== accountSid) return {};
  return { call, client };
}

/** POST /voice/done: the voicemail ended (or timed out in silence). */
export async function voiceDone(env, params, accountSid) {
  const { call, client } = await callAndClient(env, params, accountSid);
  if (call) await maybeFirstText(env, client, call);
  return twiml(`${say(env, "Thank you. Goodbye.")}<Hangup/>`);
}

/** POST /voice/status: the call is over. */
export async function voiceStatus(env, params, accountSid) {
  const { call, client } = await callAndClient(env, params, accountSid);
  if (!call) return new Response(null, { status: 204 });
  const status = params.get("CallStatus") || "";
  const seconds = Number.parseInt(params.get("CallDuration") || "", 10);
  const secs = Number.isFinite(seconds) ? seconds : null;
  const first = await env.DB.prepare(
    "UPDATE calls SET call_status = ?2, seconds = ?3, answered = ?4 WHERE id = ?1 AND seconds IS NULL",
  ).bind(call.id, status, secs, status === "completed" ? 1 : 0).run();
  if (first.meta?.changes && secs) await bump(env, client.id, "voice_minutes", Math.ceil(secs / 60));
  if (status === "completed") await maybeFirstText(env, client, call, { seconds: secs });
  return new Response(null, { status: 204 });
}

/** POST /recording: the voicemail is ready. Tells the owner, with a link that needs no Twilio login. */
export async function recording(env, params, accountSid) {
  const { call, client } = await callAndClient(env, params, accountSid);
  if (!call) return new Response(null, { status: 204 });
  if ((params.get("RecordingStatus") || "completed") !== "completed") return new Response(null, { status: 204 });
  const secs = Number.parseInt(params.get("RecordingDuration") || "0", 10) || 0;
  await env.DB.prepare("UPDATE calls SET recording_sid = ?2, voicemail_url = ?3, voicemail_seconds = ?4 WHERE id = ?1")
    .bind(call.id, params.get("RecordingSid") || null, params.get("RecordingUrl") || null, secs).run();
  if (secs < 1) return new Response(null, { status: 204 });
  const claim = await env.DB.prepare("UPDATE calls SET owner_notified = 1 WHERE id = ?1 AND owner_notified = 0").bind(call.id).run();
  if (!claim.meta?.changes) return new Response(null, { status: 204 });
  const who = isNanp(call.from_number) ? pretty(call.from_number) : isAnonymous(call.from_number) ? "a blocked number" : call.from_number;
  const body = `Voicemail from ${who}, ${clock(secs)}: ${await vmLink(env, call.id)}`;
  const r = await sendText(env, client, { to: client.owner_cell, body, kind: "voicemail", callId: call.id });
  if (!r.ok) await env.DB.prepare("UPDATE calls SET owner_notified = 0 WHERE id = ?1").bind(call.id).run();
  return new Response(null, { status: 204 });
}
