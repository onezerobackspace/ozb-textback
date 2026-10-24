// Voicemail links. Twilio's own recording URLs need account credentials, so
// the owner gets /vm/<call id>?e=<expiry>&s=<signature> on this worker instead:
// HMAC-SHA256 with VM_LINK_KEY over the id and expiry, good for 7 days. The
// worker fetches the audio from Twilio with the API key and passes it on.

import { twilio, accountOf, sameString } from "./twilio.js";
import { clientById } from "./store.js";

export const VM_LINK_DAYS = 7;
const enc = new TextEncoder();

async function mac(env, id, exp) {
  if (!env.VM_LINK_KEY) throw new Error("VM_LINK_KEY is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(env.VM_LINK_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`vm:${id}:${exp}`)));
  let s = "";
  for (const b of sig.slice(0, 16)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The owner's link for a call's voicemail, expiring `days` from now. */
export async function vmLink(env, callId, { exp = Math.floor(Date.now() / 1000) + VM_LINK_DAYS * 86400 } = {}) {
  const origin = (env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
  return `${origin}/vm/${callId}?e=${exp}&s=${await mac(env, callId, exp)}`;
}

/** True when the link's signature is right and it hasn't expired. */
export async function vmLinkValid(env, callId, exp, sig) {
  if (!env.VM_LINK_KEY || !/^\d+$/.test(String(callId)) || !/^\d{9,11}$/.test(String(exp || "")) || !sig) return false;
  const e = Number(exp);
  const now = Math.floor(Date.now() / 1000);
  if (e < now || e > now + VM_LINK_DAYS * 86400 + 60) return false;
  return sameString(sig, await mac(env, callId, e));
}

const page = (status, text) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Voicemail</title><p style="font:16px system-ui;margin:2rem">${text}</p>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
);

/** GET /vm/<id>?e=&s= */
export async function serveVoicemail(request, env, id) {
  const u = new URL(request.url);
  if (!(await vmLinkValid(env, id, u.searchParams.get("e"), u.searchParams.get("s")))) {
    return page(403, "This voicemail link isn't valid or has expired. Voicemails can be played for 7 days.");
  }
  const call = await env.DB.prepare("SELECT * FROM calls WHERE id = ?1").bind(Number(id)).first();
  if (!call || !call.recording_sid || call.recording_deleted_at) return page(410, "This voicemail has been deleted.");
  const client = await clientById(env, call.client_id);
  if (!client) return page(410, "This voicemail has been deleted.");
  const res = await twilio(env, accountOf(client, env)).fetchRecording(call.recording_sid);
  if (!res.ok) return page(res.status === 404 ? 410 : 502, res.status === 404 ? "This voicemail has been deleted." : "Couldn't fetch the voicemail. Try again in a minute.");
  return new Response(res.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="voicemail-${call.id}.mp3"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
