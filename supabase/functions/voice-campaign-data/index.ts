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

async function resolveRelatedUserIds(userId: string, userEmail?: string | null) {
  const relatedUserIds = new Set<string>();
  if (userId) relatedUserIds.add(userId);

  const normalizedEmail = String(userEmail || "").trim().toLowerCase();
  if (!normalizedEmail) return Array.from(relatedUserIds);

  try {
    const { data: listedUsers, error: listUsersError } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (!listUsersError) {
      for (const authUser of listedUsers.users || []) {
        if ((authUser.email || "").trim().toLowerCase() === normalizedEmail) {
          relatedUserIds.add(authUser.id);
        }
      }
    }
  } catch (error) {
    console.warn("[voice-campaign-data] auth user resolution failed", error);
  }

  return Array.from(relatedUserIds);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const campaignId = String(body?.campaignId || "").trim();
    const userIds = await resolveRelatedUserIds(user.id, user.email);

    if (userIds.length === 0) {
      return json(200, { campaigns: [], agents: [], phoneConfigs: [], campaignPhoneConfigs: [], contacts: [], callOutcomes: [], callLogs: [], doNotCall: [] });
    }

    if (!campaignId) {
      const [
        { data: campaigns, error: campaignsError },
        { data: agents, error: agentsError },
        { data: phoneConfigs, error: phoneConfigsError },
        { data: campaignPhoneConfigs, error: campaignPhonesError },
        { data: contacts, error: contactsError },
        { data: callOutcomes, error: outcomesError },
        { data: callLogs, error: callLogsError },
        { data: doNotCall, error: dncError },
      ] = await Promise.all([
        admin.from("campaigns").select("*").in("user_id", userIds).order("created_at", { ascending: false }),
        admin.from("agents").select("id,name,is_active").in("user_id", userIds),
        admin.from("phone_configs").select("id,phone_number,friendly_name,provider,channel,user_id,is_active").in("user_id", userIds).eq("is_active", true),
        admin.from("campaign_phone_configs").select("campaign_id,phone_config_id,sort_order").in("user_id", userIds).order("sort_order", { ascending: true }),
        admin.from("contacts").select("*").in("user_id", userIds).order("created_at", { ascending: true }),
        admin.from("call_outcomes").select("*").in("user_id", userIds).order("call_timestamp", { ascending: false }),
        admin.from("call_logs").select("id,recipient_number,caller_number,status,duration,started_at,ended_at,summary,transcript,ultravox_call_id,agent_id,direction,user_id").in("user_id", userIds).order("started_at", { ascending: false }),
        admin.from("do_not_call").select("phone_number").in("user_id", userIds),
      ]);

      const firstError =
        campaignsError || agentsError || phoneConfigsError || campaignPhonesError || contactsError || outcomesError || callLogsError || dncError;

      if (firstError) throw firstError;

      return json(200, {
        campaigns: campaigns || [],
        agents: agents || [],
        phoneConfigs: phoneConfigs || [],
        campaignPhoneConfigs: campaignPhoneConfigs || [],
        contacts: contacts || [],
        callOutcomes: callOutcomes || [],
        callLogs: callLogs || [],
        doNotCall: doNotCall || [],
      });
    }

    // One campaign: it must belong to the caller (the queries below use the service role).
    const { data: ownCampaign } = await admin.from("campaigns").select("id").eq("id", campaignId).in("user_id", userIds).maybeSingle();
    if (!ownCampaign) return json(404, { error: "Campaign not found" });

    const [
      { data: contacts, error: contactsError },
      { data: callOutcomes, error: outcomesError },
      { data: callLogs, error: callLogsError },
    ] = await Promise.all([
      admin.from("contacts").select("*").eq("campaign_id", campaignId).order("created_at", { ascending: true }),
      admin.from("call_outcomes").select("*").eq("campaign_id", campaignId).order("created_at", { ascending: false }),
      admin.from("call_logs").select("id,recipient_number,caller_number,status,duration,started_at,ended_at,summary,transcript,ultravox_call_id,agent_id,direction,user_id").in("user_id", userIds).eq("direction", "outbound").order("started_at", { ascending: false }),
    ]);

    const firstError = contactsError || outcomesError || callLogsError;
    if (firstError) throw firstError;

    return json(200, {
      contacts: contacts || [],
      callOutcomes: callOutcomes || [],
      callLogs: callLogs || [],
    });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
