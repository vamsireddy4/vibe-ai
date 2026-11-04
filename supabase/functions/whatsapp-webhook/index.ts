import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

type WebhookConfig = {
  id: string;
  user_id: string;
  verify_token: string;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhoneNumber(value: string | null | undefined) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function getWebhookKey(url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  const functionIndex = segments.findIndex((segment) => segment === "whatsapp-webhook");
  return functionIndex >= 0 ? segments[functionIndex + 1] ?? "" : "";
}

async function getWebhookConfig(webhookKey: string): Promise<WebhookConfig | null> {
  if (!webhookKey) return null;

  const { data, error } = await admin
    .from("whatsapp_webhook_configs")
    .select("id, user_id, verify_token")
    .eq("webhook_key", webhookKey)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

async function sendMetaTextMessage(userId: string, to: string, body: string) {
  const { data: config, error: configError } = await admin
    .from("whatsapp_api_configs")
    .select("meta_access_token, meta_phone_number_id")
    .eq("user_id", userId)
    .single();

  if (configError || !config) {
    throw new Error("WhatsApp API configuration not found");
  }

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
    throw new Error(payload?.error?.message || "WhatsApp Cloud API request failed");
  }

  return {
    providerMessageId: payload?.messages?.[0]?.id ?? null,
    rawPayload: payload,
  };
}

async function ensureConversation(userId: string, phoneNumber: string, contactName: string, lastMessageText: string, sentAt: string) {
  const { data: existingConversation } = await admin
    .from("whatsapp_conversations")
    .select("id, unread_count")
    .eq("user_id", userId)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (existingConversation) {
    const { data: updatedConversation, error } = await admin
      .from("whatsapp_conversations")
      .update({
        contact_name: contactName,
        last_message_text: lastMessageText,
        last_message_at: sentAt,
        unread_count: Number(existingConversation.unread_count || 0) + 1,
      })
      .eq("id", existingConversation.id)
      .select("id")
      .single();

    if (error || !updatedConversation) throw error || new Error("Failed to update conversation");
    return updatedConversation.id;
  }

  const { data: insertedConversation, error } = await admin
    .from("whatsapp_conversations")
    .insert({
      user_id: userId,
      contact_name: contactName,
      phone_number: phoneNumber,
      last_message_text: lastMessageText,
      last_message_at: sentAt,
      unread_count: 1,
    })
    .select("id")
    .single();

  if (error || !insertedConversation) throw error || new Error("Failed to create conversation");
  return insertedConversation.id;
}

async function upsertWhatsappContact(userId: string, phoneNumber: string, name: string, rawContact: unknown) {
  await admin.from("whatsapp_contacts").upsert(
    {
      user_id: userId,
      phone_number: phoneNumber,
      name: name || phoneNumber,
      metadata: { source: "whatsapp_webhook", contact: rawContact },
    },
    { onConflict: "user_id,phone_number" },
  );
}

type AutoReplyConfig = {
  is_enabled: boolean;
  webhook_url: string | null;
};

async function getAutoReplyConfig(userId: string): Promise<AutoReplyConfig | null> {
  const { data, error } = await admin
    .from("whatsapp_auto_reply_configs")
    .select("is_enabled, webhook_url")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data || !data.is_enabled || !data.webhook_url) return null;
  return data;
}

async function postExternalWebhook(webhookUrl: string, payload: Record<string, unknown>) {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch (_error) {
    return null;
  }
}

