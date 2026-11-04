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

function normalizePhoneNumber(value: string) {
  const digits = value.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
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

async function sendMetaTextMessage(config: {
  meta_access_token: string | null;
  meta_phone_number_id: string | null;
}, to: string, body: string) {
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
    const errorMessage =
      payload?.error?.message ||
      payload?.error?.error_user_msg ||
      "WhatsApp Cloud API request failed";
    throw new Error(errorMessage);
  }

  return {
    providerMessageId: payload?.messages?.[0]?.id ?? null,
    rawPayload: payload,
  };
}

function resolveTemplateTokenValue(token: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "there").trim() || "there";
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

function buildMessagePayload(
  phone: string,
  templateName: string,
  templateLang: string,
  templateStructure: Record<string, unknown> | null | undefined,
  contact: Record<string, unknown>,
) {
  const payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: {
        code: templateLang || "en_US",
      },
    },
  };

  if (!templateStructure) {
    return payload;
  }

  const components: any[] = [];
  const hasHeader = Boolean(templateStructure.hasHeader);
  const headerHandleId = String(templateStructure.headerHandleId ?? "").trim();
  const headerType = String(templateStructure.headerType ?? "").trim();

  if (hasHeader && headerHandleId && headerType) {
    components.push({
      type: "header",
      parameters: [
        {
          type: headerType,
          [headerType]: { id: headerHandleId },
        },
      ],
    });
  }

  const bodyParameters = Array.isArray(templateStructure.bodyParameters)
    ? templateStructure.bodyParameters
    : [];

  if (bodyParameters.length > 0) {
    components.push({
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
    });
  }

  if (components.length > 0) {
    payload.template.components = components;
  }

  return payload;
}

async function sendMetaTemplateMessage(
  config: {
    meta_access_token: string | null;
    meta_phone_number_id: string | null;
  },
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

  const responseBody = await response.json().catch(() => ({})) as {
    error?: { message?: string; error_user_msg?: string };
    messages?: Array<{ id?: string }>;
  };
  if (!response.ok) {
    const errorMessage =
      responseBody?.error?.message ||
      responseBody?.error?.error_user_msg ||
      "WhatsApp template send failed";
    throw new Error(errorMessage);
  }

  return {
    providerMessageId: responseBody?.messages?.[0]?.id ?? null,
    rawPayload: responseBody,
  };
}

function renderTemplate(body: string, contact: Record<string, unknown>) {
  const firstName =
    String(contact.first_name ?? contact.name ?? contact.phone_number ?? "there").trim() || "there";
  const phoneNumber = String(contact.phone_number ?? "").trim();
  const email = String(contact.email ?? "").trim();

  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, firstName)
    .replace(/\{\s*name\s*\}/gi, firstName)
    .replace(/\{\{\s*phone_number\s*\}\}/gi, phoneNumber || "your number")
    .replace(/\{\{\s*email\s*\}\}/gi, email || "your email");
}

function extractBodyParameterMatches(bodyText: string): string[] {
  let matches: string[] = bodyText.match(/\{\{\s*\d+\s*\}\}/g) || [];
  if (matches.length === 0) {
    const broadMatches = bodyText.match(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g) || [];
    matches = broadMatches.filter((match) => match.length < 40);
  }
  return matches;
}

function buildCanonicalTemplateStructure(template: Record<string, unknown>) {
  const components = Array.isArray(template.components) ? template.components as Array<Record<string, unknown>> : [];
  const structure: Record<string, unknown> = {
    name: String(template.name ?? ""),
    language: String(template.language ?? "en_US"),
    hasHeader: false,
    headerType: null,
    headerHandleId: null,
    bodyParameters: [],
    hasCarousel: false,
    carouselCards: [],
    components,
  };

  const headerComponent = components.find((component) => String(component.type ?? "").trim().toUpperCase() === "HEADER");
  const headerFormat = String(headerComponent?.format ?? "").trim().toLowerCase();
  if (headerComponent && ["image", "video", "document"].includes(headerFormat)) {
    structure.hasHeader = true;
    structure.headerType = headerFormat;
    structure.headerHandleId =
      Array.isArray((headerComponent as any)?.example?.header_handle)
        ? (headerComponent as any).example.header_handle[0] ?? null
        : null;
  }

  const bodyComponent = components.find((component) => String(component.type ?? "").trim().toUpperCase() === "BODY");
  const bodyText = String(bodyComponent?.text ?? "").trim();
  if (bodyText) {
    structure.previewBody = bodyText;
    structure.bodyParameters = extractBodyParameterMatches(bodyText).map((match, idx) => {
      const content = match.replace(/\{\{|\}\}|\s/g, "");
      const isNumeric = /^\d+$/.test(content);
      return {
        index: isNumeric ? Number.parseInt(content, 10) : idx + 1,
        placeholder: match,
        name: content,
      };
    });
  }

  return structure;
}

