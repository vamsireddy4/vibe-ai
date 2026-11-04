import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildTemplateParameters,
  parseMetaTemplateStructure,
  type ParsedTemplateStructure,
} from "../_shared/whatsapp-template.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

type CampaignContext = {
  userId: string;
  campaignId: string;
  campaignTable: string;
  contacts: Array<Record<string, unknown>>;
  config: {
    meta_access_token: string | null;
    meta_phone_number_id: string | null;
    meta_business_account_id: string | null;
  };
  templateName: string;
  templateBody: string;
  languageCode: string;
  templateStructure: ParsedTemplateStructure | Record<string, unknown> | null;
  hasWhatsappMessages: boolean;
  hasWhatsappConversations: boolean;
  hasWhatsappContacts: boolean;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhoneNumber(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notifyExternalWebhook(userId: string, payload: Record<string, unknown>) {
  const { data: config, error } = await admin
    .from("whatsapp_auto_reply_configs")
    .select("is_enabled, webhook_url")
    .eq("user_id", userId)
    .maybeSingle();

  const webhookUrl = String(config?.webhook_url || "").trim();
  if (error || !config?.is_enabled || !webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_error) {
    // Ignore external delivery failures.
  }
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
    return { id: profile.user_id };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
}

async function canReadTable(tableName: string) {
  const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
  return !error;
}

function resolveTemplateTokenValue(token: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "Customer").trim() || "Customer";
  const phoneNumber = String(contact.phone_number ?? "").trim() || "your number";
  const email = String(contact.email ?? "").trim() || "your email";

  const normalized = token.trim().toLowerCase();
  if (normalized === "first_name" || normalized === "name") return firstName;
  if (normalized === "phone_number") return phoneNumber;
  if (normalized === "email") return email;
  return firstName;
}

function getBodyParameterToken(param: unknown) {
  if (typeof param === "string") return param;
  if (param && typeof param === "object") {
    const candidate = param as { name?: unknown; placeholder?: unknown };
    if (typeof candidate.name === "string" && candidate.name.trim()) return candidate.name.trim();
    if (typeof candidate.placeholder === "string" && candidate.placeholder.trim()) {
      return candidate.placeholder.replace(/\{\{|\}\}|\s/g, "");
    }
  }
  return String(param ?? "").trim();
}

function renderTemplate(body: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "Customer").trim() || "Customer";
  const phoneNumber = String(contact.phone_number ?? "").trim();
  const email = String(contact.email ?? "").trim();

  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, firstName)
    .replace(/\{\s*name\s*\}/gi, firstName)
    .replace(/\{\{\s*phone_number\s*\}\}/gi, phoneNumber || "your number")
    .replace(/\{\{\s*email\s*\}\}/gi, email || "your email");
}

async function uploadMediaToMeta(config: CampaignContext["config"], sourceUrl: string, mimeTypeHint?: string | null) {
  const accessToken = String(config.meta_access_token || "").trim();
  const phoneNumberId = String(config.meta_phone_number_id || "").trim();

  if (!accessToken || !phoneNumberId) {
    throw new Error("Meta access token or phone number ID is missing");
  }

  const assetResponse = await fetch(sourceUrl);
  if (!assetResponse.ok) {
    throw new Error(`Failed to download media asset: ${assetResponse.status}`);
  }

  const assetBlob = await assetResponse.blob();
  const mimeType = mimeTypeHint || assetBlob.type || "application/octet-stream";
  const pathname = (() => {
    try {
      return new URL(sourceUrl).pathname.split("/").pop() || "asset";
    } catch {
      return "asset";
    }
  })();

  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  formData.set("type", mimeType);
  formData.set("file", new File([assetBlob], pathname, { type: mimeType }));

  const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/media`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id) {
    throw new Error(
      payload?.error?.message ||
        payload?.error?.error_user_msg ||
        "Failed to upload media to Meta",
    );
  }

  return String(payload.id);
}

async function resolveMediaId(
  config: CampaignContext["config"],
  cache: Map<string, string>,
  mediaIdOrHandle: string | null | undefined,
  mediaUrl: string | null | undefined,
  format: string | null | undefined,
) {
  const normalizedId = String(mediaIdOrHandle ?? "").trim();
  if (normalizedId && /^\d+$/.test(normalizedId)) return normalizedId;

  const normalizedUrl = String(mediaUrl ?? "").trim();
  if (!normalizedUrl) return normalizedId || null;

  const cacheKey = `${format || "asset"}::${normalizedUrl}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const mimeTypeHint = (() => {
    const normalizedFormat = String(format ?? "").trim().toLowerCase();
    if (normalizedFormat === "image") return "image/jpeg";
    if (normalizedFormat === "video") return "video/mp4";
    if (normalizedFormat === "document") return "application/pdf";
    return null;
  })();

  const uploadedId = await uploadMediaToMeta(config, normalizedUrl, mimeTypeHint);
  cache.set(cacheKey, uploadedId);
  return uploadedId;
}

