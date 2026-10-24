// Texts to a client's number, and message status callbacks.
//
// From the owner's cell: a reply, relayed from the client number to whoever
// the owner last heard from (or "To 412-555-0123: ..." for someone else).
// From anyone else: STOP/START/HELP, or passed on to the owner's cell as
// "From (412) 555-0123: ...".
//
// Opt-outs and double confirmations: Twilio's opt-out handling is on for a
// toll-free number unless someone turns it off. It answers its own keywords
// (STOP, START, HELP and their synonyms) and blocks texts after STOP. So for
// those keywords this worker records the opt-out but sends nothing, unless the
// client row says Twilio's handling is off (twilio_opt_out = 0). Plain-language
// opt-outs ("stop texting me") Twilio doesn't recognise: this worker records
// them, sends the one confirmation, and from then on refuses to text them.

import { twiml, accountOf } from "./twilio.js";
import { classify, parseOwnerText, helpText, stopText, startText, clip } from "./rules.js";
import { bump, clientByNumber, clientById, isOptedOut, latestPartner, nowIso, optIn, optOut } from "./store.js";
import { sendText } from "./send.js";
import { isNanp, pretty } from "./phone.js";

const empty = () => twiml();

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
  const media = Number.parseInt(params.get("NumMedia") || "0", 10) || 0;
  const extra = media ? ` [+${media} picture${media > 1 ? "s" : ""}, not forwarded: see Twilio]` : "";
  const note = (await isOptedOut(env, client.id, from)) ? " (opted out: they won't get replies)" : "";
  await notifyOwner(env, client, `From ${who}: ${clip(body)}${extra}${note}`, "forward");
  return empty();
}

/** A text to the owner from the client number. */
const notifyOwner = (env, client, body, kind = "notice") =>
  sendText(env, client, { to: client.owner_cell, body, kind, direction: kind === "forward" ? "relay" : "out" });

/** The owner's text, passed on to a caller. */
async function ownerReply(env, client, text) {
  const cmd = parseOwnerText(text);
  if (cmd.error) {
    return notifyOwner(env, client, `Not sent: "${clip(cmd.raw, 30)}" isn't a US number. Write To 4125550123: your message`);
  }
  const to = cmd.to || (await latestPartner(env, client, isNanp));
  if (!to) return notifyOwner(env, client, "Not sent: no one has called or texted yet. Write To 4125550123: your message");
  if (!cmd.body) return notifyOwner(env, client, `Not sent: the message to ${pretty(to)} was empty.`);
  if (to === client.owner_cell || to === client.number) return notifyOwner(env, client, "Not sent: that's this line's own number.");
  if (await isOptedOut(env, client.id, to)) return notifyOwner(env, client, `Not sent: ${pretty(to)} opted out of texts. Call them instead.`);
  const r = await sendText(env, client, { to, body: clip(cmd.body, 1000), kind: "reply", direction: "relay" });
  if (!r.ok) return notifyOwner(env, client, `Not sent to ${pretty(to)} (Twilio error ${r.errorCode || r.skipped}).`);
  return r;
}

// Twilio's message statuses in the order they happen; callbacks can arrive
// out of order, and a late "sent" must not overwrite "delivered".
const RANK = { accepted: 0, scheduled: 0, queued: 1, sending: 2, sent: 3, receiving: 3, received: 4, delivered: 4, undelivered: 4, failed: 4, read: 5, canceled: 4 };

/** POST /status: a message's delivery status. */
export async function status(env, params, accountSid) {
  const sid = params.get("MessageSid") || params.get("SmsSid") || "";
  const msg = await env.DB.prepare("SELECT * FROM messages WHERE twilio_sid = ?1").bind(sid).first();
  if (!msg) return new Response(null, { status: 204 });
  const client = await clientById(env, msg.client_id);
  if (!client || accountOf(client, env) !== accountSid) return new Response(null, { status: 204 });
  const next = (params.get("MessageStatus") || params.get("SmsStatus") || "").toLowerCase();
  const code = params.get("ErrorCode") || null;
  if ((RANK[next] ?? -1) >= (RANK[msg.status] ?? -1)) {
    await env.DB.prepare("UPDATE messages SET status = ?2, error_code = COALESCE(?3, error_code) WHERE id = ?1").bind(msg.id, next, code).run();
  }
  // 21610: the person had replied STOP. Remember it here too.
  if (code === "21610" && msg.to_number !== client.owner_cell) await optOut(env, client.id, msg.to_number, "error-21610");
  // A first text that didn't arrive (30032: the number isn't verified yet)
  // doesn't count as texted, so the caller's next call can try again.
  if (msg.kind === "first" && msg.call_id && (next === "failed" || next === "undelivered")) {
    await env.DB.prepare("UPDATE calls SET texted = 0, why_not_texted = ?2 WHERE id = ?1").bind(msg.call_id, `${next}-${code || "?"}`).run();
  }
  return new Response(null, { status: 204 });
}

