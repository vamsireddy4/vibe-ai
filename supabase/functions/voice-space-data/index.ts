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
    console.warn("[voice-space-data] auth user resolution failed", error);
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
    const agentId = String(body?.agentId || "").trim();
    const userIds = await resolveRelatedUserIds(user.id, user.email);

    if (userIds.length === 0) {
      return json(200, {
        relatedUserIds: [],
        agents: [],
        phoneConfigs: [],
        calendarIntegrations: [],
        callLogs: [],
        forwardingNumbers: [],
      });
    }

    const [
      { data: agents, error: agentsError },
      { data: phoneConfigs, error: phoneConfigsError },
      { data: calendarIntegrations, error: calendarError },
      { data: callLogs, error: callLogsError },
      { data: forwardingNumbers, error: forwardingError },
    ] = await Promise.all([
      admin.from("agents").select("*").in("user_id", userIds).order("created_at", { ascending: false }),
      admin.from("phone_configs").select("*").in("user_id", userIds).order("created_at", { ascending: false }),
      admin
        .from("calendar_integrations")
        .select("id,user_id,provider,display_name,api_key,access_token,refresh_token,token_expires_at,calendar_id,is_active,config,created_at")
        .in("user_id", userIds)
        .order("created_at", { ascending: true }),
      admin.from("call_logs").select("*,agents(name)").in("user_id", userIds).order("started_at", { ascending: false }),
      agentId
        ? admin
            .from("call_forwarding_numbers")
            .select("id,phone_number,label,priority,agent_id,user_id")
            .eq("agent_id", agentId)
            .in("user_id", userIds)
            .order("priority", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

    const firstError =
      agentsError ||
      phoneConfigsError ||
      calendarError ||
      callLogsError ||
      forwardingError;

    if (firstError) throw firstError;

    return json(200, {
      relatedUserIds: userIds,
      agents: agents || [],
      phoneConfigs: phoneConfigs || [],
      calendarIntegrations: calendarIntegrations || [],
      callLogs: callLogs || [],
      forwardingNumbers: forwardingNumbers || [],
    });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