function buildBodyComponent(bodyParameters: unknown[], contact: Record<string, unknown>) {
  if (!Array.isArray(bodyParameters) || bodyParameters.length === 0) return null;

  return {
    type: "body",
    parameters: bodyParameters.map((param) => {
      const token = getBodyParameterToken(param);
      const parameter: Record<string, unknown> = {
        type: "text",
        text: resolveTemplateTokenValue(token, contact),
      };

      if (token && !/^\d+$/.test(token)) {
        parameter.parameter_name = token;
      }

      return parameter;
    }),
  };
}

async function buildMessagePayload(
  context: CampaignContext,
  contact: Record<string, unknown>,
  mediaCache: Map<string, string>,
) {
  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhoneNumber(String(contact.phone_number ?? "")),
    type: "template",
    template: {
      name: context.templateName,
      language: {
        code: context.languageCode || "en_US",
      },
    },
  };

  const structure = context.templateStructure;
  if (!structure || typeof structure !== "object") return payload;

  const components: Array<Record<string, unknown>> = [];
  const bodyComponent = buildBodyComponent(
    Array.isArray((structure as { bodyParameters?: unknown[] }).bodyParameters)
      ? (structure as { bodyParameters: unknown[] }).bodyParameters
      : [],
    contact,
  );
  if (bodyComponent) components.push(bodyComponent);

  const hasHeader = Boolean((structure as { hasHeader?: unknown }).hasHeader);
  const headerType = String((structure as { headerType?: unknown }).headerType ?? "").trim().toLowerCase();
  if (hasHeader && ["image", "video", "document"].includes(headerType)) {
    const mediaId = await resolveMediaId(
      context.config,
      mediaCache,
      String((structure as { headerHandleId?: unknown }).headerHandleId ?? "").trim() || null,
      String((structure as { headerImageUrl?: unknown }).headerImageUrl ?? "").trim() || null,
      headerType,
    );

    if (mediaId) {
      components.push({
        type: "header",
        parameters: [
          {
            type: headerType,
            [headerType]: { id: mediaId },
          },
        ],
      });
    }
  }

  const carouselCards = Array.isArray((structure as { carouselCards?: unknown[] }).carouselCards)
    ? (structure as { carouselCards: Array<Record<string, unknown>> }).carouselCards
    : [];

  if (Boolean((structure as { hasCarousel?: unknown }).hasCarousel) && carouselCards.length > 0) {
    const cardsPayload: Array<Record<string, unknown>> = [];

    for (const card of carouselCards) {
      const cardComponents: Array<Record<string, unknown>> = [];
      const headerFormat = String(card.headerFormat ?? "").trim().toLowerCase();
      if (card.hasHeader && ["image", "video", "document"].includes(headerFormat)) {
        const mediaId = await resolveMediaId(
          context.config,
          mediaCache,
          String(card.headerMediaId ?? "").trim() || null,
          String(card.headerImageUrl ?? "").trim() || null,
          headerFormat,
        );
        if (mediaId) {
          cardComponents.push({
            type: "header",
            parameters: [
              {
                type: headerFormat,
                [headerFormat]: { id: mediaId },
              },
            ],
          });
        }
      }

      const cardBodyComponent = buildBodyComponent(
        Array.isArray(card.bodyParameters)
          ? card.bodyParameters
          : buildTemplateParameters(String(card.bodyText ?? "")),
        contact,
      );
      if (cardBodyComponent) cardComponents.push(cardBodyComponent);

      cardsPayload.push({
        card_index: Number(card.index ?? 0),
        components: cardComponents,
      });
    }

    if (cardsPayload.length > 0) {
      components.push({
        type: "carousel",
        cards: cardsPayload,
      });
    }
  }

  if (components.length > 0) {
    (payload.template as { components?: unknown[] }).components = components;
  }

  return payload;
}

async function sendMetaTemplateMessage(
  config: CampaignContext["config"],
  payload: Record<string, unknown>,
) {
  const accessToken = String(config.meta_access_token || "").trim();
  const phoneNumberId = String(config.meta_phone_number_id || "").trim();

  if (!accessToken || !phoneNumberId) {
    throw new Error("Meta access token or phone number ID is missing");
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      responsePayload?.error?.message ||
        responsePayload?.error?.error_user_msg ||
        "WhatsApp template send failed",
    );
  }

  return {
    providerMessageId: responsePayload?.messages?.[0]?.id ?? null,
    rawPayload: responsePayload,
  };
}

