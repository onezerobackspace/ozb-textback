// Texts to a client's number, and message status callbacks.
//
// From the owner's cell: a reply, relayed from the client number to whoever
// the owner last heard from (or "To 412-555-0123: ..." for someone else who has
// called or texted the line). Each relayed reply starts with the business's
// name, like every text from the line, and the owner gets a "Sent to ..."
// receipt, so a reply that went somewhere unexpected (or one sent by someone
// faking the owner's number) shows up on the owner's phone.
// From anyone else: STOP/START/HELP, or passed on to the owner's cell as
// "From (412) 555-0123: ...", at most FORWARDS_PER_SENDER an hour per sender.
//
// Opt-outs and double confirmations: Twilio's opt-out handling is on for a
// toll-free number unless someone turns it off. It answers its own keywords
// (STOP, START, HELP and their synonyms) and blocks texts after STOP. So for
// those keywords this worker records the opt-out but sends nothing, unless the
// client row says Twilio's handling is off (twilio_opt_out = 0). Plain-language
// opt-outs ("stop texting me") Twilio doesn't recognise: this worker records
// them, sends the one confirmation, and from then on refuses to text them.

import { twiml, accountOf } from "./twilio.js";
import { classify, parseOwnerText, helpText, stopText, startText, clip, withName } from "./rules.js";
import { bump, clientByNumber, clientById, countSince, hasContacted, hoursAgo, isOptedOut, latestPartner, nowIso, optIn, optOut } from "./store.js";
import { sendText } from "./send.js";
import { emailOwner } from "./notify.js";
import { isNanp, pretty } from "./phone.js";

const empty = () => twiml();

// Brakes on floods. Past them, the texts are still saved; only the passing-on stops.
export const FORWARDS_PER_SENDER = 10; // a sender's texts passed to the owner per hour
export const FORWARDS_PER_CLIENT = 60; // all texts passed to the owner per hour
export const REPLIES_PER_HOUR = 30;    // owner replies relayed per hour
export const CONTACT_DAYS = 60;        // "To ..." only reaches numbers that called or texted in this many days
export const PAUSED_NOTICE = "Not sent: this text-back line is paused. Call or text the customer from your own phone, or contact One Zero Backspace.";

