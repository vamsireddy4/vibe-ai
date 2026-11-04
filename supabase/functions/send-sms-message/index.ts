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

function normalizePhone(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

function normalizeSender(raw: unknown) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^[A-Za-z][A-Za-z0-9]{2,10}$/.test(value)) return value;
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

    if (!alphaSender) throw new Error("Telnyx alpha sender ID missing");
    if (!messagingProfileId) throw new Error("Telnyx messaging profile ID missing");

    payload.from = alphaSender;
    payload.messaging_profile_id = messagingProfileId;
  } else {
    const senderNumber = normalizePhone(phoneConfig.phone_number);
    const from = normalizeSender(senderNumber);

    if (!from) throw new Error("Telnyx phone number missing");

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

  const body = new URLSearchParams({
    From: phoneConfig.phone_number,
    To: normalizePhone(to),
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

  const responseData = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(responseData?.message || responseData?.error_message || "Twilio SMS failed");
  }

  return {
    providerMessageId: responseData?.sid || null,
    raw: responseData,
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

      if (profileError || !profile) return json(401, { error: "Invalid local user" });

      const { data: userLookup, error: userLookupError } = await admin.auth.admin.getUserById(profile.user_id);
      if (userLookupError || !userLookup?.user) return json(401, { error: "Invalid local user" });
      user = { id: userLookup.user.id, email: userLookup.user.email };
    } else {
      if (!token) return json(401, { error: "Missing authorization" });
      const { data: authData, error: authError } = await admin.auth.getUser(token);
      user = authData?.user ? { id: authData.user.id, email: authData.user.email } : null;
      if (authError || !user) return json(401, { error: "Unauthorized" });
    }

    const body = await req.json();
    const completedCampaignId = String(body?.completed_campaign_id || "").trim();
    const directPhoneConfigId = String(body?.phone_config_id || "").trim();
    const recipientNumber = normalizePhone(body?.recipient_number);
    const message = String(body?.message || "").trim();

    if (!recipientNumber || !message) {
      return json(400, { error: "recipient_number and message are required" });
    }

    if (!completedCampaignId && !directPhoneConfigId) {
      return json(400, { error: "Either completed_campaign_id or phone_config_id is required" });
    }

    let phoneConfigId = directPhoneConfigId;
    let completedCampaign = null;

    if (completedCampaignId) {
      const { data: campaign, error: completedError } = await admin
        .from("sms_completed_campaigns")
        .select("*")
        .eq("id", completedCampaignId)
        .eq("user_id", user.id)
        .single();

      if (completedError || !campaign) return json(404, { error: "Completed SMS campaign not found" });
      completedCampaign = campaign;
      phoneConfigId = String(campaign.phone_config_id || "").trim();
    }

    if (!phoneConfigId) return json(400, { error: "No sender is associated with this SMS message" });

    const { data: phoneConfig, error: phoneError } = await admin
      .from("phone_configs")
      .select("*")
      .eq("id", phoneConfigId)
      .eq("user_id", user.id)
      .single();

    if (phoneError || !phoneConfig) return json(404, { error: "Connected mobile number not found" });

    let sendResult;
    if (phoneConfig.provider === "telnyx") {
      sendResult = await sendViaTelnyx(phoneConfig, recipientNumber, message);
    } else {
      sendResult = await sendViaTwilio(phoneConfig, recipientNumber, message);
    }

    let outcome = null;
    let updatedCampaign = null;

    if (completedCampaign) {
      const existingOutcomes = Array.isArray(completedCampaign.outcomes) ? completedCampaign.outcomes : [];
      const newOutcome = {
        contact_index: null,
        recipient_number: recipientNumber,
        rendered_message: message,
        status: "sent",
        provider: phoneConfig.provider,
        provider_message_id: sendResult.providerMessageId,
        sender_phone_number: phoneConfig.phone_number,
        created_at: new Date().toISOString(),
        source: "conversation_reply",
      };
      const updatedOutcomes = [...existingOutcomes, newOutcome];

      const { data: campaignUpdate, error: updateError } = await admin
        .from("sms_completed_campaigns")
        .update({
          outcomes: updatedOutcomes,
          sent_count: Number(completedCampaign.sent_count || 0) + 1,
          completed_at: new Date().toISOString(),
        })
        .eq("id", completedCampaignId)
        .eq("user_id", user.id)
        .select("*")
        .single();

      if (updateError || !campaignUpdate) {
        return json(500, { error: updateError?.message || "Failed to update SMS conversation" });
      }
      outcome = newOutcome;
      updatedCampaign = campaignUpdate;
    } else {
      outcome = {
        recipient_number: recipientNumber,
        rendered_message: message,
        status: "sent",
        provider: phoneConfig.provider,
        provider_message_id: sendResult.providerMessageId,
        sender_phone_number: phoneConfig.phone_number,
        created_at: new Date().toISOString(),
        source: "direct_reply",
      };
    }

    return json(200, {
      success: true,
      outcome,
      completed_campaign: updatedCampaign,
    });
  } catch (error) {
    console.error("[send-sms-message]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
