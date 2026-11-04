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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const campaignId = String(body?.campaignId || "").trim();
    const phoneIds = Array.isArray(body?.phoneIds)
      ? body.phoneIds.map((value: unknown) => String(value || "").trim()).filter(Boolean)
      : [];

    if (!campaignId) return json(400, { error: "campaignId is required" });

    const { data: campaign, error: campaignError } = await admin
      .from("campaigns")
      .select("id,user_id")
      .eq("id", campaignId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign || campaign.user_id !== user.id) {
      return json(404, { error: "Campaign not found" });
    }

    const normalizedPhoneIds = Array.from(new Set(phoneIds));

    const { error: deleteError } = await admin
      .from("campaign_phone_configs")
      .delete()
      .eq("campaign_id", campaignId);

    if (deleteError) throw deleteError;

    if (normalizedPhoneIds.length === 0) {
      return json(200, { success: true, rows: 0 });
    }

    const { data: ownedPhoneConfigs, error: phoneConfigsError } = await admin
      .from("phone_configs")
      .select("id")
      .eq("user_id", user.id)
      .in("id", normalizedPhoneIds);

    if (phoneConfigsError) throw phoneConfigsError;

    const ownedIds = new Set((ownedPhoneConfigs || []).map((row) => row.id));
    const invalidPhoneId = normalizedPhoneIds.find((phoneId) => !ownedIds.has(phoneId));
    if (invalidPhoneId) {
      return json(400, { error: `Phone config not found: ${invalidPhoneId}` });
    }

    const rows = normalizedPhoneIds.map((phoneId, index) => ({
      user_id: user.id,
      campaign_id: campaignId,
      phone_config_id: phoneId,
      sort_order: index,
    }));

    const { error: insertError } = await admin
      .from("campaign_phone_configs")
      .insert(rows);

    if (insertError) throw insertError;

    return json(200, { success: true, rows: rows.length });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
