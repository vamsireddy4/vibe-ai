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
    console.warn("[agent-crm-data] auth user resolution failed", error);
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
    const action = String(body?.action || "").trim();
    const agentId = String(body?.agentId || "").trim();

    if (!agentId) return json(400, { error: "agentId is required" });

    if (action === "load") {
      const relatedUserIds = await resolveRelatedUserIds(user.id, user.email);

      const [agentResponse, integrationsResponse] = await Promise.all([
        admin
          .from("agents")
          .select("gmail_body_template,custom_crm_providers,use_google_docs")
          .eq("id", agentId)
          .in("user_id", relatedUserIds)
          .maybeSingle(),
        admin
          .from("calendar_integrations")
          .select("id,provider,display_name")
          .in("provider", ["gmail", "google_docs", "google_sheets"])
          .in("user_id", relatedUserIds)
          .order("created_at", { ascending: true }),
      ]);

      if (agentResponse.error) {
        return json(500, { error: "Failed to load agent CRM data", details: agentResponse.error.message });
      }
      if (integrationsResponse.error) {
        return json(500, { error: "Failed to load CRM integrations", details: integrationsResponse.error.message });
      }

      return json(200, {
        agent: agentResponse.data || null,
        integrations: integrationsResponse.data || [],
      });
    }

    if (action === "updateProviders") {
      const providerIds = Array.isArray(body?.providerIds)
        ? body.providerIds.filter((value: unknown): value is string => typeof value === "string")
        : [];

      const { data, error } = await admin
        .from("agents")
        .update({
          custom_crm_providers: providerIds,
          use_google_docs: providerIds.includes("google_docs"),
        })
        .eq("id", agentId)
        .eq("user_id", user.id)
        .select("gmail_body_template,custom_crm_providers,use_google_docs")
        .maybeSingle();

      if (error) {
        return json(500, { error: "Failed to update CRM providers", details: error.message });
      }

      return json(200, { agent: data || null });
    }

    if (action === "updateTemplate") {
      const gmailBodyTemplate = String(body?.gmail_body_template || "");

      const { data, error } = await admin
        .from("agents")
        .update({
          gmail_body_template: gmailBodyTemplate,
        })
        .eq("id", agentId)
        .eq("user_id", user.id)
        .select("gmail_body_template,custom_crm_providers,use_google_docs")
        .maybeSingle();

      if (error) {
        return json(500, { error: "Failed to update gmail body template", details: error.message });
      }

      return json(200, { agent: data || null });
    }

    return json(400, { error: "Unsupported action" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { error: message });
  }
});
