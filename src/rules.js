// The wording rules: the greeting's disclosure, keywords, the owner's commands,
// and the system's own texts. Pure functions, no database.

import { pretty, toE164 } from "./phone.js";

/**
 * Said on every call before the beep. Callers haven't agreed to texts by
 * calling, so the greeting tells them a text is coming and how to stop it.
 */
export const DISCLOSURE = "We'll text you at this number about your call. Message and data rates may apply. Reply STOP to opt out.";

/** True when a greeting says a text is coming, that rates may apply, and how to stop. */
export function hasDisclosure(greeting) {
  const g = String(greeting || "");
  return /\btext\b/i.test(g) && /rates may apply/i.test(g) && /\breply stop\b/i.test(g);
}

/** The greeting as read: the client's, with the disclosure added if it's missing. */
export const spokenGreeting = (greeting) => (hasDisclosure(greeting) ? greeting.trim() : `${String(greeting || "").trim()} ${DISCLOSURE}`.trim());

/** What a first text must contain to match a verified sample's shape. */
export function firstTextProblems(text, name) {
  const t = String(text || "");
  const out = [];
  if (!t.startsWith(`${name}:`)) out.push(`must start with "${name}:" so it names the business`);
  if (!/\bReply STOP\b/.test(t)) out.push('must include "Reply STOP"');
  if (/https?:\/\//i.test(t)) out.push("should not carry a link (the verified samples don't)");
  if (/\b(sale|discount|% off|coupon|promo|deal|offer)\b/i.test(t)) out.push("must not make an offer: it is an informational reply");
  if (t.length > 320) out.push("keep it to two segments (320 characters) or fewer");
  return out;
}

// Twilio's own keywords. With opt-out handling on (the default for a toll-free
// number), Twilio answers these itself and blocks further texts after STOP.
export const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"];
export const START_WORDS = ["START", "YES", "UNSTOP"];
export const HELP_WORDS = ["HELP", "INFO"];

// Plain-language ways of saying stop. Twilio doesn't recognise these, so this
// worker records them and answers them itself. Kept narrow on purpose: "can
// you stop by and text me the quote" must not unsubscribe anyone.
const PLAIN_STOP = [
  /^\W*(stop|stop all|opt out|opt-out|unsubscribe|remove me|quit|cancel|end|revoke)\W*$/i,
  /\b(stop|quit|cease)\s+(texting|messaging|sending|contacting|txting)\b/i,
  /\b(don'?t|do not|never)\s+(text|txt|message|contact)\s+me\b/i,
  /\bno more (texts|text messages|messages)\b/i,
  /\bopt(\s|-)?out\b/i,
  /\bunsubscribe\b/i,
  /\b(remove|take) me (off|from)\b/i,
  /\bwrong number\b/i,
  /\bleave me alone\b/i,
];

/**
 * What an incoming text is, for opt-out purposes:
 *   { kind: "stop" | "start" | "help", byTwilio: bool, keyword }
 *   or { kind: "text" }.
 * byTwilio means Twilio already answered it, so we must not answer again:
 * true when Twilio said so (OptOutType, sent with Advanced Opt-Out), or when
 * the client relies on Twilio's handling and the text is exactly one of its
 * keywords (Twilio matches the whole message, case and spaces aside).
 */
export function classify(body, { optOutType = "", twilioHandles = true } = {}) {
  const raw = String(body || "");
  const word = raw.trim().toUpperCase();
  const t = String(optOutType || "").toUpperCase();
  if (t === "STOP" || t === "START" || t === "HELP") return { kind: t.toLowerCase(), byTwilio: true, exact: true, keyword: word || t };
  if (STOP_WORDS.includes(word)) return { kind: "stop", byTwilio: twilioHandles, exact: true, keyword: word };
  if (START_WORDS.includes(word)) return { kind: "start", byTwilio: twilioHandles, exact: true, keyword: word };
  if (HELP_WORDS.includes(word)) return { kind: "help", byTwilio: twilioHandles, exact: true, keyword: word };
  if (PLAIN_STOP.some((r) => r.test(raw))) return { kind: "stop", byTwilio: false, exact: false, keyword: raw.trim().slice(0, 60) };
  return { kind: "text" };
}

/**
 * The owner's text, as a command:
 *   "To 412-555-0123: on my way"  -> { to: "+14125550123", body: "on my way" }
 *   "To 555: hi"                  -> { error: "bad-number" }
 *   anything else                 -> { body } (goes to the latest conversation)
 */
export function parseOwnerText(text) {
  const t = String(text || "").trim();
  const m = t.match(/^to\s*:?\s*([+(]?\d[\d\s().+-]{1,}\d)\s*[:\-–—]\s*([\s\S]+)$/i);
  if (!m) return { body: t };
  const to = toE164(m[1]);
  if (!to) return { error: "bad-number", raw: m[1] };
  return { to, body: m[2].trim() };
}

// The system's own texts. Each names the business first.
export const helpText = (c) => `${c.name}: texts about your call to ${pretty(c.number)}. Msg & data rates may apply. Reply STOP to opt out.`;
export const stopText = (c) => `${c.name}: You're unsubscribed and won't get more texts from this number. Reply START to resubscribe.`;
export const startText = (c) => `${c.name}: You're resubscribed to texts about your call. Msg & data rates may apply. Reply STOP to opt out.`;

/** Caps what's passed on to the owner, so one long text can't become ten. */
export const clip = (s, n = 600) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
