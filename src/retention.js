// The daily clean-up: calls and texts are kept 90 days, voicemails too.
// Opt-outs are never deleted (an opt-out must outlive the conversation), and
// neither are the monthly usage counters (no phone numbers in them).
//
// Only recordings this worker knows about are deleted (their SIDs are in
// calls), never "every recording on the account", so nothing else that ever
// uses the account can lose its recordings to this cron.

import { twilio, accountOf } from "./twilio.js";
import { nowIso } from "./store.js";

export const KEEP_DAYS = 90;
// Each deletion is one subrequest; a backlog is worked off over several days.
const MAX_DELETES = 200;

export async function purgeOld(env, { now = Date.now() } = {}) {
  const cutoff = new Date(now - KEEP_DAYS * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT calls.id, calls.recording_sid, clients.twilio_subaccount_sid
       FROM calls JOIN clients ON clients.id = calls.client_id
      WHERE calls.at < ?1 AND calls.recording_sid IS NOT NULL AND calls.recording_deleted_at IS NULL
      ORDER BY calls.at LIMIT ?2`,
  ).bind(cutoff, MAX_DELETES).all();

  let recordings = 0;
  for (const row of results || []) {
    let ok = false;
    try { ok = await twilio(env, accountOf(row, env)).deleteRecording(row.recording_sid); } catch { /* no account SID */ }
    if (!ok) continue; // tried again tomorrow; the row stays until it's gone at Twilio
    await env.DB.prepare("UPDATE calls SET recording_deleted_at = ?2 WHERE id = ?1").bind(row.id, nowIso()).run();
    recordings++;
  }

  const calls = await env.DB.prepare(
    "DELETE FROM calls WHERE at < ?1 AND (recording_sid IS NULL OR recording_deleted_at IS NOT NULL)",
  ).bind(cutoff).run();
  const messages = await env.DB.prepare("DELETE FROM messages WHERE at < ?1").bind(cutoff).run();
  return { cutoff, recordings, calls: calls.meta?.changes || 0, messages: messages.meta?.changes || 0 };
}
