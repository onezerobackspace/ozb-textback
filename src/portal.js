// What the client portal (ozb-portal, crm/src/portal.js) reads and changes,
// behind /admin like the rest: one client's overview, saving its wording, and
// playing a voicemail. Also the public texting page (/texting/<id>) for
// clients whose wording lives here, so it always matches what callers hear.

import { hasDisclosure, firstTextProblems, spokenGreeting, helpText, startText, stopText } from "./rules.js";
import { clientById, easternMonth, nowIso } from "./store.js";
import { twilio, accountOf } from "./twilio.js";
import { pretty } from "./phone.js";

/** The fixed end of every first text, as carriers approved it. */
export const FIRST_TEXT_SUFFIX = "Msg & data rates may apply. Reply STOP to opt out.";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

/** The part of a first text the client may change: between "<Name>: " and the fixed end. */
export function middleOf(firstText, name) {
  let t = String(firstText || "").trim();
  const head = `${name}:`;
  if (t.startsWith(head)) t = t.slice(head.length).trim();
  if (t.endsWith(FIRST_TEXT_SUFFIX)) t = t.slice(0, -FIRST_TEXT_SUFFIX.length).trim();
  return t;
}

const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
const oneText = (s) => (GSM.test(s) ? s.length <= 160 : s.length <= 70);
const LINKY = /(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|ly|co|us|io|info|biz)\b)/i;

/** New wording from the portal, checked: { greeting, first_text } or { problems }. */
export function checkWording(client, { greeting, middle }) {
  const g = String(greeting || "").replace(/\s+/g, " ").trim();
  const mid = String(middle || "").replace(/\s+/g, " ").trim();
  const firstText = `${client.name}: ${mid} ${FIRST_TEXT_SUFFIX}`;
  const problems = [];
  if (!hasDisclosure(g)) problems.push("The greeting must say a text is coming, that message and data rates may apply, and “Reply STOP to opt out”.");
  if (g.length > 600) problems.push("Keep the greeting under 600 characters.");
  if (mid.length < 10) problems.push("Say something to the caller in the text.");
  if (LINKY.test(mid)) problems.push("Leave links out of the text: carriers filter texts that have them.");
  if (!oneText(firstText)) problems.push("Make the text shorter so it fits in one text.");
  for (const p of firstTextProblems(firstText, client.name)) if (!problems.length) problems.push(`The text ${p}.`);
  return problems.length ? { problems } : { greeting: g, first_text: firstText };
}

/** The client's versions, oldest wording made version 1 if it has none yet. */
async function versionsOf(env, client) {
  let { results } = await env.DB.prepare("SELECT id, greeting, first_text, by, at FROM wording_versions WHERE client_id = ?1 ORDER BY id DESC LIMIT 12").bind(client.id).all();
  if (!results || !results.length) {
    await env.DB.prepare("INSERT INTO wording_versions (client_id, greeting, first_text, by, at) VALUES (?1, ?2, ?3, 'setup', ?4)")
      .bind(client.id, client.greeting, client.first_text, client.created_at || nowIso()).run();
    ({ results } = await env.DB.prepare("SELECT id, greeting, first_text, by, at FROM wording_versions WHERE client_id = ?1 ORDER BY id DESC LIMIT 12").bind(client.id).all());
  }
  return results || [];
}

/** First instant of an Eastern calendar month, close enough for a count (EDT offset). */
const monthStart = (month) => `${month}-01T04:00:00.000Z`;

/** Everything the portal's Text-back page shows. */
export async function overview(env, client) {
  const month = easternMonth();
  const u = await env.DB.prepare("SELECT texts_out, texts_in, voice_minutes FROM usage WHERE client_id = ?1 AND month = ?2").bind(client.id, month).first();
  const { results: calls } = await env.DB.prepare(
    `SELECT c.id, c.at, c.from_number, c.texted, c.why_not_texted, c.voicemail_seconds, c.recording_sid, c.recording_deleted_at,
            (SELECT m.body FROM messages m WHERE m.client_id = c.client_id AND m.kind = 'inbound' AND m.from_number = c.from_number AND m.at > c.at ORDER BY m.at LIMIT 1) AS reply
       FROM calls c WHERE c.client_id = ?1 ORDER BY c.at DESC LIMIT 25`,
  ).bind(client.id).all();
  const thisMonth = await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE client_id = ?1 AND at >= ?2").bind(client.id, monthStart(month)).first();
  const versions = await versionsOf(env, client);
  const texts = Number(env.PLAN_TEXTS || 300);
  const minutes = Number(env.PLAN_MINUTES || 60);
  return {
    name: client.name,
    number: client.number,
    status: client.status,
    editable: !!client.wording_editable,
    greeting: client.greeting,
    first_text: client.first_text,
    middle: middleOf(client.first_text, client.name),
    suffix: FIRST_TEXT_SUFFIX,
    month,
    usage: {
      texts_out: u?.texts_out || 0, texts_in: u?.texts_in || 0,
      texts: (u?.texts_out || 0) + (u?.texts_in || 0),
      minutes: u?.voice_minutes || 0,
      allowance: { texts, minutes },
    },
    calls: (calls || []).map((c) => ({
      id: c.id, at: c.at, from: c.from_number,
      outcome: c.texted ? "texted" : (c.why_not_texted || "pending"),
      reply: c.reply ? String(c.reply).slice(0, 160) : null,
      voicemail_seconds: c.recording_sid && !c.recording_deleted_at ? (c.voicemail_seconds || 0) : 0,
    })),
    calls_this_month: thisMonth?.n || 0,
    versions: versions.map((v, i) => ({
      id: v.id, at: v.at, by: v.by === "setup" ? "Setup" : v.by,
      greeting: v.greeting, middle: middleOf(v.first_text, client.name), current: i === 0,
    })),
  };
}

