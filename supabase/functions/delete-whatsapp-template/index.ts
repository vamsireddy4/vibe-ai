import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const projectId = (() => {
  try {
    return new URL(supabaseUrl).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
})();
const missingWhatsappTablesByProject: Record<string, string[]> = {
  xtemzfpsnafnrdfmzwmf: [
    "whatsapp_contacts",
    "whatsapp_campaigns",
    "whatsapp_templates",
    "whatsapp_messages",
    "whatsapp_conversations",
    "whatsapp_audiences",
    "whatsapp_audience_contacts",
  ],
};

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isMetaTemplateAlreadyMissing(responseData: any) {
  const errorCode = responseData?.error?.code;
  const errorSubcode = responseData?.error?.error_subcode;
  const errorTitle = String(responseData?.error?.error_user_title ?? "").toLowerCase();
  const errorMessage = String(responseData?.error?.error_user_msg ?? responseData?.error?.message ?? "").toLowerCase();

  return (
    errorCode === 100 &&
    (errorSubcode === 2593002 ||
      errorTitle.includes("template not found") ||
      errorMessage.includes("template") && errorMessage.includes("not found"))
  );
}

function getMetaDeleteTargets(metaBusinessAccountId: string, metaTemplateId: string, templateName: string, language: string) {
  const targets: Array<{ url: string; label: string }> = [];

  if (metaTemplateId) {
    targets.push({
      label: "hsm_id",
      url: `https://graph.facebook.com/v24.0/${metaBusinessAccountId}/message_templates?hsm_id=${encodeURIComponent(metaTemplateId)}`,
    });
  }

  targets.push(
    {
      label: "name+language",
      url:
        `https://graph.facebook.com/v24.0/${metaBusinessAccountId}/message_templates` +
        `?name=${encodeURIComponent(templateName)}` +
        `&language=${encodeURIComponent(language)}`,
    },
    {
      label: "name",
      url: `https://graph.facebook.com/v24.0/${metaBusinessAccountId}/message_templates?name=${encodeURIComponent(templateName)}`,
    },
  );

  return targets;
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
  const missingTables = new Set(missingWhatsappTablesByProject[projectId] ?? []);
  if (missingTables.has(tableName)) return false;
  const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { success: false, error: "Unauthorized" });

    const requestBody = await req.json().catch(() => ({}));
    const templateId = String(requestBody?.templateId ?? requestBody?.id ?? "").trim();
    const templateName = String(requestBody?.templateName ?? requestBody?.name ?? "").trim();
    const metaTemplateId = String(requestBody?.metaTemplateId ?? "").trim();
    const language = String(requestBody?.language ?? "en_US").trim() || "en_US";

    if (!templateId || !templateName) {
      return json(400, {
        success: false,
        error: "Missing required fields",
        message: "Please provide templateId and templateName.",
      });
    }

    const hasWhatsappApiConfigs = await canReadTable("whatsapp_api_configs");
    const hasWhatsappTemplates = await canReadTable("whatsapp_templates");
    const hasLegacyUserDetails = await canReadTable("User_details");
    const hasLegacyTemplates = await canReadTable("Templates");

    let metaAccessToken: string | null = null;
    let metaBusinessAccountId: string | null = null;

    if (hasWhatsappApiConfigs) {
      const { data: config } = await admin
        .from("whatsapp_api_configs")
        .select("meta_access_token, meta_business_account_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (config) {
        metaAccessToken = config.meta_access_token;
        metaBusinessAccountId = config.meta_business_account_id;
      }
    }

    if ((!metaAccessToken || !metaBusinessAccountId) && hasLegacyUserDetails && user.email) {
      const { data: legacyConfig } = await admin
        .from("User_details")
        .select("meta_access_token, meta_business_account_id")
        .eq("email", user.email)
        .maybeSingle();

      if (legacyConfig) {
        metaAccessToken = legacyConfig.meta_access_token;
        metaBusinessAccountId = legacyConfig.meta_business_account_id;
      }
    }

    if (metaAccessToken && metaBusinessAccountId) {
      const attemptedTargets = getMetaDeleteTargets(
        metaBusinessAccountId,
        metaTemplateId,
        templateName,
        language,
      );
      const errors: Array<Record<string, unknown>> = [];
      let deletedOnMeta = false;
      let alreadyMissingOnMeta = false;

      for (const target of attemptedTargets) {
        const metaResponse = await fetch(target.url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${metaAccessToken}`,
            "Content-Type": "application/json",
          },
        });

        const responseData = await metaResponse.json().catch(() => ({}));
        if (metaResponse.ok && responseData?.success === true) {
          deletedOnMeta = true;
          break;
        }

        if (isMetaTemplateAlreadyMissing(responseData)) {
          alreadyMissingOnMeta = true;
          continue;
        }

        errors.push({
          strategy: target.label,
          url: target.url,
          status: metaResponse.status,
          response: responseData,
        });
      }

      if (!deletedOnMeta && !alreadyMissingOnMeta) {
        const primaryError = errors.find((entry) => {
          const response = entry.response;
          if (!response || typeof response !== "object") return false;
          const message = (response as { error?: { message?: unknown; error_user_msg?: unknown } }).error;
          return Boolean(
            (typeof message?.error_user_msg === "string" && message.error_user_msg.trim()) ||
            (typeof message?.message === "string" && message.message.trim()),
          );
        });
        const primaryResponse = primaryError?.response as
          | { error?: { message?: unknown; error_user_msg?: unknown } }
          | undefined;

        return json(400, {
          success: false,
          error: "Meta API error",
          message:
            (typeof primaryResponse?.error?.error_user_msg === "string" && primaryResponse.error.error_user_msg.trim()) ||
            (typeof primaryResponse?.error?.message === "string" && primaryResponse.error.message.trim()) ||
            "Failed to delete template from Meta",
          details: errors,
          meta_template_id: metaTemplateId || null,
        });
      }
    }

    if (hasWhatsappTemplates) {
      const { error } = await admin
        .from("whatsapp_templates")
        .delete()
        .eq("id", templateId)
        .eq("user_id", user.id);

      if (error) {
        return json(500, {
          success: false,
          error: error.message,
        });
      }
    } else if (hasLegacyTemplates && user.email) {
      const { error } = await admin
        .from("Templates")
        .delete()
        .eq("id", templateId)
        .eq("user_email", user.email);

      if (error) {
        return json(500, {
          success: false,
          error: error.message,
        });
      }
    }

    return json(200, {
      success: true,
      message: "Template deleted successfully",
    });
  } catch (error) {
    console.error("[delete-whatsapp-template]", error);
    return json(500, {
      success: false,
      error: "Template deletion failed",
      message: error instanceof Error ? error.message : "An unexpected error occurred",
    });
  }
});
