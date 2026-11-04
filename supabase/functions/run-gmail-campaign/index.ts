import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const googleClientId = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const googleClientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const GMAIL_CHANNEL_MARKER = "__magicteams_channel";
const GMAIL_TEMPLATE_FALLBACK_CATEGORY = "gmail:email";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isMissingTableError(message: string | undefined) {
  if (!message) return false;

  const normalized = message.toLowerCase();
  return (
    normalized.includes("schema cache") ||
    normalized.includes("could not find the table") ||
    normalized.includes("relation") ||
    normalized.includes("does not exist") ||
    normalized.includes("not found")
  );
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
    console.warn("[run-gmail-campaign] auth user resolution failed", error);
  }

  const addRowsToSet = (rows: Array<{ user_id?: unknown }> | null) => {
    for (const row of rows || []) {
      const legacyUserId = String(row?.user_id || "").trim();
      if (legacyUserId) relatedUserIds.add(legacyUserId);
    }
  };

  try {
    const [
      { data: gmailCompletedRows, error: gmailCompletedError },
      { data: gmailCampaignRows, error: gmailCampaignError },
      { data: smsCompletedRows, error: smsCompletedError },
      { data: smsCampaignRows, error: smsCampaignError },
    ] = await Promise.all([
      admin.from("gmail_completed_campaigns").select("user_id").eq("user_email", normalizedEmail),
      admin.from("gmail_campaigns").select("user_id").eq("user_email", normalizedEmail),
      admin.from("sms_completed_campaigns").select("user_id").eq("user_email", normalizedEmail),
      admin.from("sms_campaigns").select("user_id").eq("user_email", normalizedEmail),
    ]);

    if (!gmailCompletedError && Array.isArray(gmailCompletedRows)) addRowsToSet(gmailCompletedRows);
    if (!gmailCampaignError && Array.isArray(gmailCampaignRows)) addRowsToSet(gmailCampaignRows);
    if (!smsCompletedError && Array.isArray(smsCompletedRows)) addRowsToSet(smsCompletedRows);
    if (!smsCampaignError && Array.isArray(smsCampaignRows)) addRowsToSet(smsCampaignRows);
  } catch (error) {
    console.warn("[run-gmail-campaign] legacy ownership resolution failed", error);
  }

  return Array.from(relatedUserIds);
}

function getContactValue(contact: Record<string, unknown>, token: string) {
  const normalized = token.replace(/[_\s]+/g, "").toLowerCase();
  const candidates = [contact];
  const metadata = contact?.metadata;

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    candidates.push(metadata as Record<string, unknown>);
  }

  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate)) {
      const probe = key.replace(/[_\s]+/g, "").toLowerCase();
      if (probe === normalized && value != null && typeof value !== "object") {
        const textValue = String(value).trim();
        if (textValue) return textValue;
      }
    }
  }

  return "";
}

function renderTemplate(templateValue: string, contact: Record<string, unknown>) {
  return templateValue.replace(/<<\s*([^>]+?)\s*>>/g, (_, token: string) => getContactValue(contact, token));
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function encodeMimeMessage(mime: string) {
  return btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

    return { id: userLookup.user.id, email: userLookup.user.email };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;

  return { id: data.user.id, email: data.user.email };
}

async function refreshGoogleAccessToken(integration: Record<string, unknown>) {
  const accessToken = String(integration?.access_token || integration?.api_key || "").trim();
  const expiresAt = integration?.token_expires_at ? new Date(String(integration.token_expires_at)).getTime() : 0;
  if (accessToken && expiresAt > Date.now() + 60_000) {
    return accessToken;
  }

  const refreshToken = String(integration?.refresh_token || "").trim();
  if (!refreshToken) {
    if (accessToken) return accessToken;
    throw new Error("Connected Gmail account is missing a refresh token");
  }

  if (!googleClientId || !googleClientSecret) {
    throw new Error("Google OAuth credentials are required to refresh the connected Gmail token");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson?.access_token) {
    throw new Error(tokenJson?.error_description || tokenJson?.error || "Failed to refresh Gmail access token");
  }

  const tokenExpiresAt = new Date(Date.now() + Number(tokenJson.expires_in || 3600) * 1000).toISOString();
  const { error: updateError } = await admin
    .from("calendar_integrations")
    .update({
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token || refreshToken,
      token_expires_at: tokenExpiresAt,
    })
    .eq("id", String(integration.id || ""));

  if (updateError) {
    throw new Error(updateError.message || "Failed to persist refreshed Gmail token");
  }

  return String(tokenJson.access_token);
}

/** Send from the Gmail the user connected in CRM Integrations (Composio), when there's no direct Gmail sign-in. */
async function sendViaComposio(userId: string, recipientEmail: string, subject: string, messageBody: string) {
  const apiKey = Deno.env.get("COMPOSIO_API_KEY") || "";
  if (!apiKey) throw new Error("Connect Gmail in CRM Integrations first.");
  const response = await fetch("https://backend.composio.dev/api/v3/tools/execute/GMAIL_SEND_EMAIL", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, arguments: { recipient_email: recipientEmail, subject: subject || "(no subject)", body: messageBody, user_id: "me" } }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.successful === false) {
    const reason = String(payload?.error?.message || payload?.error || payload?.message || "Gmail did not send the email");
    throw new Error(/connect|auth|account/i.test(reason) ? `Connect Gmail in CRM Integrations first. (${reason})` : reason);
  }
  return payload?.data?.response_data ?? payload?.data ?? {};
}

