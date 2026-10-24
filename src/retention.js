// The daily clean-up. Calls, texts and voicemails are kept 90 days, then
// deleted here AND at Twilio, as the privacy policy says:
//   - each text's Message resource (body and numbers) at Twilio,
//   - each call's recording, including any whose /recording callback never
//     arrived (found by asking Twilio for that call's recordings),
//   - each call's Call resource at Twilio,
// and only then the row here. A row stays until Twilio confirms its copy is
// gone (204, or 404 for already gone), so its SID is never lost and a failure
// is simply tried again the next day.
//
// Only what this worker knows about is deleted (SIDs in calls and messages,
// and recordings of those calls), never "everything on the account", so
// nothing else that ever uses the account can lose its records to this cron.
//
// Opt-outs are never deleted (an opt-out must outlive the conversation), and
// neither are the monthly usage counters (no phone numbers in them).

import { twilio, accountOf } from "./twilio.js";
import { nowIso } from "./store.js";

export const KEEP_DAYS = 90;
// Each Twilio request is one subrequest; a backlog is worked off over several days.
export const MAX_REQUESTS = 200;

export async function purgeOld(env, { now = Date.now(), maxRequests = MAX_REQUESTS } = {}) {
  const cutoff = new Date(now - KEEP_DAYS * 86400_000).toISOString();
  let left = maxRequests;
  const spend = () => (left > 0 ? (left--, true) : false);
  const out = { cutoff, messages: 0, recordings: 0, calls: 0, left: 0 };
  const api = (row) => {
    try { return twilio(env, accountOf(row, env)); } catch { return null; } // no account SID
  };

  // Texts. Rows without a SID (a send Twilio refused) have nothing at Twilio.
  const noSid = await env.DB.prepare("DELETE FROM messages WHERE at < ?1 AND twilio_sid IS NULL").bind(cutoff).run();
  out.messages += noSid.meta?.changes || 0;
  const { results: msgs } = await env.DB.prepare(
    `SELECT messages.id, messages.twilio_sid, clients.twilio_subaccount_sid
       FROM messages JOIN clients ON clients.id = messages.client_id
      WHERE messages.at < ?1 AND messages.twilio_sid IS NOT NULL ORDER BY messages.at LIMIT ?2`,
  ).bind(cutoff, maxRequests).all();
  for (const row of msgs || []) {
    if (!spend()) break;
    const t = api(row);
    if (!t || !(await t.deleteMessage(row.twilio_sid))) continue; // tried again tomorrow
    await env.DB.prepare("DELETE FROM messages WHERE id = ?1").bind(row.id).run();
    out.messages++;
  }

  // Calls: the recording(s) first, then the call record, then the row.
  const { results: calls } = await env.DB.prepare(
    `SELECT calls.id, calls.call_sid, calls.recording_sid, calls.recording_deleted_at, clients.twilio_subaccount_sid
       FROM calls JOIN clients ON clients.id = calls.client_id
      WHERE calls.at < ?1 ORDER BY calls.at LIMIT ?2`,
  ).bind(cutoff, maxRequests).all();
  for (const row of calls || []) {
    const t = api(row);
    if (!t) continue;
    if (row.recording_sid && !row.recording_deleted_at) {
      if (!spend()) break;
      if (!(await t.deleteRecording(row.recording_sid))) continue;
      await env.DB.prepare("UPDATE calls SET recording_deleted_at = ?2 WHERE id = ?1").bind(row.id, nowIso()).run();
      out.recordings++;
    } else if (!row.recording_sid) {
      // A voicemail whose /recording callback never came still exists at Twilio.
      if (!spend()) break;
      const orphans = await t.callRecordings(row.call_sid);
      if (orphans == null) continue;
      let ok = true;
      for (const sid of orphans) {
        if (!spend() || !(await t.deleteRecording(sid))) { ok = false; break; }
        out.recordings++;
      }
      if (!ok) continue;
    }
    if (!spend()) break;
    if (!(await t.deleteCall(row.call_sid))) continue;
    await env.DB.prepare("DELETE FROM calls WHERE id = ?1").bind(row.id).run();
    out.calls++;
  }
  out.left = left;
  return out;
}