async function fetchCanonicalTemplateFromMeta(config: {
  meta_access_token: string | null;
  meta_business_account_id: string | null;
}, templateName: string, languageCode: string) {
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

  return matchedTemplate ? buildCanonicalTemplateStructure(matchedTemplate) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const campaignId = String(body?.campaign_id || "").trim();
    if (!campaignId) return json(400, { error: "campaign_id is required" });

    const hasWhatsappCampaigns = await canReadTable("whatsapp_campaigns");
    const hasWhatsappAudiences = await canReadTable("whatsapp_audiences");
    const hasWhatsappAudienceContacts = await canReadTable("whatsapp_audience_contacts");
    const hasWhatsappContacts = await canReadTable("whatsapp_contacts");
    const hasWhatsappTemplates = await canReadTable("whatsapp_templates");
    const hasWhatsappMessages = await canReadTable("whatsapp_messages");
    const hasWhatsappConversations = await canReadTable("whatsapp_conversations");

    const campaignTable = hasWhatsappCampaigns ? "whatsapp_campaigns" : "audience_campaigns";
    const audienceTable = hasWhatsappAudiences ? "whatsapp_audiences" : "audience_segments";
    const audienceContactsTable = hasWhatsappAudienceContacts ? "whatsapp_audience_contacts" : "audience_segment_contacts";
    const contactsTable = hasWhatsappContacts ? "whatsapp_contacts" : "contacts";
    const templateTable = hasWhatsappTemplates ? "whatsapp_templates" : "Templates";

    const { data: campaign, error: campaignError } = await admin
      .from(campaignTable)
      .select("*")
      .eq("id", campaignId)
      .eq("user_id", user.id)
      .single();

    if (campaignError || !campaign) {
      return json(404, { error: "Campaign not found" });
    }

    let template: Record<string, unknown> | null = null;
    if (campaign.template_id) {
      const templateQuery = admin
        .from(templateTable)
        .select("*")
        .eq("id", campaign.template_id);
      // Legacy "Templates" has only user_email; whatsapp_templates is scoped by user_id.
      const { data: loadedTemplate, error: templateError } = await (hasWhatsappTemplates
        ? templateQuery.eq("user_id", user.id)
        : templateQuery
      ).maybeSingle();

      if (templateError) {
        return json(400, { error: "Template lookup failed" });
      }

      template = loadedTemplate;
    }

    const { data: audience, error: audienceError } = await admin
      .from(audienceTable)
      .select("id, name")
      .eq("id", campaign.audience_id)
      .eq("user_id", user.id)
      .single();

    if (audienceError || !audience) {
      return json(400, { error: "Audience not found" });
    }

    const { data: audienceLinks, error: audienceLinksError } = await admin
      .from(audienceContactsTable)
      .select("contact_id")
      .eq("user_id", user.id)
      .eq("audience_id", audience.id);

    if (audienceLinksError) {
      return json(500, { error: audienceLinksError.message });
    }

    const contactIds = (audienceLinks ?? []).map((row: { contact_id: string }) => row.contact_id);
    if (!contactIds.length) {
      return json(400, { error: "No contacts found in audience" });
    }

    const contactsQuery = admin.from(contactsTable).select("*").eq("user_id", user.id);
    const { data: contacts, error: contactsError } = hasWhatsappContacts
      ? await contactsQuery.in("id", contactIds)
      : await contactsQuery.in("id", contactIds);

    if (contactsError) {
      return json(500, { error: contactsError.message });
    }

    const hasWhatsappApiConfigs = await canReadTable("whatsapp_api_configs");
    const hasLegacyUserDetails = await canReadTable("User_details");

    let config: {
      meta_access_token: string | null;
      meta_phone_number_id: string | null;
      meta_business_account_id: string | null;
    } | null = null;

    if (hasWhatsappApiConfigs) {
      const { data: liveConfig } = await admin
        .from("whatsapp_api_configs")
        .select("meta_access_token, meta_phone_number_id, meta_business_account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (liveConfig) {
        config = liveConfig;
      }
    }

    if ((!config?.meta_access_token || !config?.meta_phone_number_id || !config?.meta_business_account_id) && hasLegacyUserDetails) {
      const { data: userData } = await admin.auth.admin.getUserById(user.id);
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
      return json(400, { error: "WhatsApp API configuration not found" });
    }

    const templateBody = String(
      campaign.template_structure?.previewBody ??
        (hasWhatsappTemplates
          ? template?.body ?? ""
          : template?.body_text ?? template?.content ?? ""),
    ).trim();
    const templateName = String(
      campaign.template_name ??
        (hasWhatsappTemplates
          ? template?.normalized_name ?? template?.name ?? ""
          : template?.template_name ?? ""),
    ).trim();
    const languageCode = String(
      campaign.template_language ?? template?.language ?? "en_US",
    ).trim() || "en_US";
    const savedTemplateStructure =
      campaign.template_structure && typeof campaign.template_structure === "object"
        ? campaign.template_structure
        : null;
    const canonicalTemplateStructure = templateName
      ? await fetchCanonicalTemplateFromMeta(config, templateName, languageCode)
      : null;
    const templateStructure = canonicalTemplateStructure ?? savedTemplateStructure;
    const startedAt = new Date().toISOString();

    const startUpdate = hasWhatsappCampaigns
      ? {
          status: "active",
          started_at: startedAt,
          completed_at: null,
          total_contacts: contacts.length,
          sent_count: 0,
          failed_count: 0,
          outcomes: [],
        }
      : {
          status: "active",
          started_at: startedAt,
          completed_at: null,
          total_contacts: contacts.length,
          sent_count: 0,
          failed_count: 0,
          outcomes: [],
        };

    await admin
      .from(campaignTable)
      .update(startUpdate)
      .eq("id", campaign.id)
      .eq("user_id", user.id);

    let sentCount = 0;
    let failedCount = 0;
    const outcomes: Array<Record<string, unknown>> = [];

    for (const contact of contacts ?? []) {
      const phoneNumber = normalizePhoneNumber(String(contact.phone_number ?? ""));
      const renderedBody = renderTemplate(templateBody, contact);

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
          templateName
            ? await sendMetaTemplateMessage(
                config,
                buildMessagePayload(phoneNumber, templateName, languageCode, templateStructure, contact),
              )
            : await sendMetaTextMessage(config, phoneNumber, renderedBody);
        sentCount += 1;

        outcomes.push({
          contact_id: contact.id,
          phone_number: phoneNumber,
          status: "sent",
          provider_message_id: sendResult.providerMessageId,
        });

        if (hasWhatsappMessages && hasWhatsappConversations && hasWhatsappContacts) {
          let { data: conversation } = await admin
            .from("whatsapp_conversations")
            .select("id")
            .eq("user_id", user.id)
            .eq("phone_number", String(contact.phone_number ?? ""))
            .maybeSingle();

          if (!conversation) {
            const insertedConversation = await admin
              .from("whatsapp_conversations")
              .insert({
                user_id: user.id,
                phone_number: String(contact.phone_number ?? ""),
                contact_name: String(contact.name ?? contact.first_name ?? contact.phone_number ?? ""),
                last_message_text: renderedBody,
                last_message_at: startedAt,
              })
              .select("id")
              .single();

            conversation = insertedConversation.data ?? null;
          }

          if (conversation?.id) {
            await admin.from("whatsapp_messages").insert({
              conversation_id: conversation.id,
              user_id: user.id,
              direction: "outbound",
              body: renderedBody,
              provider_message_id: sendResult.providerMessageId,
              status: "sent",
              raw_payload: sendResult.rawPayload,
              sent_at: startedAt,
            });

            await notifyExternalWebhook(user.id, {
              event_type: "outbound_message",
              direction: "outbound",
              trigger: "campaign_send",
              source: "whatsapp",
              user_id: user.id,
              conversation_id: conversation.id,
              phone_number: phoneNumber,
              campaign_id: campaign.id,
              message: {
                body: renderedBody,
                provider_message_id: sendResult.providerMessageId,
                status: "sent",
                sent_at: startedAt,
              },
              raw_payload: sendResult.rawPayload,
            });
          }
        }
      } catch (error) {
        failedCount += 1;
        outcomes.push({
          contact_id: contact.id,
          phone_number: phoneNumber,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const completedAt = new Date().toISOString();
    const finalStatus = sentCount > 0 ? "completed" : "failed";

    const finalUpdate = hasWhatsappCampaigns
      ? {
          status: finalStatus,
          completed_at: completedAt,
          total_contacts: contacts.length,
          sent_count: sentCount,
          failed_count: failedCount,
          delivered: 0,
          failed: failedCount,
          sent_date: completedAt,
          outcomes,
        }
      : {
          status: finalStatus,
          completed_at: completedAt,
          total_contacts: contacts.length,
          sent_count: sentCount,
          failed_count: failedCount,
          outcomes,
        };

    const { error: updateError } = await admin
      .from(campaignTable)
      .update(finalUpdate)
      .eq("id", campaign.id)
      .eq("user_id", user.id);

    if (updateError) {
      return json(500, { error: updateError.message });
    }

    return json(200, {
      success: true,
      campaign_id: campaign.id,
      status: finalStatus,
      sent_count: sentCount,
      failed_count: failedCount,
      total_contacts: contacts.length,
      completed_at: completedAt,
    });
  } catch (error) {
    console.error("[run-whatsapp-campaign]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
