// Everything that talks to Twilio, or checks that Twilio is talking to us.
//
// Outgoing: one API key (TWILIO_API_KEY_SID/SECRET, made on OZB's main
// account) for every REST call. The account in the URL picks whose number,
// messages and recordings they are, so the same key acts on a client's
// subaccount by passing that subaccount's SID.
//
// Incoming: Twilio signs every webhook with the auth token of the account that
// owns the number. Tokens can't come from an API key, so each account's token
// is a secret: TWILIO_AUTH_TOKEN for the main account, and
// TWILIO_AUTH_TOKEN_<subaccount SID> for each client on a subaccount.

const API = "https://api.twilio.com/2010-04-01";
const LOOKUP = "https://lookups.twilio.com/v2/PhoneNumbers";

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const RECORDING_SID = /^RE[0-9a-f]{32}$/i;
const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/i;
const CALL_SID = /^CA[0-9a-f]{32}$/i;

const enc = new TextEncoder();

function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Compares two strings in time that doesn't depend on where they differ. */
export function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Twilio's signature: HMAC-SHA1, keyed with the auth token, over the full URL
 * Twilio requested followed by every POST parameter's name and value, sorted
 * by name; base64.
 */
export async function twilioSignature(authToken, url, params) {
  const pairs = [...params].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  let data = url;
  for (const [k, v] of pairs) data += k + v;
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** The auth token Twilio signs with for this account, or null for one we don't know. */
export function authTokenFor(env, accountSid) {
  if (!accountSid || !ACCOUNT_SID.test(accountSid)) return null;
  if (env.TWILIO_ACCOUNT_SID && accountSid === env.TWILIO_ACCOUNT_SID) return env.TWILIO_AUTH_TOKEN || null;
  return env[`TWILIO_AUTH_TOKEN_${accountSid}`] || null;
}

/**
 * The URL Twilio signed. Twilio was given PUBLIC_ORIGIN, so that is what it
 * signs; using it rather than the Host header means a request sent to any
 * other hostname fails the check.
 */
export function signedUrl(request, env) {
  const u = new URL(request.url);
  const origin = env.PUBLIC_ORIGIN ? env.PUBLIC_ORIGIN.replace(/\/$/, "") : u.origin;
  return origin + u.pathname + u.search;
}

/**
 * Checks a webhook. Returns { params, accountSid } when Twilio signed it with
 * the token of the account it names, else null. The body is read here.
 */
export async function verifyTwilio(request, env) {
  const given = request.headers.get("X-Twilio-Signature");
  if (!given) return null;
  const type = request.headers.get("Content-Type") || "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const params = new URLSearchParams(await request.text());
  const accountSid = params.get("AccountSid");
  const token = authTokenFor(env, accountSid);
  if (!token) return null;
  const expected = await twilioSignature(token, signedUrl(request, env), params);
  if (!sameString(given, expected)) return null;
  return { params, accountSid };
}

/** The account a client's number lives on. */
export const accountOf = (client, env) => client.twilio_subaccount_sid || env.TWILIO_ACCOUNT_SID;

/** A REST client acting on one account (main or subaccount). */
export function twilio(env, accountSid) {
  if (!ACCOUNT_SID.test(accountSid || "")) throw new Error("not a Twilio account SID");
  const auth = "Basic " + btoa(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`);
  const base = `${API}/Accounts/${accountSid}`;

  return {
    /**
     * Sends one text. Never throws for Twilio's refusals: { ok:false,
     * errorCode } comes back instead, e.g. 21610 when the person has replied
     * STOP to this number. 30032 (toll-free number not verified yet) comes
     * later, on the status callback.
     */
    async sendMessage({ from, to, body, statusCallback }) {
      const form = new URLSearchParams({ From: from, To: to, Body: body });
      if (statusCallback) form.set("StatusCallback", statusCallback);
      let res;
      try {
        res = await fetch(`${base}/Messages.json`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
      } catch (e) {
        return { ok: false, status: "failed", errorCode: "network", errorMessage: String(e?.message || e) };
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, status: "failed", errorCode: data.code != null ? String(data.code) : String(res.status), errorMessage: data.message || "" };
      }
      return { ok: true, sid: data.sid, status: data.status || "queued" };
    },

    /** Twilio Lookup's line type ("mobile", "landline", "nonFixedVoip"...), or null if it couldn't say. Billed per lookup. */
    async lineType(phone) {
      try {
        const res = await fetch(`${LOOKUP}/${encodeURIComponent(phone)}?Fields=line_type_intelligence`, { headers: { Authorization: auth } });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.line_type_intelligence?.type || null;
      } catch { return null; }
    },

    /** The recording's audio, as Twilio's Response. */
    async fetchRecording(recordingSid) {
      if (!RECORDING_SID.test(recordingSid || "")) return new Response(null, { status: 404 });
      return fetch(`${base}/Recordings/${recordingSid}.mp3`, { headers: { Authorization: auth } });
    },

    /** Deletes a recording. True when it's gone (deleted now, or already). */
    deleteRecording: (sid) => remove(RECORDING_SID, "Recordings", sid),

    /** Deletes a message (its body and numbers) from Twilio's logs. True when it's gone. */
    deleteMessage: (sid) => remove(MESSAGE_SID, "Messages", sid),

    /** Deletes a finished call's record from Twilio's logs. True when it's gone. */
    deleteCall: (sid) => remove(CALL_SID, "Calls", sid),

    /**
     * The SIDs of a call's recordings, including any whose /recording callback
     * never arrived. Null when Twilio couldn't be asked (try again tomorrow).
     */
    async callRecordings(callSid) {
      if (!CALL_SID.test(callSid || "")) return [];
      try {
        const res = await fetch(`${base}/Recordings.json?CallSid=${callSid}&PageSize=50`, { headers: { Authorization: auth } });
        if (res.status === 404) return [];
        if (!res.ok) return null;
        const data = await res.json();
        return (data?.recordings || []).map((r) => r.sid).filter((s) => RECORDING_SID.test(s || ""));
      } catch { return null; }
    },
  };

  /** DELETE one resource. A SID that isn't one has nothing at Twilio, so it counts as gone. */
  async function remove(pattern, kind, sid) {
    if (!pattern.test(sid || "")) return true;
    try {
      const res = await fetch(`${base}/${kind}/${sid}.json`, { method: "DELETE", headers: { Authorization: auth } });
      return res.status === 204 || res.status === 404;
    } catch { return false; }
  }
}

/** Escapes text for TwiML. */
export const xml = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/** A TwiML reply. */
export const twiml = (inner = "") => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
  headers: { "Content-Type": "text/xml; charset=utf-8" },
});