/** PUT /admin/clients/:id/wording { greeting, middle, by } */
export async function saveWording(env, client, body) {
  if (!client.wording_editable) {
    return json({ ok: false, error: "This wording is published on your own website, so changes go through us. Send a request instead." }, 409);
  }
  const checked = checkWording(client, body || {});
  if (checked.problems) return json({ ok: false, error: checked.problems[0], problems: checked.problems }, 422);
  if (checked.greeting !== client.greeting || checked.first_text !== client.first_text) {
    // The wording being replaced must be on record first (what earlier callers heard).
    await versionsOf(env, client);
    const at = nowIso();
    const by = String(body?.by || "portal").slice(0, 254);
    await env.DB.prepare("UPDATE clients SET greeting = ?2, first_text = ?3 WHERE id = ?1").bind(client.id, checked.greeting, checked.first_text).run();
    await env.DB.prepare("INSERT INTO wording_versions (client_id, greeting, first_text, by, at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(client.id, checked.greeting, checked.first_text, by, at).run();
  }
  return json({ ok: true, ...(await overview(env, await clientById(env, client.id))) });
}

/** GET /admin/clients/:id/calls/:callId/voicemail: only that client's call. */
export async function voicemail(env, client, callId, download) {
  const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?1 AND client_id = ?2").bind(callId, client.id).first();
  if (!call || !call.recording_sid || call.recording_deleted_at) return json({ ok: false, error: "gone" }, 404);
  const res = await twilio(env, accountOf(client, env)).fetchRecording(call.recording_sid);
  if (!res.ok) return json({ ok: false, error: res.status === 404 ? "gone" : "twilio" }, res.status === 404 ? 404 : 502);
  return new Response(res.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="voicemail-${call.id}.mp3"`,
      "Cache-Control": "private, no-store",
    },
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * GET /texting/<id>: the client's opt-in record, word for word from the
 * database, so a change in the portal shows here at once. Only for clients
 * whose wording is editable; OZB's own page is onezerobackspace.com/texting/.
 */
export async function textingPage(env, id) {
  const c = await clientById(env, id);
  if (!c || !c.wording_editable) return new Response("Not found", { status: 404 });
  const quote = (t) => `<blockquote>${esc(t)}</blockquote>`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)}: texts about your call</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 16px;color:#111}blockquote{margin:.5rem 0 1.25rem;padding:.75rem 1rem;background:#f3f4f8;border-left:3px solid #6d7dff}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.75rem}</style>
<h1>${esc(c.name)}: texts about your call</h1>
<p>When you call ${esc(c.name)} and the call isn't answered, it's forwarded to ${esc(pretty(c.number))}. Before the tone you hear:</p>
${quote(spokenGreeting(c.greeting))}
<p>Only callers who hear that message, through the part about texting, get one text from ${esc(pretty(c.number))}:</p>
${quote(c.first_text)}
<p>You can reply to talk with ${esc(c.name)}. Message frequency varies. Message and data rates may apply.</p>
<h2>Stopping texts and getting help</h2>
<p>Reply STOP at any time. You'll get this reply and no more texts:</p>
${quote(stopText(c))}
<p>Reply START to get texts again:</p>
${quote(startText(c))}
<p>Reply HELP for help:</p>
${quote(helpText(c))}
<p>Mobile information isn't shared with third parties or affiliates for marketing or promotional purposes. Texting is run for ${esc(c.name)} by One Zero Backspace LLC: <a href="https://onezerobackspace.com/privacy/">privacy policy</a>, <a href="https://onezerobackspace.com/terms/">terms</a>.</p>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
