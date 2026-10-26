// The forwarded call: greeting, voicemail, then the first text.
//
// Twilio requests, in order:
//   /voice        when the forwarded call arrives (the number's Voice URL).
//                 Says the greeting up to the end of the texting disclosure,
//                 then <Redirect>s to /voice/heard.
//   /voice/heard  only once that <Say> has finished: the caller heard the whole
//                 disclosure. Marks the call, says the rest of the greeting,
//                 then <Record>s the voicemail.
//   /voice/done   when the voicemail ends: <Record action>
//   /recording    when the recording is ready: <Record recordingStatusCallback>
//   /voice/status when the call is over (the number's call status callback)
//
// The first text goes from /voice/done or /voice/status, whichever comes
// first (src/send.js maybeFirstText), and only for a call that reached
// /voice/heard. A caller who hangs up during the greeting, even 10 seconds in,
// never heard "We'll text you ... Reply STOP" in full, so isn't texted.
// /voice/status is still the trigger that always comes, for a caller who heard
// the disclosure and hung up at the beep without a Record action.
//
// If the database fails while a call arrives, the caller still gets a plain
// greeting and the beep (safeGreeting): the voicemail is kept at Twilio, and
// no text goes, because the greeting doesn't promise one.

import { twiml, xml, accountOf } from "./twilio.js";
import { splitGreeting } from "./rules.js";
import { clientById, clientForCall, bump, nowIso, hoursAgo } from "./store.js";
import { maybeFirstText, sendText } from "./send.js";
import { emailOwner } from "./notify.js";
import { isAnonymous, isNanp, pretty, clock } from "./phone.js";
import { vmLink } from "./vm.js";

