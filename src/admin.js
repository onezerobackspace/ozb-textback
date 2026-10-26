// A small JSON API for the CRM (later): the clients, their usage against the
// plan, and pausing. Guarded by the x-admin-secret header (ADMIN_SECRET).

import { sameString } from "./twilio.js";
import { clientById, easternMonth, nowIso } from "./store.js";
import { overview, saveWording, voicemail } from "./portal.js";
import { setTexting } from "./spend.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export const adminAllowed = (request, env) => sameString(request.headers.get("x-admin-secret") || "", env.ADMIN_SECRET || "");

export async function admin(request, env, path) {
  if (!adminAllowed(request, env)) return json({ ok: false, error: "unauthorized" }, 401);

  if (path === "/admin/clients" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM clients ORDER BY id").all();
    return json({ ok: true, clients: results || [] });
  }

  if (path === "/admin/usage" && request.method === "GET") {
    const month = new URL(request.url).searchParams.get("month") || easternMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: "month must look like 2026-10" }, 400);
    const texts = Number(env.PLAN_TEXTS || 300);
    const minutes = Number(env.PLAN_MINUTES || 60);
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.name, c.status, COALESCE(u.texts_out, 0) AS texts_out, COALESCE(u.texts_in, 0) AS texts_in,
              COALESCE(u.voice_minutes, 0) AS voice_minutes
         FROM clients c LEFT JOIN usage u ON u.client_id = c.id AND u.month = ?1 ORDER BY c.id`,
    ).bind(month).all();
    // The last 30 days of calls: why callers weren't texted, and what Twilio's
    // caller ID check (StirVerstat) said, so a wave of spoofed calls shows up.
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { results: why } = await env.DB.prepare(
      "SELECT client_id, COALESCE(why_not_texted, CASE WHEN texted = 1 THEN 'texted' ELSE 'pending' END) AS k, COUNT(*) AS n FROM calls WHERE at > ?1 GROUP BY 1, 2",
    ).bind(since).all();
    const { results: stir } = await env.DB.prepare(
      "SELECT client_id, COALESCE(stir_verstat, 'none') AS k, COUNT(*) AS n FROM calls WHERE at > ?1 GROUP BY 1, 2",
    ).bind(since).all();
    const tally = (rows, id) => Object.fromEntries((rows || []).filter((r) => r.client_id === id).map((r) => [r.k, r.n]));
    return json({
      ok: true, month, allowance: { texts, minutes },
      clients: (results || []).map((r) => ({
        ...r,
        texts: r.texts_out + r.texts_in,
        over_texts: Math.max(0, r.texts_out + r.texts_in - texts),
        over_minutes: Math.max(0, r.voice_minutes - minutes),
        calls_30_days: tally(why, r.id),
        caller_id_30_days: tally(stir, r.id),
      })),
    });
  }

  // The client portal: one client's page, its wording, its voicemails (src/portal.js).
  const pm = path.match(/^\/admin\/clients\/(\d+)\/(portal|wording|texting|calls\/(\d+)\/voicemail)$/);
  if (pm) {
    const client = await clientById(env, Number(pm[1]));
    if (!client) return json({ ok: false, error: "no such client" }, 404);
    if (pm[2] === "portal" && request.method === "GET") return json({ ok: true, ...(await overview(env, client)) });
    if (pm[2] === "texting" && request.method === "POST") return setTexting(env, client, await request.json().catch(() => ({})));
    if (pm[2] === "wording" && request.method === "PUT") return saveWording(env, client, await request.json().catch(() => ({})));
    if (pm[3] && request.method === "GET") return voicemail(env, client, Number(pm[3]), new URL(request.url).searchParams.has("download"));
    return json({ ok: false, error: "not allowed" }, 405);
  }

  const m = path.match(/^\/admin\/clients\/(\d+)\/status$/);
  if (m && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.status !== "active" && body.status !== "paused") return json({ ok: false, error: "status must be active or paused" }, 400);
    const r = await env.DB.prepare(
      "UPDATE clients SET status = ?2, paused_at = CASE WHEN ?2 = 'paused' THEN ?3 ELSE NULL END WHERE id = ?1",
    ).bind(Number(m[1]), body.status, nowIso()).run();
    if (!r.meta?.changes) return json({ ok: false, error: "no such client" }, 404);
    return json({ ok: true });
  }

  return json({ ok: false, error: "not found" }, 404);
}
