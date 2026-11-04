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

async function loadRowsByUserOrEmail(table: string, userId: string, userEmail?: string | null) {
  const byUserId = await admin.from(table).select("*").eq("user_id", userId).order("created_at", { ascending: false });
  if (byUserId.error) throw byUserId.error;

  if (!userEmail) {
    return byUserId.data || [];
  }

  const byEmail = await admin.from(table).select("*").eq("user_email", userEmail).order("created_at", { ascending: false });
  if (byEmail.error) throw byEmail.error;

  const merged = new Map<string, Record<string, unknown>>();
  for (const row of [...(byUserId.data || []), ...(byEmail.data || [])] as Array<Record<string, unknown>>) {
    const id = String(row?.id || "").trim();
    if (id && !merged.has(id)) merged.set(id, row);
  }

  return Array.from(merged.values());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user?.id) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "load").trim();

    if (action !== "load") {
      return json(400, { error: "Invalid action" });
    }

    const [campaigns, completed, templates] = await Promise.all([
      loadRowsByUserOrEmail("sms_campaigns", user.id, user.email),
      loadRowsByUserOrEmail("sms_completed_campaigns", user.id, user.email),
      loadRowsByUserOrEmail("sms_templates", user.id, user.email),
    ]);

    return json(200, {
      success: true,
      campaigns,
      completed,
      templates,
    });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
