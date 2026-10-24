// ozb-textback: missed-call text-back for One Zero Backspace and its clients.
// See README.md for how a call flows and how a client is set up.

import { verifyTwilio } from "./twilio.js";
import { voice, voiceDone, voiceStatus, recording } from "./voice.js";
import { sms, status } from "./sms.js";
import { serveVoicemail } from "./vm.js";
import { admin } from "./admin.js";
import { purgeOld } from "./retention.js";

// Every Twilio webhook: POST, form-encoded, signed.
const WEBHOOKS = {
  "/voice": voice,
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
      return hook(env, signed.params, signed.accountSid);
    }

    const vm = path.match(/^\/vm\/(\d+)$/);
    if (vm && request.method === "GET") return serveVoicemail(request, env, vm[1]);

    if (path.startsWith("/admin/")) return admin(request, env, path);

    if (path === "/health") return Response.json({ ok: true });
    return text("Not found", 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOld(env).then((r) => console.log("retention", JSON.stringify(r))));
  },
};
