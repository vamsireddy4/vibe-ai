// Calendar integrations (calendar_integrations rows) for the signed-in user. Uses the Supabase service role,
// so every query is pinned to the verified caller's own rows. Plain in/out: shared by the Vite dev server
// and the Cloudflare Pages Function.
type Reply = { status: number; body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

/**
 * POST /api/local/calendar-integrations  (Authorization: Bearer <Clerk token>)
 *   load {providers?} | test {integrationId, provider} | disconnect {integrationId}
 *   toggle {integrationId, isActive} | upsert {provider, payload}
 */
export async function calendarHandle(body: any, callerId: string | null, env: { supabaseUrl: string; serviceRoleKey: string }): Promise<Reply> {
  if (!callerId) return reply(401, { error: "Sign in again to manage calendars." });
  const { supabaseUrl, serviceRoleKey } = env;
  if (!supabaseUrl || !serviceRoleKey) return reply(500, { error: "Supabase service role credentials are not configured" });

  const action = String(body?.action || "").trim();
  const provider = String(body?.provider || "").trim();
  const integrationId = String(body?.integrationId || "").trim();
  const isActive = typeof body?.isActive === "boolean" ? body.isActive : null;
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : null;
  const providers: string[] = Array.isArray(body?.providers) ? body.providers.filter((v: unknown) => typeof v === "string" && v.trim()) : [];

  const rest = `${supabaseUrl}/rest/v1`;
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  const mine = `user_id=eq.${encodeURIComponent(callerId)}`;
  const call = async (url: string, init: RequestInit = {}) => {
    const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  };
  // Only act on an integration this caller owns.
  const owns = async () => {
    const r = await call(`${rest}/calendar_integrations?select=id&id=eq.${encodeURIComponent(integrationId)}&${mine}&limit=1`);
    return r.ok && Array.isArray(r.data) && r.data.length > 0;
  };

  if (action === "load") {
    const providerQuery = providers.length ? `&provider=in.(${providers.map((v) => `"${v}"`).join(",")})` : "";
    const r = await call(`${rest}/calendar_integrations?select=id,provider,display_name,calendar_id,is_active,config,created_at&${mine}${providerQuery}&order=created_at.asc`);
    if (!r.ok) return reply(500, { error: "Failed to load calendar integrations", details: r.data });
    return reply(200, { integrations: Array.isArray(r.data) ? r.data : [] });
  }

  if (action === "test") {
    if (!integrationId || !provider) return reply(400, { error: "integrationId and provider are required" });
    if (!(await owns())) return reply(404, { error: "Calendar not found" });
    const r = await call(`${supabaseUrl}/functions/v1/check-calendar-availability`, {
      method: "POST",
      headers: { "x-local-user-id": callerId },
      body: JSON.stringify({ provider, integration_id: integrationId, test: true }),
    });
    return reply(r.ok ? 200 : r.status, r.data ?? {});
  }

  if (action === "disconnect") {
    if (!integrationId) return reply(400, { error: "integrationId is required" });
    if (!(await owns())) return reply(404, { error: "Calendar not found" });
    const detach = await call(`${rest}/appointment_tools?calendar_integration_id=eq.${encodeURIComponent(integrationId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ calendar_integration_id: null }),
    });
    if (!detach.ok) return reply(500, { error: "Failed to detach appointment tools", details: detach.data });
    const del = await call(`${rest}/calendar_integrations?id=eq.${encodeURIComponent(integrationId)}&${mine}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    if (!del.ok) return reply(500, { error: "Failed to delete calendar integration", details: del.data });
    return reply(200, { success: true });
  }

  if (action === "toggle") {
    if (!integrationId || typeof isActive !== "boolean") return reply(400, { error: "integrationId and isActive are required" });
    const r = await call(`${rest}/calendar_integrations?id=eq.${encodeURIComponent(integrationId)}&${mine}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ is_active: isActive }),
    });
    if (!r.ok) return reply(500, { error: "Failed to update calendar integration", details: r.data });
    return reply(200, { integration: Array.isArray(r.data) ? r.data[0] || null : r.data });
  }

  if (action === "upsert") {
    if (!provider || !payload) return reply(400, { error: "provider and payload are required" });
    const found = await call(`${rest}/calendar_integrations?select=id,refresh_token,config&provider=eq.${encodeURIComponent(provider)}&${mine}&order=created_at.desc&limit=1`);
    if (!found.ok) return reply(500, { error: "Failed to load existing calendar integration", details: found.data });
    const existing = Array.isArray(found.data) ? found.data[0] || null : null;
    const next = {
      ...payload,
      user_id: callerId, // after the spread: the body can never pick the owner
      provider,
      is_active: true,
      refresh_token: payload.refresh_token ?? existing?.refresh_token ?? null,
      config: { ...(existing?.config && typeof existing.config === "object" ? existing.config : {}), ...(payload.config && typeof payload.config === "object" ? payload.config : {}) },
    };
    const r = await call(existing?.id ? `${rest}/calendar_integrations?id=eq.${encodeURIComponent(existing.id)}&${mine}` : `${rest}/calendar_integrations`, {
      method: existing?.id ? "PATCH" : "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(next),
    });
    if (!r.ok) return reply(500, { error: "Failed to save calendar integration", details: r.data });
    return reply(200, { integration: Array.isArray(r.data) ? r.data[0] || null : r.data });
  }

  return reply(400, { error: "Unsupported action" });
}
