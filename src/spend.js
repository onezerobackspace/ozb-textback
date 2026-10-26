// Money: Twilio's spending alarms, and the usage emails to clients.
//
// Each Twilio account a client's number lives on (OZB's main account, or the
// client's subaccount) gets two monthly usage triggers on total spend
// (scripts/usage-triggers.mjs): SPEND_ALERT_AT ($15) emails Ryan, and
// SPEND_PAUSE_AT ($40) pauses texting to callers for the clients on that
// account until Ryan resumes it (POST /admin/clients/:id/texting, or Resume
// texting in the CRM). Calls still get a greeting and voicemail meanwhile.
// A normal heavy month is about $7, so either means something is wrong.
//
// The usage emails go to the owner at 80% and 100% of the plan's texts or
// minutes, once each a month, from the daily cron.

import { easternMonth, nowIso } from "./store.js";
import { emailOwner } from "./notify.js";

const PRICE_TEXT = 0.03;
const PRICE_MINUTE = 0.05;
const MINIMUM = 5;

/** The clients whose numbers live on this Twilio account. */
async function clientsOnAccount(env, accountSid) {
  const main = accountSid === env.TWILIO_ACCOUNT_SID;
  const { results } = await env.DB.prepare(
    `SELECT * FROM clients WHERE twilio_subaccount_sid = ?1 ${main ? "OR twilio_subaccount_sid IS NULL" : ""} ORDER BY id`,
  ).bind(accountSid).all();
  return results || [];
}

async function alertRyan(env, subject, text) {
  if (!env.EMAIL || !env.MAIL_FROM || !env.ALERT_TO) return false;
  const from = env.MAIL_FROM_NAME ? { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME } : env.MAIL_FROM;
  try {
    await env.EMAIL.send({ from, to: env.ALERT_TO, subject: subject.slice(0, 200), text });
    return true;
  } catch (e) {
    console.log("alert email failed", String(e?.message || e).slice(0, 200));
    return false;
  }
}

/**
 * POST /usage-trigger: a Twilio usage trigger fired (signed like any webhook).
 * Its params: AccountSid, UsageTriggerSid, TriggerValue, CurrentValue,
 * UsageCategory, IdempotencyToken.
 */
export async function usageTrigger(env, params, accountSid) {
  const value = Number(params.get("TriggerValue") || 0);
  const current = Number(params.get("CurrentValue") || value);
  const pauseAt = Number(env.SPEND_PAUSE_AT || 40);
  const action = value >= pauseAt ? "pause" : "alert";
  const token = params.get("IdempotencyToken") || `${accountSid}:${params.get("UsageTriggerSid") || ""}:${easternMonth()}:${value}`;
  const first = await env.DB.prepare(
    `INSERT INTO spend_alerts (account_sid, trigger_sid, trigger_value, current_value, idempotency, action, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (idempotency) DO NOTHING`,
  ).bind(accountSid, params.get("UsageTriggerSid") || null, value, current, token, action, nowIso()).run();
  if (!first.meta?.changes) return new Response(null, { status: 204 }); // a retry

  const clients = await clientsOnAccount(env, accountSid);
  const names = clients.map((c) => c.name).join(", ") || "no client";
  const spent = `$${current.toFixed(2)}`;
  if (action === "pause") {
    const why = `Twilio spend reached ${spent} this month (the pause level is $${pauseAt})`;
    for (const c of clients) {
      await env.DB.prepare("UPDATE clients SET texts_paused_at = COALESCE(texts_paused_at, ?2), texts_paused_why = ?3 WHERE id = ?1").bind(c.id, nowIso(), why).run();
    }
    await alertRyan(env, `Texting paused: ${names} (${spent} this month)`,
      `${why}, so texting to callers is paused for ${names}. Calls still get a greeting and voicemail; owners still get their notices.\n\n` +
      "Look at the text-back log for what's using it (a bot texting back and forth, a robocall run). When it's sorted, resume texting from the client's Portal tab in the CRM.");
  } else {
    await alertRyan(env, `Text-back spend alert: ${names} (${spent} this month)`,
      `Twilio spend for ${names} reached ${spent} this month. A normal busy month is about $7. Texting pauses on its own at $${pauseAt}.\n\nNothing is paused yet. Have a look at the text-back log if this is unexpected.`);
  }
  return new Response(null, { status: 204 });
}

