import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(supabaseUrl, serviceRoleKey);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    console.warn("[run-sms-campaign] auth user resolution failed", error);
  }

  try {
    const [{ data: completedRows, error: completedError }, { data: campaignRows, error: campaignError }] = await Promise.all([
      admin.from("sms_completed_campaigns").select("user_id").eq("user_email", normalizedEmail),
      admin.from("sms_campaigns").select("user_id").eq("user_email", normalizedEmail),
    ]);

    if (!completedError && Array.isArray(completedRows)) {
      for (const row of completedRows) {
        const legacyUserId = String(row?.user_id || "").trim();
        if (legacyUserId) relatedUserIds.add(legacyUserId);
      }
    }

    if (!campaignError && Array.isArray(campaignRows)) {
      for (const row of campaignRows) {
        const legacyUserId = String(row?.user_id || "").trim();
        if (legacyUserId) relatedUserIds.add(legacyUserId);
      }
    }
  } catch (error) {
    console.warn("[run-sms-campaign] legacy ownership resolution failed", error);
  }

  return Array.from(relatedUserIds);
}

function normalizePhone(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return value.startsWith("+") ? `+${digits}` : `+${digits}`;
}

function normalizeSender(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "";

  if (/^[A-Za-z][A-Za-z0-9]{2,10}$/.test(value)) {
    return value;
  }

  return normalizePhone(value);
}

function isInternationalRecipient(phone: string) {
  return !!phone && !phone.startsWith("+1");
}

function getTelnyxSenderMode(phoneConfig: Record<string, unknown>) {
  return String(phoneConfig.sms_sender_type || "phone_number").trim() === "alpha_sender"
    ? "alpha_sender"
    : "phone_number";
}

function getContactValue(contact: Record<string, unknown>, token: string) {
  const normalized = token.replace(/[_\s]+/g, "").toLowerCase();
  for (const [key, value] of Object.entries(contact)) {
    const candidate = key.replace(/[_\s]+/g, "").toLowerCase();
    if (candidate === normalized) return value;
  }
  return undefined;
}

function renderTemplate(message: string, contact: Record<string, unknown>) {
  return message.replace(/<<\s*([^>]+?)\s*>>/g, (_, token: string) => {
    const value = getContactValue(contact, token);
    if (value == null) return "";
    if (typeof value === "object") return "";
    return String(value);
  }).trim();
}

function getRecipientNumber(contact: Record<string, unknown>) {
  const keys = ["phone_number", "phone number", "phone", "Phone", "mobile", "Mobile", "number"];
  for (const key of keys) {
    const value = getContactValue(contact, key);
    const normalized = normalizePhone(value);
    if (normalized) return normalized;
  }
  return "";
}