const origin = (env) => (env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
const say = (env, text) => `<Say voice="${xml(env.SAY_VOICE || "Polly.Joanna")}">${xml(text)}</Say>`;
const record = (env) => {
  const o = origin(env);
  return `<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" method="POST" action="${o}/voice/done"` +
    ` recordingStatusCallback="${o}/recording" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>`;
};

export const PAUSED_MESSAGE = "Sorry, we can't take your call right now. Please try again later. Goodbye.";
export const UNKNOWN_MESSAGE = "Sorry, this number is not in service. Goodbye.";
export const SAFE_MESSAGE = "Sorry we missed your call. Please leave a message after the tone.";
export const FLOOD_MESSAGE = "Sorry we missed your call. Please try again later. Goodbye.";
/** Forwarded calls per client per hour before the short goodbye (a robocall run). */
export const CALLS_PER_HOUR = 30;

/**
 * What a caller hears when the worker can't do its normal job (a database
 * error): a greeting without the texting disclosure, and the beep. No text
 * goes for such a call, so the greeting mustn't promise one.
 */
export const safeGreeting = (env, name = "") =>
  twiml(say(env, name ? `Thanks for calling ${name}. ${SAFE_MESSAGE}` : SAFE_MESSAGE) + record(env));

/** Just the beep and the voicemail: for /voice/heard when it fails, as the greeting has already played. */
export const recordOnly = (env) => twiml(record(env));

/**
 * Comparing voices (VOICE_SAMPLER = comma-separated Twilio voice names): the
 * caller hears the client's greeting once per voice, each announced by number,
 * then the call ends. No call row, no voicemail, no text. Only for test calls
 * before the line goes live; unset it afterwards.
 */
export function voiceSampler(env, client) {
  const voices = String(env.VOICE_SAMPLER || "").split(",").map((v) => v.trim()).filter(Boolean);
  const parts = voices.map((v, i) =>
    `<Say voice="${xml(env.SAY_VOICE || "Polly.Joanna")}">Voice ${i + 1}.</Say><Say voice="${xml(v)}">${xml(client.greeting)}</Say><Pause length="1"/>`);
  return twiml(parts.join("") + `<Say voice="${xml(env.SAY_VOICE || "Polly.Joanna")}">That's all ${voices.length}. Goodbye.</Say><Hangup/>`);
}

/** POST /voice */
export async function voice(env, params, accountSid) {
  let client = null;
  try {
    client = await clientForCall(env, params, accountSid);
    if (!client) return twiml(`${say(env, UNKNOWN_MESSAGE)}<Hangup/>`);
    if (client.status !== "active") return twiml(`${say(env, PAUSED_MESSAGE)}<Hangup/>`);
    if (env.VOICE_SAMPLER) return voiceSampler(env, client);
    // A flood of calls (a robocall run): past the hour's limit, a short
    // goodbye with no voicemail, so minutes stay small. Counted, not texted.
    const lastHour = await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE client_id = ?1 AND at > ?2").bind(client.id, hoursAgo(1)).first();
    const flood = (lastHour?.n || 0) >= CALLS_PER_HOUR;
    // Texting paused by the spending alarm: the greeting mustn't promise a text.
    const why = flood ? "call-flood" : client.texts_paused_at ? "spend-paused" : null;
    if (why) {
      await env.DB.prepare(
        `INSERT INTO calls (client_id, call_sid, from_number, to_number, forwarded_from, stir_verstat, at, why_not_texted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (call_sid) DO NOTHING`,
      ).bind(client.id, params.get("CallSid") || "", params.get("From") || "", params.get("To") || "",
        params.get("ForwardedFrom") || params.get("CalledVia") || null, params.get("StirVerstat") || null, nowIso(), why).run();
      return flood ? twiml(`${say(env, FLOOD_MESSAGE)}<Hangup/>`) : safeGreeting(env, client.name);
    }
    await env.DB.prepare(
      `INSERT INTO calls (client_id, call_sid, from_number, to_number, forwarded_from, stir_verstat, at, wording_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, (SELECT MAX(id) FROM wording_versions WHERE client_id = ?1)) ON CONFLICT (call_sid) DO NOTHING`,
    ).bind(client.id, params.get("CallSid") || "", params.get("From") || "", params.get("To") || "",
      params.get("ForwardedFrom") || params.get("CalledVia") || null, params.get("StirVerstat") || null, nowIso()).run();
  } catch (e) {
    console.log("/voice failed, plain greeting instead", String(e?.message || e).slice(0, 200));
    return safeGreeting(env, client?.name || "");
  }
  const [disclosed] = splitGreeting(client.greeting);
  return twiml(say(env, disclosed) + `<Redirect method="POST">${origin(env)}/voice/heard</Redirect>`);
}

/** POST /voice/heard: the greeting has played through the texting disclosure. */
export async function voiceHeard(env, params, accountSid) {
  const { call, client } = await callAndClient(env, params, accountSid);
  if (!call) return twiml(record(env));
  await env.DB.prepare("UPDATE calls SET heard_disclosure = 1 WHERE id = ?1").bind(call.id).run();
  const [, rest] = splitGreeting(client.greeting);
  return twiml((rest ? say(env, rest) : "") + record(env));
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
  if (status === "completed") await maybeFirstText(env, client, call);
  return new Response(null, { status: 204 });
}

/**
 * POST /recording: the voicemail is ready. Tells the owner, with a link that
 * needs no Twilio login, by email (works whatever the number's verification
 * status) and by text.
 */
export async function recording(env, params, accountSid) {
  const { call, client } = await callAndClient(env, params, accountSid);
  if (!call) return new Response(null, { status: 204 });
  if ((params.get("RecordingStatus") || "completed") !== "completed") return new Response(null, { status: 204 });
  const secs = Number.parseInt(params.get("RecordingDuration") || "0", 10) || 0;
  await env.DB.prepare("UPDATE calls SET recording_sid = ?2, voicemail_url = ?3, voicemail_seconds = ?4 WHERE id = ?1")
    .bind(call.id, params.get("RecordingSid") || null, params.get("RecordingUrl") || null, secs).run();
  if (secs < 1) return new Response(null, { status: 204 });
  // The link first: if it can't be made (VM_LINK_KEY unset), nothing is claimed.
  const link = await vmLink(env, call.id);
  const claim = await env.DB.prepare("UPDATE calls SET owner_notified = 1 WHERE id = ?1 AND owner_notified = 0").bind(call.id).run();
  if (!claim.meta?.changes) return new Response(null, { status: 204 });
  let emailed = false;
  let texted = false;
  try {
    const who = isNanp(call.from_number) ? pretty(call.from_number) : isAnonymous(call.from_number) ? "a blocked number" : call.from_number;
    const body = `Voicemail from ${who}, ${clock(secs)}: ${link}`;
    emailed = await emailOwner(env, client, {
      subject: `Voicemail from ${who} (${clock(secs)})`,
      text: `${body}\n\nThe link plays the recording for 7 days.\n\n${client.name} text-back`,
    });
    texted = (await sendText(env, client, { to: client.owner_cell, body, kind: "voicemail", callId: call.id })).ok;
  } finally {
    if (!emailed && !texted) await env.DB.prepare("UPDATE calls SET owner_notified = 0 WHERE id = ?1").bind(call.id).run();
  }
  return new Response(null, { status: 204 });
}
