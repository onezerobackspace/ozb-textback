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

/**
 * Why a caller should NOT get the first text, or null to send it.
 * Order matters only for which reason is recorded.
 */
export async function whyNotText(env, client, from) {
  if (client.status !== "active") return "paused";
  if (isAnonymous(from)) return "anonymous";
  if (isShortCode(from)) return "short-code";
  if (!isNanp(from)) return "invalid-number";
  if (from === client.owner_cell) return "owner";
  if (from === client.number) return "own-number";
  if (await isOptedOut(env, client.id, from)) return "opted-out";
  const recent = await env.DB.prepare(
    `SELECT 1 AS x FROM messages WHERE client_id = ?1 AND kind = 'first' AND to_number = ?2 AND at > ?3
       AND COALESCE(status, '') NOT IN ('failed', 'undelivered') LIMIT 1`,
  ).bind(client.id, from, hoursAgo(24)).first();
  if (recent) return "recent";
  const today = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE client_id = ?1 AND kind = 'first' AND at > ?2",
  ).bind(client.id, hoursAgo(24)).first();
  if ((today?.n || 0) >= (client.daily_text_cap ?? 50)) return "daily-cap";
  if (client.lookup_landlines) {
    const type = await twilio(env, accountOf(client, env)).lineType(from);
    if (type === "landline") return "landline";
  }
  return null;
}

/**
 * Sends a call's first text if it should go and hasn't. Called when the
 * voicemail step ends (/voice/done, seconds unknown: the caller heard the whole
 * greeting) and when the call completes (/voice/status, with its duration).
 * Whichever comes first sends; the UPDATE ... WHERE texted = 0 claim means the
 * other one finds it done.
 */
export async function maybeFirstText(env, client, call, { seconds = null } = {}) {
  if (call.texted || call.why_not_texted) return { done: true };
  const decide = async () => {
    if (seconds != null && seconds < (client.min_call_seconds ?? 3)) return "hung-up-early";
    return whyNotText(env, client, call.from_number);
  };
  const why = await decide();
  if (why) {
    await env.DB.prepare("UPDATE calls SET why_not_texted = ?2 WHERE id = ?1 AND texted = 0 AND why_not_texted IS NULL").bind(call.id, why).run();
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