async function sendGmailMessage(
  integration: Record<string, unknown> | undefined,
  recipientEmail: string,
  subject: string,
  messageBody: string,
  userId: string,
) {
  if (!integration) return sendViaComposio(userId, recipientEmail, subject, messageBody);
  const accessToken = await refreshGoogleAccessToken(integration);
  const mime = [
    `To: ${recipientEmail}`,
    `Subject: ${subject || "(no subject)"}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    messageBody,
  ].join("\r\n");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodeMimeMessage(mime) }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.error?.message || payload?.message || "Failed to send Gmail message"));
  }

  return payload;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const campaignId = String(body?.campaign_id || "").trim();
    const templateId = String(body?.template_id || "").trim();
    const selectedIndexes = Array.isArray(body?.selected_contact_indexes)
      ? body.selected_contact_indexes.filter((value: unknown) => Number.isInteger(value)).map((value: number) => Number(value))
      : [];
    const recipientEmail = String(body?.recipient_email || "").trim();
    const subject = String(body?.subject || "").trim();
    const message = String(body?.message || "").trim();

    if (!campaignId && (!recipientEmail || !message)) {
      return json(400, { error: "Either campaign_id or recipient_email and message are required" });
    }

    if (!campaignId) {
      const { data: integrations, error: integrationError } = await admin
        .from("calendar_integrations")
        .select("*")
        .eq("provider", "gmail")
        .eq("is_active", true)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (integrationError) {
        return json(500, { error: integrationError.message || "Failed to load Gmail integration" });
      }

      const integrationRows = Array.isArray(integrations) ? integrations : [];
      const gmailIntegration =
        integrationRows.find((item: any) => String(item?.refresh_token || "").trim()) ||
        integrationRows.find((item: any) => String(item?.access_token || item?.api_key || "").trim()) ||
        integrationRows[0];

      // No direct Gmail sign-in: sendGmailMessage uses the Gmail connected in CRM Integrations.
      const sendPayload = await sendGmailMessage(gmailIntegration, recipientEmail, subject, message, user.id);
      return json(200, {
        success: true,
        messageId: sendPayload?.id || null,
        sentAt: new Date().toISOString(),
      });
    }

    if (!templateId || !selectedIndexes.length) {
      return json(400, { error: "template_id and selected_contact_indexes are required for campaign mode" });
    }

    const relatedUserIds = await resolveRelatedUserIds(user.id, user.email);

    let campaign: Record<string, any> | null = null;
    let campaignTableName = "gmail_campaigns";

    const { data: gmailCampaign, error: gmailCampaignError } = await admin
      .from("gmail_campaigns")
      .select("*")
      .eq("id", campaignId)
      .in("user_id", relatedUserIds)
      .single();

    if (gmailCampaignError && !isMissingTableError(gmailCampaignError.message)) {
      return json(404, { error: "Gmail campaign not found" });
    }

    if (gmailCampaign) {
      campaign = gmailCampaign;
    } else {
      const { data: smsCampaign, error: smsCampaignError } = await admin
        .from("sms_campaigns")
        .select("*")
        .eq("id", campaignId)
        .in("user_id", relatedUserIds)
        .single();

      if (smsCampaignError || !smsCampaign) {
        return json(404, { error: "Gmail campaign not found" });
      }

      const fallbackContacts = Array.isArray(smsCampaign.extracted_contacts) ? smsCampaign.extracted_contacts : [];
      const isGmailFallback = fallbackContacts.some((contact: any) => {
        const metadata = contact?.metadata;
        return metadata && typeof metadata === "object" && metadata[GMAIL_CHANNEL_MARKER] === "gmail";
      });

      if (!isGmailFallback) {
        return json(404, { error: "Gmail campaign not found" });
      }

      campaign = smsCampaign;
      campaignTableName = "sms_campaigns";
    }

    let template: Record<string, any> | null = null;
    let templateTableName = "gmail_templates";

    const { data: gmailTemplate, error: gmailTemplateError } = await admin
      .from("gmail_templates")
      .select("*")
      .eq("id", templateId)
      .in("user_id", relatedUserIds)
      .single();

    if (gmailTemplateError && !isMissingTableError(gmailTemplateError.message)) {
      return json(404, { error: "Gmail template not found" });
    }

    if (gmailTemplate) {
      template = gmailTemplate;
    } else {
      const { data: smsTemplate, error: smsTemplateError } = await admin
        .from("sms_templates")
        .select("*")
        .eq("id", templateId)
        .in("user_id", relatedUserIds)
        .single();

      if (smsTemplateError || !smsTemplate || smsTemplate.category !== GMAIL_TEMPLATE_FALLBACK_CATEGORY) {
        return json(404, { error: "Gmail template not found" });
      }

      template = smsTemplate;
      templateTableName = "sms_templates";
    }

    // Both are guaranteed resolved by the guards above; this assertion narrows the
    // nullable types for the rest of the handler without changing behavior.
    if (!campaign || !template) {
      return json(404, { error: "Gmail campaign or template not found" });
    }

    const { data: integrations, error: integrationError } = await admin
      .from("calendar_integrations")
      .select("*")
      .eq("provider", "gmail")
      .eq("is_active", true)
      .in("user_id", relatedUserIds)
      .order("created_at", { ascending: true });

    if (integrationError) {
      return json(500, { error: integrationError.message || "Failed to load Gmail integration" });
    }

    const integrationRows = Array.isArray(integrations) ? integrations : [];
    const gmailIntegration =
      integrationRows.find((item: any) => String(item?.refresh_token || "").trim()) ||
      integrationRows.find((item: any) => String(item?.access_token || item?.api_key || "").trim()) ||
      integrationRows[0];


    let templateConfig: { to: string; subject: string; body: string } = { to: "<<email>>", subject: "", body: "" };
    try {
      const parsed = JSON.parse(String(template.message || "{}"));
      templateConfig = {
        to: String(parsed?.to || "<<email>>"),
        subject: String(parsed?.subject || ""),
        body: String(parsed?.body || ""),
      };
    } catch {
      templateConfig = { to: "<<email>>", subject: "", body: String(template.message || "") };
    }

    const allContacts = Array.isArray(campaign.extracted_contacts) ? campaign.extracted_contacts : [];
    const selectedContacts = selectedIndexes
      .filter((index: number) => index >= 0 && index < allContacts.length)
      .map((index: number) => {
        const contact = allContacts[index];
        const metadata = contact?.metadata;
        const normalizedMetadata =
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? { ...(metadata as Record<string, unknown>), [GMAIL_CHANNEL_MARKER]: "gmail" }
            : { [GMAIL_CHANNEL_MARKER]: "gmail" };
        return { ...contact, metadata: normalizedMetadata };
      });

    if (!selectedContacts.length) {
      return json(400, { error: "No valid contacts selected" });
    }

    const senderEmail = String(gmailIntegration?.display_name || user.email || "").trim() || user.email || "";
    const startedAt = new Date().toISOString();
    const outcomes: Array<Record<string, unknown>> = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const [index, contact] of selectedContacts.entries()) {
      const recipientEmail = renderTemplate(templateConfig.to, contact).split(/[;,]/)[0]?.trim() || getContactValue(contact, "email");
      const renderedSubject = renderTemplate(templateConfig.subject, contact).trim();
      const renderedBody = renderTemplate(templateConfig.body, contact).trim();

      if (!recipientEmail || !isValidEmail(recipientEmail)) {
        failedCount += 1;
        outcomes.push({
          contact_index: index,
          recipient_email: recipientEmail || null,
          rendered_subject: renderedSubject,
          rendered_message: renderedBody,
          status: "failed",
          error: "Recipient email is missing or invalid",
          [GMAIL_CHANNEL_MARKER]: "gmail",
          contact,
        });
        continue;
      }

      try {
        const sendPayload = await sendGmailMessage(gmailIntegration, recipientEmail, renderedSubject, renderedBody, user.id);
        sentCount += 1;
        outcomes.push({
          contact_index: index,
          recipient_email: recipientEmail,
          rendered_subject: renderedSubject,
          rendered_message: renderedBody,
          provider_message_id: sendPayload?.id ? String(sendPayload.id) : null,
          status: "sent",
          [GMAIL_CHANNEL_MARKER]: "gmail",
          contact,
        });
      } catch (error) {
        failedCount += 1;
        outcomes.push({
          contact_index: index,
          recipient_email: recipientEmail,
          rendered_subject: renderedSubject,
          rendered_message: renderedBody,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          [GMAIL_CHANNEL_MARKER]: "gmail",
          contact,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const status = failedCount === selectedContacts.length ? "failed" : "completed";
    const completedCampaignStatus = failedCount === selectedContacts.length ? "failed" : "completed";
    const gmailTemplateIdForGmailTables = templateTableName === "gmail_templates" ? template.id : null;
    const smsTemplateIdForSmsTables = templateTableName === "sms_templates" ? template.id : null;
    const gmailSourceCampaignId = campaignTableName === "gmail_campaigns" ? campaign.id : null;
    const smsSourceCampaignId = campaignTableName === "sms_campaigns" ? campaign.id : null;

    const baseCompletedPayload = {
      user_id: user.id,
      user_email: user.email || campaign.user_email,
      name: String(campaign.name || "Gmail Campaign"),
      template_id: gmailTemplateIdForGmailTables,
      template_name: String(template.name || "Gmail Template"),
      total_contacts: selectedContacts.length,
      sent_count: sentCount,
      failed_count: failedCount,
      started_at: startedAt,
      completed_at: completedAt,
      selected_contacts: selectedContacts,
      outcomes,
      source_campaign_id: gmailSourceCampaignId,
      status: completedCampaignStatus,
    };

    let completedCampaign: Record<string, unknown> | null = null;

    const { data: gmailCompletedCampaign, error: gmailCompletedError } = await admin
      .from("gmail_completed_campaigns")
      .insert({
        ...baseCompletedPayload,
        sender_email_address: senderEmail,
      })
      .select("*")
      .single();

    if (gmailCompletedError && !isMissingTableError(gmailCompletedError.message)) {
      return json(500, { error: gmailCompletedError.message || "Failed to save Gmail completed campaign" });
    }

    if (gmailCompletedCampaign) {
      completedCampaign = gmailCompletedCampaign;
    } else {
      const { data: smsCompletedCampaign, error: smsCompletedError } = await admin
        .from("sms_completed_campaigns")
        .insert({
          ...baseCompletedPayload,
          template_id: smsTemplateIdForSmsTables,
          source_campaign_id: smsSourceCampaignId,
          sender_phone_number: senderEmail,
        })
        .select("*")
        .single();

      if (smsCompletedError || !smsCompletedCampaign) {
        return json(500, { error: smsCompletedError?.message || "Failed to save Gmail completed campaign" });
      }

      completedCampaign = {
        ...smsCompletedCampaign,
        sender_email_address: senderEmail,
        template_id: template.id,
        source_campaign_id: campaign.id,
      };
    }

    await admin
      .from(campaignTableName)
      .update({
        status: "completed",
        template_id: campaignTableName === "gmail_campaigns"
          ? gmailTemplateIdForGmailTables
          : smsTemplateIdForSmsTables,
      })
      .eq("id", campaign.id)
      .in("user_id", relatedUserIds);

    return json(200, {
      success: true,
      completed_campaign: completedCampaign,
      sent_count: sentCount,
      failed_count: failedCount,
    });
  } catch (error) {
    console.error("[run-gmail-campaign]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