async function sendViaTelnyx(phoneConfig: any, to: string, text: string) {
  const apiKey = String(phoneConfig.telnyx_api_key || "").trim();
  if (!apiKey) throw new Error("Telnyx API key missing");

  const recipient = normalizePhone(to);
  const senderMode = getTelnyxSenderMode(phoneConfig);
  const payload: Record<string, unknown> = {
    to: recipient,
    text,
  };

  if (senderMode === "alpha_sender") {
    const alphaSender = normalizeSender(phoneConfig.telnyx_alpha_sender_id || phoneConfig.phone_number);
    const messagingProfileId = String(phoneConfig.telnyx_messaging_profile_id || "").trim();

    if (!alphaSender) {
      throw new Error("Telnyx alpha sender ID missing");
    }

    if (!messagingProfileId) {
      throw new Error("Telnyx messaging profile ID missing");
    }

    payload.from = alphaSender;
    payload.messaging_profile_id = messagingProfileId;
  } else {
    const senderNumber = normalizePhone(phoneConfig.phone_number);
    const from = normalizeSender(senderNumber);

    if (!from) {
      throw new Error("Telnyx phone number missing");
    }

    const senderConfigResponse = await fetch(
      `https://api.telnyx.com/v2/messaging_phone_numbers/${encodeURIComponent(senderNumber)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    const senderConfigPayload = await senderConfigResponse.json().catch(() => ({}));
    if (!senderConfigResponse.ok) {
      throw new Error(
        senderConfigPayload?.errors?.[0]?.detail ||
        senderConfigPayload?.error ||
        "Failed to verify Telnyx messaging phone number",
      );
    }

    const smsFeatures =
      senderConfigPayload?.data?.features?.sms ||
      senderConfigPayload?.data?.record?.features?.sms ||
      null;

    if (isInternationalRecipient(recipient) && smsFeatures?.international_outbound === false) {
      throw new Error("This Telnyx SMS number does not support international outbound messaging. Use an international-enabled Telnyx sender for this recipient.");
    }

    payload.from = from;
  }

  const resp = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseData = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(responseData?.errors?.[0]?.detail || responseData?.error || "Telnyx SMS failed");
  }

  return {
    providerMessageId: responseData?.data?.id || null,
    raw: responseData,
  };
}

async function sendViaTwilio(phoneConfig: any, to: string, text: string) {
  const sid = String(phoneConfig.twilio_account_sid || "").trim();
  const token = String(phoneConfig.twilio_auth_token || "").trim();
  if (!sid || !token) throw new Error("Twilio credentials missing");

  const from = normalizePhone(phoneConfig.phone_number);
  const recipient = normalizePhone(to);
  if (!from) throw new Error("Twilio phone number missing");
  if (!recipient) throw new Error("Recipient phone number missing");

  const body = new URLSearchParams({
    From: from,
    To: recipient,
    Body: text,
  });

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(payload?.message || payload?.error_message || "Twilio SMS failed");
  }

  return {
    providerMessageId: payload?.sid || null,
    raw: payload,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const localUserId = (Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? (req.headers.get("x-local-user-id") || "").trim() : "");
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "").trim();

    let user: { id: string; email?: string | null } | null = null;

    if (localUserId) {
      const { data: profile, error: profileError } = await admin
        .from("profiles")
        .select("user_id, id")
        .or(`user_id.eq.${localUserId},id.eq.${localUserId}`)
        .maybeSingle();

      if (profileError || !profile) {
        return json(401, { error: "Invalid local user" });
      }

      const { data: userLookup, error: userLookupError } = await admin.auth.admin.getUserById(profile.user_id);
      if (userLookupError || !userLookup?.user) {
        return json(401, { error: "Invalid local user" });
      }

      user = { id: userLookup.user.id, email: userLookup.user.email };
    } else {
      if (!token) return json(401, { error: "Missing authorization" });

      const { data: authData, error: authError } = await admin.auth.getUser(token);
      user = authData?.user ? { id: authData.user.id, email: authData.user.email } : null;
      if (authError || !user) return json(401, { error: "Unauthorized" });
    }

    const body = await req.json();
    const campaignId = String(body?.campaign_id || "").trim();
    const templateId = String(body?.template_id || "").trim();
    const phoneConfigId = String(body?.phone_config_id || "").trim();
    const selectedIndexes = Array.isArray(body?.selected_contact_indexes)
      ? body.selected_contact_indexes.filter((value: unknown) => Number.isInteger(value)).map((value: number) => Number(value))
      : [];

    if (!campaignId || !templateId || !phoneConfigId || !selectedIndexes.length) {
      return json(400, { error: "campaign_id, template_id, phone_config_id and selected_contact_indexes are required" });
    }

    const relatedUserIds = await resolveRelatedUserIds(user.id, user.email);

    const [{ data: campaign, error: campaignError }, { data: template, error: templateError }, { data: phoneConfig, error: phoneError }] = await Promise.all([
      admin.from("sms_campaigns").select("*").eq("id", campaignId).in("user_id", relatedUserIds).single(),
      admin.from("sms_templates").select("*").eq("id", templateId).in("user_id", relatedUserIds).single(),
      admin.from("phone_configs").select("*").eq("id", phoneConfigId).in("user_id", relatedUserIds).eq("is_active", true).single(),
    ]);

    if (campaignError || !campaign) return json(404, { error: "SMS campaign not found" });
    if (templateError || !template) return json(404, { error: "SMS template not found" });
    if (phoneError || !phoneConfig) return json(404, { error: "Connected mobile number not found" });

    const allContacts = Array.isArray(campaign.extracted_contacts) ? campaign.extracted_contacts as Array<Record<string, unknown>> : [];
    const selectedContacts = selectedIndexes
      .filter((index: number) => index >= 0 && index < allContacts.length)
      .map((index: number) => allContacts[index]);

    if (!selectedContacts.length) return json(400, { error: "No valid contacts selected" });

    const startedAt = new Date().toISOString();
    const outcomes: Array<Record<string, unknown>> = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const [index, contact] of selectedContacts.entries()) {
      const recipientNumber = getRecipientNumber(contact);
      const renderedMessage = renderTemplate(template.message, contact);

      if (!recipientNumber || !renderedMessage) {
        failedCount += 1;
        outcomes.push({
          contact_index: index,
          recipient_number: recipientNumber || null,
          rendered_message: renderedMessage,
          status: "failed",
          error: !recipientNumber ? "Recipient phone number missing" : "Rendered message is empty",
          contact,
        });
        continue;
      }

      try {
        const sendResult = phoneConfig.provider === "telnyx"
          ? await sendViaTelnyx(phoneConfig, recipientNumber, renderedMessage)
          : await sendViaTwilio(phoneConfig, recipientNumber, renderedMessage);

        sentCount += 1;
      outcomes.push({
        contact_index: index,
        recipient_number: recipientNumber,
        rendered_message: renderedMessage,
        status: "sent",
          provider: phoneConfig.provider,
          provider_message_id: sendResult.providerMessageId,
          contact,
        });
      } catch (error) {
        failedCount += 1;
        outcomes.push({
          contact_index: index,
          recipient_number: recipientNumber,
          rendered_message: renderedMessage,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          provider: phoneConfig.provider,
          contact,
        });
      }
    }

    const completedAt = new Date().toISOString();

    const completedPayload = {
      source_campaign_id: campaign.id,
      user_id: user.id,
      user_email: user.email || campaign.user_email,
      name: campaign.name,
      template_id: template.id,
      template_name: template.name,
      phone_config_id: phoneConfig.id,
      sender_phone_number: phoneConfig.phone_number,
      status: failedCount === selectedContacts.length ? "failed" : "completed",
      total_contacts: selectedContacts.length,
      sent_count: sentCount,
      failed_count: failedCount,
      selected_contacts: selectedContacts,
      outcomes,
      started_at: startedAt,
      completed_at: completedAt,
    };

    const { data: completedCampaign, error: completedError } = await admin
      .from("sms_completed_campaigns")
      .insert(completedPayload)
      .select("*")
      .single();

    if (completedError || !completedCampaign) {
      return json(500, { error: completedError?.message || "Failed to save completed SMS campaign" });
    }

    await admin
      .from("sms_campaigns")
      .update({ status: "completed", template_id: template.id })
      .eq("id", campaign.id)
      .in("user_id", relatedUserIds);

    return json(200, {
      success: true,
      completed_campaign: completedCampaign,
      sent_count: sentCount,
      failed_count: failedCount,
    });
  } catch (error) {
    console.error("[run-sms-campaign]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