/** POST /sms */
export async function sms(env, params, accountSid) {
  const client = await clientByNumber(env, params.get("To"), accountSid);
  if (!client) return empty();
  const from = params.get("From") || "";
  const body = params.get("Body") || "";
  const isOwner = from === client.owner_cell;

  // Twilio retries a webhook it thinks failed; the MessageSid makes it once.
  const saved = await env.DB.prepare(
    `INSERT INTO messages (client_id, direction, kind, from_number, to_number, body, twilio_sid, status, at)
     VALUES (?1, 'in', ?2, ?3, ?4, ?5, ?6, 'received', ?7) ON CONFLICT (twilio_sid) DO NOTHING`,
  ).bind(client.id, isOwner ? "owner" : "inbound", from, client.number, body, params.get("MessageSid") || null, nowIso()).run();
  if (!saved.meta?.changes) return empty();
  await bump(env, client.id, "texts_in");

  const what = classify(body, { optOutType: params.get("OptOutType"), twilioHandles: !!client.twilio_opt_out });

  // From the owner, only an exact keyword is a keyword (Twilio acts on those
  // whoever sends them). "Yes" from the owner is an answer to a customer
  // unless the owner had opted out. Everything else is a reply to pass on.
  if (isOwner) {
    if (what.kind === "stop" && what.exact) {
      await optOut(env, client.id, from, what.keyword);
      if (!what.byTwilio) await sendText(env, client, { to: from, body: stopText(client), kind: "confirm", allowOptedOut: true });
    } else if (what.kind === "start" && what.exact && (await optIn(env, client.id, from))) {
      if (!what.byTwilio) await sendText(env, client, { to: from, body: startText(client), kind: "confirm" });
    } else if (what.kind === "help" && what.exact) {
      if (!what.byTwilio) await sendText(env, client, { to: from, body: helpText(client), kind: "help" });
    } else if (client.status === "active") {
      await ownerReply(env, client, body);
    } else {
      await pausedNotice(env, client);
    }
    return empty();
  }

  const who = pretty(from);
  if (what.kind === "stop") {
    await optOut(env, client.id, from, what.keyword);
    if (!what.byTwilio) await sendText(env, client, { to: from, body: stopText(client), kind: "confirm", allowOptedOut: true });
    await notifyOwner(env, client, `From ${who}: ${clip(body)} (opted out of texts)`);
    return empty();
  }
  if (what.kind === "start") {
    if (await optIn(env, client.id, from)) {
      if (!what.byTwilio) await sendText(env, client, { to: from, body: startText(client), kind: "confirm" });
      return empty();
    }
    // "Yes" from someone who never opted out is just an answer: pass it on.
  }
  if (what.kind === "help") {
    if (!what.byTwilio) await sendText(env, client, { to: from, body: helpText(client), kind: "help" });
    return empty();
  }

  // A paused client still has its opt-outs honoured, above, but nothing is passed on.
  if (client.status !== "active") return empty();
  if (!isNanp(from)) return empty(); // a short code or junk sender: nothing to pass on

  const prefix = `From ${who}:`;
  const hour = hoursAgo(1);
  if ((await countSince(env, client, "forward", hour, prefix)) >= FORWARDS_PER_SENDER
    || (await countSince(env, client, "forward", hour)) >= FORWARDS_PER_CLIENT) {
    const held = `More texts from ${who} aren't being passed on for now (over ${FORWARDS_PER_SENDER} in an hour). They're saved in the text-back log.`;
    if (!(await countSince(env, client, "held", hour, held))) await notifyOwner(env, client, held, "held");
    return empty();
  }

  const media = Number.parseInt(params.get("NumMedia") || "0", 10) || 0;
  const extra = media ? ` [+${media} picture${media > 1 ? "s" : ""}, not forwarded: see Twilio]` : "";
  const note = (await isOptedOut(env, client.id, from)) ? " (opted out: they won't get replies)"
    : what.maybeStop ? " (might be asking to stop texts: check before replying)" : "";
  await notifyOwner(env, client, `${prefix} ${clip(body)}${extra}${note}`, "forward");
  return empty();
}

/** A text to the owner from the client number. */
const notifyOwner = (env, client, body, kind = "notice") =>
  sendText(env, client, { to: client.owner_cell, body, kind, direction: kind === "forward" ? "relay" : "out" });

/** Tells the owner a reply wasn't relayed because the line is paused: once a day at most. */
async function pausedNotice(env, client) {
  const told = await env.DB.prepare(
    "SELECT 1 AS x FROM messages WHERE client_id = ?1 AND kind = 'notice' AND body = ?2 AND at > ?3 LIMIT 1",
  ).bind(client.id, PAUSED_NOTICE, hoursAgo(24)).first();
  if (!told) await notifyOwner(env, client, PAUSED_NOTICE);
}

/** The owner's text, passed on to a caller. */
async function ownerReply(env, client, text) {
  if ((await countSince(env, client, "reply", hoursAgo(1))) >= REPLIES_PER_HOUR) {
    return notifyOwner(env, client, `Not sent: over ${REPLIES_PER_HOUR} replies in the last hour. Try again later, or text from your own phone.`);
  }
  const cmd = parseOwnerText(text);
  if (cmd.error) {
    return notifyOwner(env, client, `Not sent: "${clip(cmd.raw, 30)}" isn't a US number. Write To 4125550123: your message`);
  }
  const to = cmd.to || (await latestPartner(env, client, isNanp));
  if (!to) return notifyOwner(env, client, "Not sent: no one has called or texted yet. Write To 4125550123: your message");
  if (!cmd.body) return notifyOwner(env, client, `Not sent: the message to ${pretty(to)} was empty.`);
  if (to === client.owner_cell || to === client.number) return notifyOwner(env, client, "Not sent: that's this line's own number.");
  // "To ..." reaches only people who called or texted the line recently, so a
  // text faking the owner's (public) number can't use the line to reach anyone.
  if (cmd.to && !(await hasContacted(env, client, to, CONTACT_DAYS))) {
    return notifyOwner(env, client, `Not sent: ${pretty(to)} hasn't called or texted this line in the last ${CONTACT_DAYS} days. Text them from your own phone.`);
  }
  if (await isOptedOut(env, client.id, to)) return notifyOwner(env, client, `Not sent: ${pretty(to)} opted out of texts. Call them instead.`);
  const r = await sendText(env, client, { to, body: withName(client, clip(cmd.body, 1000)), kind: "reply", direction: "relay" });
  if (!r.ok) return notifyOwner(env, client, `Not sent to ${pretty(to)} (Twilio error ${r.errorCode || r.skipped}).`);
  await notifyOwner(env, client, `Sent to ${pretty(to)}.`, "receipt");
  return r;
}

