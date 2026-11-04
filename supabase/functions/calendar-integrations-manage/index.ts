import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function verifyOwnership(id: string, userId: string) {
  const { data, error } = await admin
    .from("calendar_integrations")
    .select("id,user_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.user_id !== userId) {
    throw new Error("Calendar integration not found");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").trim();

    if (action === "load") {
      const { data, error } = await admin
        .from("calendar_integrations")
        .select("id,user_id,provider,display_name,api_key,access_token,refresh_token,token_expires_at,calendar_id,is_active,config,created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return json(200, { integrations: data || [] });
    }

    if (action === "upsert") {
      const provider = String(body?.provider || "").trim();
      const payload = body?.payload && typeof body.payload === "object"
        ? body.payload as Record<string, unknown>
        : null;

      if (!provider || !payload) return json(400, { error: "provider and payload are required" });

      const { data: existing, error: existingError } = await admin
        .from("calendar_integrations")
        .select("id,config,refresh_token")
        .eq("user_id", user.id)
        .eq("provider", provider)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) throw existingError;

      const mergedPayload = {
        user_id: user.id,
        provider,
        display_name: payload.display_name ?? provider,
        api_key: payload.api_key ?? null,
        access_token: payload.access_token ?? null,
        refresh_token: payload.refresh_token ?? existing?.refresh_token ?? null,
        token_expires_at: payload.token_expires_at ?? null,
        calendar_id: payload.calendar_id ?? null,
        is_active: payload.is_active ?? true,
        config: {
          ...(existing?.config || {}),
          ...((payload.config && typeof payload.config === "object") ? payload.config as Record<string, unknown> : {}),
        },
      };

      if (existing?.id) {
        const { error } = await admin
          .from("calendar_integrations")
          .update(mergedPayload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await admin.from("calendar_integrations").insert(mergedPayload);
        if (error) throw error;
      }

      return json(200, { success: true });
    }

    if (action === "disconnect") {
      const integrationId = String(body?.integrationId || "").trim();
      if (!integrationId) return json(400, { error: "integrationId is required" });
      await verifyOwnership(integrationId, user.id);

      const { error: detachError } = await admin
        .from("appointment_tools")
        .update({ calendar_integration_id: null })
        .eq("calendar_integration_id", integrationId);
      if (detachError) throw detachError;

      const { error } = await admin
        .from("calendar_integrations")
        .delete()
        .eq("id", integrationId);
      if (error) throw error;

      return json(200, { success: true });
    }

    if (action === "toggle") {
      const integrationId = String(body?.integrationId || "").trim();
      const isActive = Boolean(body?.isActive);
      if (!integrationId) return json(400, { error: "integrationId is required" });
      await verifyOwnership(integrationId, user.id);

      const { error } = await admin
        .from("calendar_integrations")
        .update({ is_active: isActive })
        .eq("id", integrationId);
      if (error) throw error;

      return json(200, { success: true });
    }

    if (action === "test") {
      const integrationId = String(body?.integrationId || "").trim();
      const provider = String(body?.provider || "").trim();
      if (!integrationId || !provider) return json(400, { error: "integrationId and provider are required" });
      await verifyOwnership(integrationId, user.id);

      const response = await fetch(`${supabaseUrl}/functions/v1/check-calendar-availability`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          provider,
          integration_id: integrationId,
          test: true,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      return json(response.status, payload);
    }

    return json(400, { error: "Unsupported action" });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