async function maybeRunAutoReply(userId: string, conversationId: string, phoneNumber: string, inboundMessage: Record<string, unknown>) {
  const autoReplyConfig = await getAutoReplyConfig(userId);
  if (!autoReplyConfig) return;

  const payload = await postExternalWebhook(autoReplyConfig.webhook_url!, {
    event_type: "inbound_message",
    direction: "inbound",
    trigger: "message_received",
    source: "whatsapp",
    user_id: userId,
    conversation_id: conversationId,
    phone_number: phoneNumber,
    message: inboundMessage,
  });

  const replies = Array.isArray(payload?.messages)
    ? payload.messages
    : typeof payload?.reply_message === "string"
      ? payload.reply_message
          .split("||")
          .map((value: string) => value.trim())
          .filter(Boolean)
      : [];

  for (const reply of replies) {
    const sendResult = await sendMetaTextMessage(userId, phoneNumber, reply);
    const sentAt = new Date().toISOString();

    await admin.from("whatsapp_messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      direction: "outbound",
      body: reply,
      provider_message_id: sendResult.providerMessageId,
      status: "sent",
      raw_payload: sendResult.rawPayload,
      sent_at: sentAt,
    });

    await admin
      .from("whatsapp_conversations")
      .update({
        last_message_text: reply,
        last_message_at: sentAt,
      })
      .eq("id", conversationId);

    await postExternalWebhook(autoReplyConfig.webhook_url!, {
      event_type: "outbound_message",
      direction: "outbound",
      trigger: "auto_reply_sent",
      source: "whatsapp",
      user_id: userId,
      conversation_id: conversationId,
      phone_number: phoneNumber,
      message: {
        body: reply,
        provider_message_id: sendResult.providerMessageId,
        status: "sent",
        sent_at: sentAt,
      },
      raw_payload: sendResult.rawPayload,
    });
  }
}

async function handleInboundMessages(config: WebhookConfig, payload: any) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const contactsByPhone = new Map<string, { name: string; raw: unknown }>();

      for (const contact of value?.contacts ?? []) {
        const phoneNumber = normalizePhoneNumber(contact?.wa_id);
        if (!phoneNumber) continue;
        contactsByPhone.set(phoneNumber, {
          name: String(contact?.profile?.name || phoneNumber),
          raw: contact,
        });
      }

      for (const message of value?.messages ?? []) {
        const phoneNumber = normalizePhoneNumber(message?.from);
        if (!phoneNumber) continue;

        const contact = contactsByPhone.get(phoneNumber);
        const body =
          String(message?.text?.body || message?.button?.text || message?.interactive?.button_reply?.title || "").trim();
        const sentAt = message?.timestamp
          ? new Date(Number(message.timestamp) * 1000).toISOString()
          : new Date().toISOString();
        const contactName = contact?.name || phoneNumber;
        const conversationId = await ensureConversation(config.user_id, phoneNumber, contactName, body, sentAt);

        await upsertWhatsappContact(config.user_id, phoneNumber, contactName, contact?.raw ?? message);

        await admin.from("whatsapp_messages").insert({
          conversation_id: conversationId,
          user_id: config.user_id,
          direction: "inbound",
          body: body || "[Unsupported WhatsApp message]",
          provider_message_id: String(message?.id || ""),
          status: "delivered",
          raw_payload: message,
          sent_at: sentAt,
        });

        await maybeRunAutoReply(config.user_id, conversationId, phoneNumber, message);
      }

      for (const status of value?.statuses ?? []) {
        const nextStatus = String(status?.status || "").trim();
        const mappedStatus =
          nextStatus === "read" ? "read" : nextStatus === "delivered" ? "delivered" : nextStatus === "failed" ? "failed" : "sent";

        const updatePayload: Record<string, unknown> = {
          status: mappedStatus,
          raw_payload: status,
        };

        if (Array.isArray(status?.errors) && status.errors.length > 0) {
          updatePayload.error_message = String(status.errors[0]?.title || status.errors[0]?.message || "Message failed");
        }

        await admin
          .from("whatsapp_messages")
          .update(updatePayload)
          .eq("user_id", config.user_id)
          .eq("provider_message_id", String(status?.id || ""));
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const webhookKey = getWebhookKey(url);
    const config = await getWebhookConfig(webhookKey);

    if (!config) return json(404, { error: "Webhook configuration not found" });

    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") || "";

      if (mode === "subscribe" && token === config.verify_token) {
        return new Response(challenge, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "text/plain" },
        });
      }

      return json(403, { error: "Verification failed" });
    }

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    const payload = await req.json();
    const eventType = String(payload?.entry?.[0]?.changes?.[0]?.field || "messages");

    await admin.from("whatsapp_webhook_events").insert({
      user_id: config.user_id,
      webhook_config_id: config.id,
      event_type: eventType,
      payload,
    });

    await handleInboundMessages(config, payload);

    return json(200, { success: true });
  } catch (error) {
    console.error("[whatsapp-webhook]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
