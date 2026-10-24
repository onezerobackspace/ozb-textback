// Small database helpers shared by the handlers.

import { accountOf } from "./twilio.js";

export const nowIso = () => new Date().toISOString();
export const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** "2026-10" for the Eastern calendar month a moment falls in: the plan's month. */
export function easternMonth(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`;
}

const USAGE_FIELDS = new Set(["texts_out", "texts_in", "voice_minutes"]);

/** Adds to this month's counter for a client. */
export async function bump(env, clientId, field, n = 1) {
  if (!USAGE_FIELDS.has(field)) throw new Error(`unknown usage field ${field}`);
  if (!n) return;
  await env.DB.prepare(
    `INSERT INTO usage (client_id, month, ${field}) VALUES (?1, ?2, ?3)
     ON CONFLICT (client_id, month) DO UPDATE SET ${field} = ${field} + ?3`,
  ).bind(clientId, easternMonth(), n).run();
}

export const clientById = (env, id) => env.DB.prepare("SELECT * FROM clients WHERE id = ?1").bind(id).first();

/** The client whose number this is, provided it lives on the account that signed the request. */
export async function clientByNumber(env, number, accountSid) {
  if (!number) return null;
  const c = await env.DB.prepare("SELECT * FROM clients WHERE number = ?1").bind(number).first();
  return c && accountOf(c, env) === accountSid ? c : null;
}

/**
 * The client a forwarded call is for. To is our number, so it decides; if a
 * number we don't know got the call, ForwardedFrom or CalledVia (the cell that
 * forwarded it, when the carrier passes it on) can still name the client.
 */
export async function clientForCall(env, params, accountSid) {
  const byTo = await clientByNumber(env, params.get("To"), accountSid);
  if (byTo) return byTo;
  for (const n of [params.get("ForwardedFrom"), params.get("CalledVia")]) {
    if (!n) continue;
    const c = await env.DB.prepare("SELECT * FROM clients WHERE owner_cell = ?1 OR number = ?1 ORDER BY id LIMIT 1").bind(n).first();
    if (c && accountOf(c, env) === accountSid) return c;
  }
  return null;
}

export async function isOptedOut(env, clientId, phone) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM opt_outs WHERE client_id = ?1 AND phone = ?2").bind(clientId, phone).first());
}

export async function optOut(env, clientId, phone, keyword) {
  await env.DB.prepare(
    `INSERT INTO opt_outs (client_id, phone, at, keyword) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (client_id, phone) DO NOTHING`,
  ).bind(clientId, phone, nowIso(), String(keyword).slice(0, 60)).run();
}

export async function optIn(env, clientId, phone) {
  const r = await env.DB.prepare("DELETE FROM opt_outs WHERE client_id = ?1 AND phone = ?2").bind(clientId, phone).run();
  return (r.meta?.changes || 0) > 0;
}

/**
 * Who the owner is talking to: the newest of what the owner has actually seen
 * (a caller whose voicemail reached the owner, a texter) or the person the
 * owner last wrote to. A call the owner was never told about (a hang-up, a
 * robocall, a caller who left no voicemail) doesn't count, so it can't take
 * over a reply meant for someone else. Hidden and invalid numbers are skipped.
 */
export async function latestPartner(env, client, isValid) {
  const { results } = await env.DB.prepare(
    `SELECT who FROM (
       SELECT from_number AS who, at FROM calls WHERE client_id = ?1 AND owner_notified = 1
       UNION ALL SELECT from_number, at FROM messages WHERE client_id = ?1 AND kind = 'inbound'
       UNION ALL SELECT to_number, at FROM messages WHERE client_id = ?1 AND kind = 'reply'
     ) WHERE who != ?2 AND who != ?3 ORDER BY at DESC LIMIT 20`,
  ).bind(client.id, client.owner_cell, client.number).all();
  return (results || []).map((r) => r.who).find(isValid) || null;
}

/** True when this number called or texted the client in the last `days` days. */
export async function hasContacted(env, client, phone, days = 60) {
  const since = hoursAgo(days * 24);
  return !!(await env.DB.prepare(
    `SELECT 1 AS x FROM calls WHERE client_id = ?1 AND from_number = ?2 AND at > ?3
     UNION ALL SELECT 1 FROM messages WHERE client_id = ?1 AND kind = 'inbound' AND from_number = ?2 AND at > ?3 LIMIT 1`,
  ).bind(client.id, phone, since).first());
}

/** How many messages of a kind the client sent or got since `since`, optionally only those whose body starts with `prefix`. */
export async function countSince(env, client, kind, since, prefix = null) {
  const r = prefix == null
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id = ?1 AND kind = ?2 AND at > ?3").bind(client.id, kind, since).first()
    : await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id = ?1 AND kind = ?2 AND at > ?3 AND substr(body, 1, length(?4)) = ?4")
      .bind(client.id, kind, since, prefix).first();
  return r?.n || 0;
}
