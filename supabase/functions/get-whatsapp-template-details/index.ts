import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseMetaTemplateStructure } from "../_shared/whatsapp-template.ts";

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

    const { data: userData } = await admin.auth.admin.getUserById(profile.user_id);
    return {
      id: profile.user_id,
      email: userData.user?.email ?? null,
    };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  return {
    id: data.user.id,
    email: data.user.email ?? null,
  };
}

async function canReadTable(tableName: string) {
  const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { success: false, error: "Unauthorized" });

    const { template_name, language } = await req.json().catch(() => ({}));
    const templateName = String(template_name ?? "").trim();
    const preferredLanguage = String(language ?? "").trim();

    if (!templateName) {
      return json(400, { success: false, error: "template_name is required" });
    }

    const hasWhatsappApiConfigs = await canReadTable("whatsapp_api_configs");
    const hasLegacyUserDetails = await canReadTable("User_details");

    let metaAccessToken: string | null = null;
    let metaBusinessAccountId: string | null = null;

    if (hasWhatsappApiConfigs) {
      const { data: config } = await admin
        .from("whatsapp_api_configs")
        .select("meta_business_account_id, meta_access_token")
        .eq("user_id", user.id)
        .maybeSingle();

      if (config) {
        metaBusinessAccountId = config.meta_business_account_id;
        metaAccessToken = config.meta_access_token;
      }
    }

    if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && user.email) {
      const { data: legacyConfig } = await admin
        .from("User_details")
        .select("meta_business_account_id, meta_access_token")
        .eq("email", user.email)
        .maybeSingle();

      if (legacyConfig) {
        metaBusinessAccountId = legacyConfig.meta_business_account_id;
        metaAccessToken = legacyConfig.meta_access_token;
      }
    }

    if (!metaAccessToken || !metaBusinessAccountId) {
      return json(404, { success: false, error: "User credentials not found" });
    }

    const url =
      `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates` +
      `?name=${encodeURIComponent(templateName)}` +
      `&fields=id,name,status,category,language,components`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${metaAccessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return json(response.status, {
        success: false,
        error: `WhatsApp API error: ${JSON.stringify(error)}`,
      });
    }

    const data = await response.json().catch(() => ({}));
    const templatesFound = Array.isArray(data?.data) ? data.data : [];
    const exactMatches = templatesFound.filter((template: Record<string, unknown>) => template.name === templateName);
    const template = preferredLanguage
      ? exactMatches.find((item: Record<string, unknown>) => item.language === preferredLanguage) ?? exactMatches[0]
      : exactMatches[0];

    if (!template) {
      return json(404, { success: false, error: "Template not found" });
    }

    const structure = parseMetaTemplateStructure(template);

    return json(200, {
      success: true,
      template: structure,
      raw: template,
    });
  } catch (error) {
    console.error("[get-whatsapp-template-details]", error);
    return json(500, {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
