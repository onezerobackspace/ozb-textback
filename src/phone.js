// Phone numbers: what Twilio hands us, what we may text, how a person reads one.

/** A dialable US/Canada number in E.164: +1, then NXX-NXX-XXXX. */
export const isNanp = (n) => typeof n === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(n);

/**
 * Twilio's From for a caller who hid their number. Twilio spells these out on
 * a keypad (+266696687 is ANONYMOUS, +7378742833 RESTRICTED, +86282452253
 * UNKNOWN, +2562533 BLOCKED); some carriers send words instead. Other junk
 * fails isNanp anyway.
 */
const HIDDEN = new Set(["266696687", "7378742833", "86282452253", "2562533",
  "anonymous", "restricted", "unavailable", "unknown", "private", "blocked"]);
export function isAnonymous(n) {
  if (n == null) return true;
  const s = String(n).trim().toLowerCase().replace(/^\+/, "");
  return s === "" || HIDDEN.has(s);
}

/** A five- or six-digit sender, with or without a plus. */
export const isShortCode = (n) => typeof n === "string" && /^\+?\d{5,6}$/.test(n.trim());

/**
 * Whatever a person typed ("412-555-0123", "(412) 555 0123", "1 412 555 0123",
 * "+14125550123") as E.164, or null when it isn't a US/Canada number.
 */
export function toE164(raw) {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.length === 10) d = "1" + d;
  const e = "+" + d;
  return isNanp(e) ? e : null;
}

/** +14125550123 -> (412) 555-0123. Anything else comes back as it was. */
export function pretty(n) {
  return isNanp(n) ? `(${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8)}` : String(n ?? "");
}

/** 42 -> 0:42, 125 -> 2:05. */
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