// Twilio's message statuses in the order they happen; callbacks can arrive
// out of order, and a late "sent" must not overwrite "delivered".
const RANK = { accepted: 0, scheduled: 0, queued: 1, sending: 2, sent: 3, receiving: 3, received: 4, delivered: 4, undelivered: 4, failed: 4, read: 5, canceled: 4 };
const FAILED = new Set(["failed", "undelivered"]);
// Texts to the owner that are emailed instead when they don't arrive. A
// voicemail notice isn't here: every voicemail is emailed anyway (voice.js).
const EMAIL_IF_FAILED = new Set(["forward", "notice", "held"]);

/** POST /status: a message's delivery status. */
export async function status(env, params, accountSid) {
  const sid = params.get("MessageSid") || params.get("SmsSid") || "";
  const msg = await env.DB.prepare("SELECT * FROM messages WHERE twilio_sid = ?1").bind(sid).first();
  if (!msg) return new Response(null, { status: 204 });
  const client = await clientById(env, msg.client_id);
  if (!client || accountOf(client, env) !== accountSid) return new Response(null, { status: 204 });
  const next = (params.get("MessageStatus") || params.get("SmsStatus") || "").toLowerCase();
  const code = params.get("ErrorCode") || null;
  let failedNow = false;
  if ((RANK[next] ?? -1) >= (RANK[msg.status] ?? -1)) {
    // The first callback that turns this message into a failure, only once.
    const r = await env.DB.prepare(
      `UPDATE messages SET status = ?2, error_code = COALESCE(?3, error_code) WHERE id = ?1
         AND NOT (?4 = 1 AND COALESCE(status, '') IN ('failed', 'undelivered'))`,
    ).bind(msg.id, next, code, FAILED.has(next) ? 1 : 0).run();
    failedNow = FAILED.has(next) && !FAILED.has(msg.status || "") && !!r.meta?.changes;
  }
  // 21610: the person had replied STOP. Remember it here too.
  if (code === "21610" && msg.to_number !== client.owner_cell) await optOut(env, client.id, msg.to_number, "error-21610");
  if (failedNow) {
    // It was counted when Twilio accepted it; it didn't go, so it doesn't count.
    if (msg.direction !== "in") await bump(env, client.id, "texts_out", -1);
    // A first text that didn't arrive (30032: the number isn't verified yet)
    // doesn't count as texted, so the caller's next call can try again.
    if (msg.kind === "first" && msg.call_id) {
      await env.DB.prepare("UPDATE calls SET texted = 0, why_not_texted = ?2 WHERE id = ?1").bind(msg.call_id, `${next}-${code || "?"}`).run();
    }
    // A text to the owner that didn't arrive goes by email instead.
    if (msg.to_number === client.owner_cell && EMAIL_IF_FAILED.has(msg.kind)) {
      await emailOwner(env, client, {
        subject: msg.kind === "forward" ? msg.body.slice(0, 60) : "Text-back notice",
        text: `${msg.body}\n\n(This text couldn't reach your phone: Twilio error ${code || "unknown"}. Until the number's toll-free verification is approved, texts from it fail with 30032.)\n\n${client.name} text-back`,
      });
    }
  }
  return new Response(null, { status: 204 });
}
