// ozb-textback: missed-call text-back for One Zero Backspace and its clients.
// See README.md for how a call flows and how a client is set up.

import { verifyTwilio, twiml } from "./twilio.js";
import { voice, voiceHeard, voiceDone, voiceStatus, recording, safeGreeting, recordOnly } from "./voice.js";
import { sms, status } from "./sms.js";
import { serveVoicemail } from "./vm.js";
import { admin } from "./admin.js";
import { textingPage } from "./portal.js";
import { purgeOld } from "./retention.js";

// Every Twilio webhook: POST, form-encoded, signed.
const WEBHOOKS = {
  "/voice": voice,
  "/voice/heard": voiceHeard,
  "/voice/done": voiceDone,
  "/voice/status": voiceStatus,
  "/recording": recording,
  "/sms": sms,
  "/status": status,
};

const text = (body, status) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const hook = WEBHOOKS[path];
    if (hook) {
      if (request.method !== "POST") return text("Method not allowed", 405);
      const signed = await verifyTwilio(request, env);
      if (!signed) return text("Forbidden", 403);
      try {
        return await hook(env, signed.params, signed.accountSid);
      } catch (e) {
        // Never Twilio's "an application error has occurred" to a caller: a
        // call still gets a greeting (without the texting promise) and the
        // beep, so the voicemail is kept at Twilio. Other webhooks get an
        // empty answer; the error is in the worker's logs.
        console.log("webhook failed", path, String(e?.message || e).slice(0, 300));
        if (path === "/voice") return safeGreeting(env);
        if (path === "/voice/heard") return recordOnly(env);
        if (path === "/voice/done") return twiml("<Hangup/>");
        return path === "/sms" ? twiml() : new Response(null, { status: 204 });
      }
    }

    const vm = path.match(/^\/vm\/(\d+)$/);
    if (vm && request.method === "GET") return serveVoicemail(request, env, vm[1]);

    if (path.startsWith("/admin/")) return admin(request, env, path);

    const page = path.match(/^\/texting\/(\d+)$/);
    if (page && request.method === "GET") return textingPage(env, Number(page[1]));

    if (path === "/health") return Response.json({ ok: true });
    return text("Not found", 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOld(env).then((r) => console.log("retention", JSON.stringify(r))));
  },
};
