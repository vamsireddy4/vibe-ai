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

type TemplateComponent = {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{
    type?: string;
    text?: string;
    url?: string;
    phone_number?: string;
  }>;
  cards?: unknown[];
};

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
  const missingTables = new Set(missingWhatsappTablesByProject[projectId] ?? []);
  if (missingTables.has(tableName)) return false;
  const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
  return !error;
}

function normalizeTemplateName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 512);
}

function isHiddenMetaSampleTemplate(name: string) {
  return normalizeTemplateName(name) === "hello_world";
}

function extractTemplateParameters(value: string) {
  return Array.from(value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g), (match) => match[1]?.trim())
    .filter((token): token is string => Boolean(token))
    .filter((token, index, values) => values.indexOf(token) === index);
}

function mapMetaButtonTypeForStorage(value: string) {
  switch (value) {
    case "url":
      return "visit_website";
    case "phone_number":
      return "call_phone";
    case "quick_reply":
      return "quick_message";
    default:
      return value;
  }
}

function mapMetaStatus(status: unknown) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "pending") return "pending_review";
  if (normalized === "approved") return "approved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "paused") return "paused";
  return "draft";
}

function parseTemplateDetails(components: TemplateComponent[]) {
  const normalizedComponents = components.map((component) => ({
    ...component,
    type: String(component.type ?? "").trim().toUpperCase(),
  }));

  const bodyComponent = normalizedComponents.find((component) => component.type === "BODY");
  const headerComponent = normalizedComponents.find((component) => component.type === "HEADER");
  const footerComponent = normalizedComponents.find((component) => component.type === "FOOTER");
  const buttonsComponent = normalizedComponents.find((component) => component.type === "BUTTONS");
  const carouselComponent = normalizedComponents.find((component) => component.type === "CAROUSEL");

  const bodyText = String(bodyComponent?.text ?? "").trim();
  const headerFormat = String(headerComponent?.format ?? "").trim().toLowerCase();
  const headerText = String(headerComponent?.text ?? "").trim();
  const footerText = String(footerComponent?.text ?? "").trim();
  const rawButtons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
  const buttonTypes = rawButtons.map((button) => mapMetaButtonTypeForStorage(String(button?.type ?? "").trim().toLowerCase()));
  const buttons = rawButtons.map((button) => {
    const originalType = String(button?.type ?? "").trim().toLowerCase();
    const mappedType = mapMetaButtonTypeForStorage(originalType);

    return {
      type: mappedType,
      text: String(button?.text ?? "").trim(),
      label: String(button?.text ?? "").trim(),
      url: typeof button?.url === "string" ? button.url : undefined,
      phone_number: typeof button?.phone_number === "string" ? button.phone_number : undefined,
      meta_type: originalType,
    };
  });

  return {
    bodyText,
    headerEnabled: Boolean(headerComponent),
    headerType: headerFormat || (headerText ? "text" : null),
    headerText,
    footerEnabled: Boolean(footerText),
    footerText,
    buttonsEnabled: buttons.length > 0,
    buttonTypes,
    buttons,
    parameterTokens: extractTemplateParameters(bodyText),
    carouselCards: Array.isArray(carouselComponent?.cards) ? carouselComponent.cards : [],
    templateType: carouselComponent ? "carousel" : "standard",
  };
}

function dedupeByConflictKey<T>(rows: T[], getKey: (row: T) => string) {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(getKey(row), row);
  }
  return Array.from(map.values());
}

function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return String(error);
}

async function fetchAllMetaTemplates(metaBusinessAccountId: string, metaAccessToken: string) {
  const templates: Array<Record<string, unknown>> = [];
  let nextUrl = `https://graph.facebook.com/v22.0/${metaBusinessAccountId}/message_templates?limit=100&fields=id,name,status,category,language,components`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${metaAccessToken}`,
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          payload?.error?.error_user_msg ||
          "Failed to fetch WhatsApp templates from Meta",
      );
    }

    const pageData = Array.isArray(payload?.data) ? payload.data : [];
    templates.push(...pageData);
    nextUrl = String(payload?.paging?.next || "").trim();
  }

  return templates;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { success: false, error: "Unauthorized" });

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

    if (!metaAccessToken || !metaBusinessAccountId) {
      return json(400, {
        success: false,
        error: "Missing credentials",
        message: "Add your WhatsApp API credentials first: open your account (your name at the bottom of the sidebar) > Integrations > WhatsApp API.",
      });
    }

    const templates = (await fetchAllMetaTemplates(metaBusinessAccountId, metaAccessToken)).filter(
      (template) => !isHiddenMetaSampleTemplate(String(template?.name || "")),
    );

    if (hasWhatsappTemplates) {
      const rows = dedupeByConflictKey(
        templates.map((template) => {
        const details = parseTemplateDetails(Array.isArray(template?.components) ? template.components as TemplateComponent[] : []);
        const normalizedName = normalizeTemplateName(String(template?.name || ""));
        return {
          user_id: user.id,
          template_type: details.templateType,
          name: String(template?.name || normalizedName),
          normalized_name: normalizedName,
          body: details.bodyText,
          category: String(template?.category || "utility").toLowerCase(),
          language: String(template?.language || "en_US"),
          header_enabled: details.headerEnabled,
          header_type: details.headerType,
          header_text: details.headerText,
          footer_enabled: details.footerEnabled,
          footer_text: details.footerText,
          buttons_enabled: details.buttonsEnabled,
          button_types: details.buttonTypes,
          buttons: details.buttons,
          parameter_tokens: details.parameterTokens,
          carousel_cards: details.carouselCards,
          meta_template_id: String(template?.id || "").trim() || null,
          meta_status: mapMetaStatus(template?.status),
        };
        }),
        (row) => `${row.user_id}::${row.normalized_name}::${row.language}`,
      );

      if (rows.length > 0) {
        const { error } = await admin
          .from("whatsapp_templates")
          .upsert(rows, { onConflict: "user_id,normalized_name,language" });
        if (error) throw error;
      }
    } else if (hasLegacyTemplates && user.email) {
      const rows = dedupeByConflictKey(
        templates.map((template) => {
        const details = parseTemplateDetails(Array.isArray(template?.components) ? template.components as TemplateComponent[] : []);
        const normalizedName = normalizeTemplateName(String(template?.name || ""));
        return {
          user_email: user.email,
          template_name: normalizedName,
          template_type: details.templateType === "carousel" ? "carousel" : "text",
          content: details.bodyText,
          category: String(template?.category || "UTILITY").toUpperCase(),
          language: String(template?.language || "en_US"),
          status: String(template?.status || "PENDING").toLowerCase(),
          meta_template_id: String(template?.id || "").trim() || null,
          body_text: details.bodyText,
          carousel_data: details.templateType === "carousel" ? details.carouselCards : null,
        };
        }),
        (row) => `${row.user_email}::${row.template_name}`,
      );

      if (rows.length > 0) {
        const { error } = await admin
          .from("Templates")
          .upsert(rows, { onConflict: "user_email,template_name" });
        if (error) throw error;
      }
    }

    return json(200, { success: true, count: templates.length });
  } catch (error) {
    console.error("[sync-whatsapp-templates]", error);
    return json(500, {
      success: false,
      error: formatErrorMessage(error),
    });
  }
});
