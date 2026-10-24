// Sending texts, and the rules for the one text a missed caller gets.

import { twilio, accountOf } from "./twilio.js";
import { isAnonymous, isNanp, isShortCode } from "./phone.js";
import { bump, hoursAgo, isOptedOut, nowIso, optOut } from "./store.js";

const statusUrl = (env) => `${(env.PUBLIC_ORIGIN || "").replace(/\/$/, "")}/status`;

/**
 * Sends one text from the client's number and records it. Nothing goes to an
 * opted-out number except the opt-out confirmation itself (allowOptedOut).
 * The owner's own cell is never treated as opted out here: if the owner
 * texts STOP, Twilio blocks the number itself and the send fails with 21610.
 * Returns { ok, sid?, errorCode?, skipped? }.
 */
export async function sendText(env, client, { to, body, kind, direction = "out", callId = null, allowOptedOut = false }) {
  if (to !== client.owner_cell && !allowOptedOut && (await isOptedOut(env, client.id, to))) {
    return { ok: false, skipped: "opted-out" };
  }
  const r = await twilio(env, accountOf(client, env)).sendMessage({ from: client.number, to, body, statusCallback: statusUrl(env) });
  await env.DB.prepare(
    `INSERT INTO messages (client_id, direction, kind, call_id, from_number, to_number, body, twilio_sid, status, error_code, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(client.id, direction, kind, callId, client.number, to, body, r.sid || null, r.status || null, r.errorCode || null, nowIso()).run();
  if (r.ok) await bump(env, client.id, "texts_out");
  if (r.errorCode === "21610" && to !== client.owner_cell) await optOut(env, client.id, to, "error-21610");
  return r;
}

/** How many first texts the client sent since `since`. Failed ones don't count. */
async function firstTextsSince(env, client, since) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE client_id = ?1 AND kind = 'first' AND at > ?2
       AND COALESCE(status, '') NOT IN ('failed', 'undelivered')`,
  ).bind(client.id, since).first();
  return r?.n || 0;
}

/**
 * Why a caller should NOT get the first text, or null to send it.
 * Order matters only for which reason is recorded.
 *
 * Caller ID can be spoofed, so a flood of fake calls could make the line text
 * strangers. Three brakes: a call whose caller ID Twilio's STIR/SHAKEN check
 * says FAILED isn't texted (a missing or C-level attestation is normal for a
 * forwarded call, so that alone doesn't block); no more than hourly_text_cap
 * first texts an hour; and no more than daily_text_cap a day.
 */
export async function whyNotText(env, client, from, { stir = null } = {}) {
  if (client.status !== "active") return "paused";
  if (isAnonymous(from)) return "anonymous";
  if (isShortCode(from)) return "short-code";
  if (!isNanp(from)) return "invalid-number";
  if (from === client.owner_cell) return "owner";
  if (from === client.number) return "own-number";
  if (String(stir || "").startsWith("TN-Validation-Failed")) return "caller-id-failed";
  if (await isOptedOut(env, client.id, from)) return "opted-out";
  const recent = await env.DB.prepare(
    `SELECT 1 AS x FROM messages WHERE client_id = ?1 AND kind = 'first' AND to_number = ?2 AND at > ?3
       AND COALESCE(status, '') NOT IN ('failed', 'undelivered') LIMIT 1`,
  ).bind(client.id, from, hoursAgo(24)).first();
  if (recent) return "recent";
  if ((await firstTextsSince(env, client, hoursAgo(1))) >= (client.hourly_text_cap ?? 8)) return "hourly-cap";
  if ((await firstTextsSince(env, client, hoursAgo(24))) >= (client.daily_text_cap ?? 15)) return "daily-cap";
  if (client.lookup_landlines) {
    const type = await twilio(env, accountOf(client, env)).lineType(from);
    if (type === "landline") return "landline";
  }
  return null;
}

export const CAP_NOTICE = "Text-back: missed-call texts are on hold for now. More calls than usual came in within the hour, which can mean spoofed robocalls. Calls and voicemails still come through.";

/** Tells the owner once an hour (at most) that the caps are holding texts back. */
async function capNotice(env, client) {
  const told = await env.DB.prepare(
    "SELECT 1 AS x FROM messages WHERE client_id = ?1 AND kind = 'notice' AND body = ?2 AND at > ?3 LIMIT 1",
  ).bind(client.id, CAP_NOTICE, hoursAgo(1)).first();
  if (told) return;
  await sendText(env, client, { to: client.owner_cell, body: CAP_NOTICE, kind: "notice" });
}

/**
 * Sends a call's first text if it should go and hasn't. Called from
 * /voice/done (the voicemail ended) and /voice/status (the call is over).
 *
 * The caller must have heard the whole texting disclosure: calls.heard_disclosure
 * is set by /voice/heard, which Twilio only requests once the <Say> holding
 * the disclosure has finished. A caller who hung up during it is never texted,
 * however long the call lasted. /voice/heard always comes during the call,
 * before either trigger, so a call without the flag at that point never gets it.
 * Whichever trigger comes first sends; the UPDATE ... WHERE texted = 0 claim
 * means the other one finds it done.
 */
export async function maybeFirstText(env, client, call) {
  if (call.texted || call.why_not_texted) return { done: true };
  const why = call.heard_disclosure ? await whyNotText(env, client, call.from_number, { stir: call.stir_verstat }) : "hung-up-in-greeting";
  if (why) {
    const set = await env.DB.prepare("UPDATE calls SET why_not_texted = ?2 WHERE id = ?1 AND texted = 0 AND why_not_texted IS NULL").bind(call.id, why).run();
    if (set.meta?.changes && (why === "hourly-cap" || why === "daily-cap")) await capNotice(env, client);
    return { sent: false, why };
  }
  const claim = await env.DB.prepare("UPDATE calls SET texted = 1 WHERE id = ?1 AND texted = 0 AND why_not_texted IS NULL").bind(call.id).run();
  if (!claim.meta?.changes) return { done: true };
  const r = await sendText(env, client, { to: call.from_number, body: client.first_text, kind: "first", callId: call.id });
  if (!r.ok) {
    await env.DB.prepare("UPDATE calls SET texted = 0, why_not_texted = ?2 WHERE id = ?1")
      .bind(call.id, r.skipped || `send-failed-${r.errorCode}`).run();
    return { sent: false, why: r.skipped || `send-failed-${r.errorCode}` };
  }
  return { sent: true, sid: r.sid };
}
