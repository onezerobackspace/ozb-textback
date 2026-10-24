// A small JSON API for the CRM (later): the clients, their usage against the
// plan, and pausing. Guarded by the x-admin-secret header (ADMIN_SECRET).

import { sameString } from "./twilio.js";
import { easternMonth, nowIso } from "./store.js";

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
    return json({
      ok: true, month, allowance: { texts, minutes },
      clients: (results || []).map((r) => ({
        ...r,
        texts: r.texts_out + r.texts_in,
        over_texts: Math.max(0, r.texts_out + r.texts_in - texts),
        over_minutes: Math.max(0, r.voice_minutes - minutes),
      })),
    });
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
