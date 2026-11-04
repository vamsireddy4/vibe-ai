import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  const localUserId = (Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? (req.headers.get("x-local-user-id") || "").trim() : "");
  if (localUserId) {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("user_id, id")
      .or(`user_id.eq.${localUserId},id.eq.${localUserId}`)
      .maybeSingle();

    if (error || !profile) return null;

    const { data: userLookup, error: userLookupError } = await admin.auth.admin.getUserById(profile.user_id);
    if (userLookupError || !userLookup?.user) return null;

    return { id: userLookup.user.id, email: userLookup.user.email ?? null };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email ?? null };
}

async function verifyOwnership(id: string, userId: string) {
  const { data, error } = await admin
    .from("phone_configs")
    .select("id,user_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.user_id !== userId) {
    throw new Error("Phone config not found");
  }
}

async function verifyAgentOwnership(id: string, userId: string) {
  const { data, error } = await admin.from("agents").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Agent not found");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "").trim();

    if (action === "upsert") {
      const editingId = String(body?.editingId || "").trim();
      const data = body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
      if (!data) return json(400, { error: "data is required" });
      // Never trust ownership/agent links from the body.
      data.user_id = user.id;
      if (data.inbound_agent_id) await verifyAgentOwnership(String(data.inbound_agent_id), user.id);

      if (editingId) {
        await verifyOwnership(editingId, user.id);
        const { error } = await admin.from("phone_configs").update(data).eq("id", editingId);
        if (error) throw error;
        return json(200, { success: true });
      }

      const { error } = await admin.from("phone_configs").insert(data);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === "updateProviderCredentials") {
      const provider = String(body?.provider || "").trim();
      const channel = String(body?.channel || "").trim();
      const credentials = body?.credentials && typeof body.credentials === "object"
        ? body.credentials as Record<string, unknown>
        : null;

      if (!provider || !channel || !credentials) {
        return json(400, { error: "provider, channel, and credentials are required" });
      }

      const updatePayload: Record<string, unknown> = {};

      if (provider === "twilio") {
        updatePayload.twilio_account_sid = String(credentials.twilio_account_sid || "").trim() || null;
        updatePayload.twilio_auth_token = String(credentials.twilio_auth_token || "").trim() || null;
      } else if (provider === "telnyx") {
        updatePayload.telnyx_api_key = String(credentials.telnyx_api_key || "").trim() || null;
        updatePayload.telnyx_connection_id = String(credentials.telnyx_connection_id || "").trim() || null;
        updatePayload.telnyx_public_key = String(credentials.telnyx_public_key || "").trim() || null;
      } else {
        return json(400, { error: "Unsupported provider" });
      }

      const { error } = await admin
        .from("phone_configs")
        .update(updatePayload)
        .eq("user_id", user.id)
        .eq("provider", provider)
        .eq("channel", channel);

      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === "delete") {
      const id = String(body?.id || "").trim();
      if (!id) return json(400, { error: "id is required" });
      await verifyOwnership(id, user.id);

      await Promise.all([
        admin.from("campaign_phone_configs").delete().eq("phone_config_id", id),
        admin.from("campaigns").update({ phone_config_id: null }).eq("phone_config_id", id),
        admin.from("agents").update({ phone_number_id: null }).eq("phone_number_id", id),
      ]);
      const { error } = await admin.from("phone_configs").delete().eq("id", id);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === "toggleActive") {
      const id = String(body?.id || "").trim();
      const isActive = Boolean(body?.isActive);
      if (!id) return json(400, { error: "id is required" });
      await verifyOwnership(id, user.id);
      const { error } = await admin.from("phone_configs").update({ is_active: isActive }).eq("id", id);
      if (error) throw error;
      return json(200, { success: true });
    }

    if (action === "setInboundAgent") {
      const id = String(body?.id || "").trim();
      const inboundAgentId = body?.inboundAgentId ? String(body.inboundAgentId).trim() : null;
      if (!id) return json(400, { error: "id is required" });
      await verifyOwnership(id, user.id);
      if (inboundAgentId) await verifyAgentOwnership(inboundAgentId, user.id);
      const { error } = await admin.from("phone_configs").update({ inbound_agent_id: inboundAgentId || null }).eq("id", id);
      if (error) throw error;
      return json(200, { success: true });
    }

    return json(400, { error: "Unsupported action" });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
