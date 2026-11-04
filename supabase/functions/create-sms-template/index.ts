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

function isMissingTableError(message: string | undefined) {
  return !!message && (message.includes("schema cache") || message.includes("Could not find the table"));
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
    if (!user?.id || !user.email) {
      return json(401, { error: "Unauthorized" });
    }

    const body = await req.json().catch(() => ({}));
    const templateId = String(body?.templateId || "").trim();
    const name = String(body?.name || "").trim();
    const category = String(body?.category || "").trim();
    const message = String(body?.message || "").trim();
    const linkedTags = Array.isArray(body?.linkedTags)
      ? body.linkedTags.map((value: unknown) => String(value || "").trim()).filter(Boolean)
      : [];

    if (name.length < 3) {
      return json(400, { error: "Template name must be at least 3 characters" });
    }

    if (!category) {
      return json(400, { error: "Template category is required" });
    }

    if (message.length < 10) {
      return json(400, { error: "Template message must be at least 10 characters" });
    }

    const payload = {
      user_id: user.id,
      user_email: user.email,
      name,
      category,
      message,
      linked_tags: linkedTags,
    };

    const query = templateId
      ? admin.from("sms_templates").update(payload).eq("id", templateId).eq("user_id", user.id)
      : admin.from("sms_templates").insert(payload);

    const { data, error } = await query
      .select("id,user_id,user_email,name,category,message,linked_tags,created_at,updated_at")
      .single();

    if (error) {
      if (isMissingTableError(error.message)) {
        return json(500, { error: "sms_templates table is not available in this project yet." });
      }

      return json(500, { error: error.message });
    }

    return json(200, {
      success: true,
      template: data,
    });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