async function sendMetaTextMessage(
  config: CampaignContext["config"],
  to: string,
  body: string,
) {
  const accessToken = String(config.meta_access_token || "").trim();
  const phoneNumberId = String(config.meta_phone_number_id || "").trim();

  if (!accessToken || !phoneNumberId) {
    throw new Error("Meta access token or phone number ID is missing");
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.error?.error_user_msg ||
        "WhatsApp text send failed",
    );
  }

  return {
    providerMessageId: payload?.messages?.[0]?.id ?? null,
    rawPayload: payload,
  };
}

async function fetchCanonicalTemplateFromMeta(
  config: CampaignContext["config"],
  templateName: string,
  languageCode: string,
) {
  const accessToken = String(config.meta_access_token || "").trim();
  const businessAccountId = String(config.meta_business_account_id || "").trim();
  if (!accessToken || !businessAccountId || !templateName) return null;

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${businessAccountId}/message_templates` +
      `?name=${encodeURIComponent(templateName)}` +
      `&fields=id,name,status,category,language,components`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.error?.error_user_msg ||
        "Failed to fetch template structure from Meta",
    );
  }

  const templates = Array.isArray(payload?.data) ? payload.data : [];
  const exactMatches = templates.filter((template: Record<string, unknown>) => template.name === templateName);
  const matchedTemplate =
    exactMatches.find((template: Record<string, unknown>) => template.language === languageCode) ??
    exactMatches[0] ??
    null;

  return matchedTemplate ? parseMetaTemplateStructure(matchedTemplate) : null;
}

async function resolveCampaignContext(userId: string, campaignId: string): Promise<CampaignContext> {
  const hasWhatsappCampaigns = await canReadTable("whatsapp_campaigns");
  const hasWhatsappAudiences = await canReadTable("whatsapp_audiences");
  const hasWhatsappAudienceContacts = await canReadTable("whatsapp_audience_contacts");
  const hasWhatsappContacts = await canReadTable("whatsapp_contacts");
  const hasWhatsappTemplates = await canReadTable("whatsapp_templates");
  const hasWhatsappMessages = await canReadTable("whatsapp_messages");
  const hasWhatsappConversations = await canReadTable("whatsapp_conversations");
  const hasWhatsappApiConfigs = await canReadTable("whatsapp_api_configs");
  const hasLegacyUserDetails = await canReadTable("User_details");

  let campaignTable = "audience_campaigns";

  // Typed as any: campaign rows come from several tables with differing shapes
  // (whatsapp_campaigns, audience_campaigns), and assignment happens inside a
  // closure which defeats TS flow-narrowing. any keeps the dynamic access valid.
  let campaign: any = null;
  let campaignOwnerId = userId;
  const tryResolveCampaign = async (tableName: string) => {
    const ownedResult = await admin
      .from(tableName)
      .select("*")
      .eq("id", campaignId)
      .eq("user_id", userId)
      .maybeSingle();

    if (ownedResult.data) {
      campaignTable = tableName;
      campaign = ownedResult.data;
      campaignOwnerId = String(ownedResult.data.user_id ?? userId).trim() || userId;
      return true;
    }

    return false;
  };

  if (hasWhatsappCampaigns) {
    await tryResolveCampaign("whatsapp_campaigns");
  }

  if (!campaign) {
    await tryResolveCampaign("audience_campaigns");
  }

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const isWhatsappCampaign = campaignTable === "whatsapp_campaigns";
  const audienceTable = isWhatsappCampaign && hasWhatsappAudiences ? "whatsapp_audiences" : "audience_segments";
  const audienceContactsTable =
    isWhatsappCampaign && hasWhatsappAudienceContacts ? "whatsapp_audience_contacts" : "audience_segment_contacts";
  const contactsTable = isWhatsappCampaign && hasWhatsappContacts ? "whatsapp_contacts" : "contacts";
  const templateTable = isWhatsappCampaign && hasWhatsappTemplates ? "whatsapp_templates" : "Templates";

  let template: Record<string, unknown> | null = null;
  if (campaign.template_id) {
    const templateQuery = admin
      .from(templateTable)
      .select("*")
      .eq("id", campaign.template_id);
    // Legacy "Templates" has only user_email; whatsapp_templates is scoped by user_id.
    const { data: loadedTemplate, error: templateError } = await (templateTable === "whatsapp_templates"
      ? templateQuery.eq("user_id", userId)
      : templateQuery
    ).maybeSingle();

    if (templateError) throw new Error("Template lookup failed");
    template = loadedTemplate;
  }

  const { data: audience, error: audienceError } = await admin
    .from(audienceTable)
    .select("id")
    .eq("id", campaign.audience_id)
    .eq("user_id", userId)
    .single();

  if (audienceError || !audience) throw new Error("Audience not found");

  const { data: audienceLinks, error: audienceLinksError } = await admin
    .from(audienceContactsTable)
    .select("contact_id")
    .eq("user_id", userId)
    .eq("audience_id", audience.id);

  if (audienceLinksError) throw new Error(audienceLinksError.message);

  const contactIds = (audienceLinks ?? []).map((row: { contact_id: string }) => row.contact_id);
  if (!contactIds.length) throw new Error("No contacts found in audience");

  const { data: contacts, error: contactsError } = await admin
    .from(contactsTable)
    .select("*")
    .eq("user_id", userId)
    .in("id", contactIds);

  if (contactsError) throw new Error(contactsError.message);

  let config: CampaignContext["config"] | null = null;
  if (hasWhatsappApiConfigs) {
      const { data: liveConfig } = await admin
        .from("whatsapp_api_configs")
        .select("meta_access_token, meta_phone_number_id, meta_business_account_id")
        .eq("user_id", campaignOwnerId)
        .maybeSingle();
    if (liveConfig) config = liveConfig;
  }

  if ((!config?.meta_access_token || !config?.meta_phone_number_id || !config?.meta_business_account_id) && hasLegacyUserDetails) {
    const { data: userData } = await admin.auth.admin.getUserById(campaignOwnerId);
    const userEmail = userData.user?.email ?? null;
    if (userEmail) {
      const { data: legacyConfig } = await admin
        .from("User_details")
        .select("meta_access_token, meta_phone_number_id, meta_business_account_id")
        .eq("email", userEmail)
        .maybeSingle();
      if (legacyConfig) {
        config = {
          meta_access_token: legacyConfig.meta_access_token ?? config?.meta_access_token ?? null,
          meta_phone_number_id: legacyConfig.meta_phone_number_id ?? config?.meta_phone_number_id ?? null,
          meta_business_account_id: legacyConfig.meta_business_account_id ?? config?.meta_business_account_id ?? null,
        };
      }
    }
  }

  if (!config?.meta_access_token || !config?.meta_phone_number_id) {
    throw new Error("WhatsApp API configuration not found");
  }

  const usesWhatsappTemplateTable = templateTable === "whatsapp_templates";
  const templateBody = String(
    campaign.template_structure?.previewBody ??
      (usesWhatsappTemplateTable
        ? template?.body ?? ""
        : template?.body_text ?? template?.content ?? ""),
  ).trim();
  const templateName = String(
    campaign.template_name ??
      (usesWhatsappTemplateTable
        ? template?.normalized_name ?? template?.name ?? ""
        : template?.template_name ?? ""),
  ).trim();
  const languageCode = String(campaign.template_language ?? template?.language ?? "en_US").trim() || "en_US";
  const savedTemplateStructure =
    campaign.template_structure && typeof campaign.template_structure === "object"
      ? campaign.template_structure
      : null;
  const canonicalTemplateStructure = templateName
    ? await fetchCanonicalTemplateFromMeta(config, templateName, languageCode)
    : null;

  return {
    userId: campaignOwnerId,
    campaignId,
    campaignTable,
    contacts: contacts ?? [],
    config,
    templateName,
    templateBody,
    languageCode,
    templateStructure: canonicalTemplateStructure ?? savedTemplateStructure,
    hasWhatsappMessages,
    hasWhatsappConversations,
    hasWhatsappContacts,
  };
}

async function updateCampaignState(
  context: CampaignContext,
  values: Record<string, unknown>,
) {
  const { error } = await admin
    .from(context.campaignTable)
    .update(values)
    .eq("id", context.campaignId)
    .eq("user_id", context.userId);

  if (error) throw error;
}

async function processCampaign(context: CampaignContext) {
  const startedAt = new Date().toISOString();
  await updateCampaignState(context, {
    status: "active",
    started_at: startedAt,
    completed_at: null,
    total_contacts: context.contacts.length,
    sent_count: 0,
    failed_count: 0,
    outcomes: [],
  });

  let sentCount = 0;
  let failedCount = 0;
  const outcomes: Array<Record<string, unknown>> = [];
  const mediaCache = new Map<string, string>();

  for (const contact of context.contacts) {
    const phoneNumber = normalizePhoneNumber(String(contact.phone_number ?? ""));
    const renderedBody = renderTemplate(context.templateBody, contact);

    if (!phoneNumber) {
      failedCount += 1;
      outcomes.push({
        contact_id: contact.id,
        phone_number: null,
        status: "failed",
        error: "Missing phone number",
      });
      continue;
    }

    try {
      const sendResult =
        context.templateName
          ? await sendMetaTemplateMessage(
              context.config,
              await buildMessagePayload(context, contact, mediaCache),
            )
          : await sendMetaTextMessage(context.config, phoneNumber, renderedBody);

      sentCount += 1;
      outcomes.push({
        contact_id: contact.id,
        phone_number: phoneNumber,
        status: "sent",
        provider_message_id: sendResult.providerMessageId,
      });

      if (context.hasWhatsappMessages && context.hasWhatsappConversations && context.hasWhatsappContacts) {
        let { data: conversation } = await admin
          .from("whatsapp_conversations")
          .select("id")
          .eq("user_id", context.userId)
          .eq("phone_number", String(contact.phone_number ?? ""))
          .maybeSingle();

        if (!conversation) {
          const insertedConversation = await admin
            .from("whatsapp_conversations")
            .insert({
              user_id: context.userId,
              phone_number: String(contact.phone_number ?? ""),
              contact_name: String(contact.name ?? contact.first_name ?? contact.phone_number ?? ""),
              last_message_text: renderedBody,
              last_message_at: new Date().toISOString(),
            })
            .select("id")
            .single();

          conversation = insertedConversation.data ?? null;
        }

        if (conversation?.id) {
          const sentAt = new Date().toISOString();

          await admin.from("whatsapp_messages").insert({
            conversation_id: conversation.id,
            user_id: context.userId,
            direction: "outbound",
            body: renderedBody,
            provider_message_id: sendResult.providerMessageId,
            status: "sent",
            raw_payload: sendResult.rawPayload,
            sent_at: sentAt,
          });

          await notifyExternalWebhook(context.userId, {
            event_type: "outbound_message",
            direction: "outbound",
            trigger: "campaign_send",
            source: "whatsapp",
            user_id: context.userId,
            conversation_id: conversation.id,
            phone_number: phoneNumber,
            campaign_id: context.campaignId,
            message: {
              body: renderedBody,
              provider_message_id: sendResult.providerMessageId,
              status: "sent",
              sent_at: sentAt,
            },
            raw_payload: sendResult.rawPayload,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedCount += 1;
      outcomes.push({
        contact_id: contact.id,
        phone_number: phoneNumber,
        status: "failed",
        error: message,
      });
    }

    await sleep(100);
  }

  const completedAt = new Date().toISOString();
  const finalStatus = sentCount > 0 ? "completed" : "failed";
  const finalUpdate: Record<string, unknown> = {
    status: finalStatus,
    completed_at: completedAt,
    total_contacts: context.contacts.length,
    sent_count: sentCount,
    failed_count: failedCount,
    outcomes,
  };

  if (context.campaignTable === "whatsapp_campaigns") {
    // Delivery must come from webhook receipts, not initial Graph API acceptance.
    finalUpdate.delivered = 0;
    finalUpdate.failed = failedCount;
    finalUpdate.sent_date = completedAt;
  }

  await updateCampaignState(context, finalUpdate);
}

function queueBackgroundWork(promise: Promise<unknown>) {
  const runtime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;

  if (runtime?.waitUntil) {
    runtime.waitUntil(promise);
    return;
  }

  // Fallback for environments without waitUntil support.
  void promise;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { success: false, error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { success: false, error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const campaignId = String(body?.campaign_id || "").trim();
    if (!campaignId) {
      return json(400, { success: false, error: "campaign_id is required" });
    }

    const context = await resolveCampaignContext(user.id, campaignId);
    queueBackgroundWork(
      processCampaign(context).catch(async (error) => {
        const completedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        console.error("[send-campaign-messages]", error);

        try {
          await updateCampaignState(context, {
            status: "failed",
            completed_at: completedAt,
            failed_count: context.contacts.length,
          });
        } catch (updateError) {
          console.error("[send-campaign-messages:update-failed]", updateError);
        }
      }),
    );

    return json(202, {
      success: true,
      campaign_id: campaignId,
      status: "processing",
      total_contacts: context.contacts.length,
    });
  } catch (error) {
    console.error("[send-campaign-messages]", error);
    return json(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