/** POST /admin/clients/:id/texting { paused: false } (or true to pause by hand). */
export async function setTexting(env, client, body) {
  const paused = body?.paused === true;
  await env.DB.prepare("UPDATE clients SET texts_paused_at = ?2, texts_paused_why = ?3 WHERE id = ?1")
    .bind(client.id, paused ? nowIso() : null, paused ? String(body?.why || "Paused by hand").slice(0, 200) : null).run();
  return Response.json({ ok: true, paused });
}

/** What a month over the plan costs, by the price list (under $5 isn't charged). */
export function overageOf(texts, minutes, allowance) {
  const overTexts = Math.max(0, texts - allowance.texts);
  const overMinutes = Math.max(0, minutes - allowance.minutes);
  const amount = Math.round((overTexts * PRICE_TEXT + overMinutes * PRICE_MINUTE) * 100) / 100;
  return { overTexts, overMinutes, amount, charged: amount >= MINIMUM };
}

/** From the daily cron: tell owners at 80% and 100% of the plan, once each a month. */
export async function usageWarnings(env, { month = easternMonth() } = {}) {
  const allowance = { texts: Number(env.PLAN_TEXTS || 300), minutes: Number(env.PLAN_MINUTES || 60) };
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.texts_out, u.texts_in, u.voice_minutes, u.warned_80, u.warned_100
       FROM usage u JOIN clients c ON c.id = u.client_id WHERE u.month = ?1 AND c.status = 'active'`,
  ).bind(month).all();
  const sent = [];
  for (const r of results || []) {
    const texts = (r.texts_out || 0) + (r.texts_in || 0);
    const minutes = r.voice_minutes || 0;
    const share = Math.max(texts / allowance.texts, minutes / allowance.minutes);
    const level = share >= 1 && !r.warned_100 ? 100 : share >= 0.8 && !r.warned_80 && !r.warned_100 ? 80 : 0;
    if (!level) continue;
    const used = `${texts} of the ${allowance.texts} texts (sent and received) and ${minutes} of the ${allowance.minutes} call minutes`;
    const o = overageOf(texts, minutes, allowance);
    const text = level === 100
      ? `Hi,\n\nYour ${r.name} text-back has gone past this month's plan: so far ${used}.\n\nNothing stops. Extra texts are 3¢ each and extra minutes 5¢, added to your next invoice; so far that's $${o.amount.toFixed(2)}. A month under $5 extra isn't charged.\n\nYou can see your usage any time at https://portal.onezerobackspace.com.\n\nOne Zero Backspace`
      : `Hi,\n\nA heads-up: your ${r.name} text-back has used most of this month's plan, ${used}.\n\nNothing stops if you go over. Extra texts are 3¢ each and extra minutes 5¢, added to your next invoice, and a month under $5 extra isn't charged.\n\nYou can see your usage any time at https://portal.onezerobackspace.com.\n\nOne Zero Backspace`;
    const ok = await emailOwner(env, r, { subject: level === 100 ? "Your text-back is past this month's plan" : "Your text-back has used 80% of this month's plan", text });
    if (!ok) continue; // tried again tomorrow
    await env.DB.prepare(`UPDATE usage SET warned_80 = 1${level === 100 ? ", warned_100 = 1" : ""} WHERE client_id = ?1 AND month = ?2`).bind(r.id, month).run();
    sent.push({ client: r.id, level });
  }
  return { sent };
}
