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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => ({}));
    const phoneNumber = String(body?.phoneNumber || "").trim();
    const contactName = String(body?.contactName || "").trim();
    const message = String(body?.message || "").trim();

    if (!phoneNumber || !message) {
      return json(400, { error: "phoneNumber and message are required" });
    }

    const [hasWhatsappConversations, hasWhatsappMessages, configResult] = await Promise.all([
      canReadTable("whatsapp_conversations"),
      canReadTable("whatsapp_messages"),
      admin
        .from("whatsapp_api_configs")
        .select("meta_access_token, meta_phone_number_id")
        .eq("user_id", user.id)
        .single(),
    ]);

    if (configResult.error || !configResult.data) {
      return json(400, { error: "WhatsApp API configuration not found" });
    }

    const accessToken = String(configResult.data.meta_access_token || "").trim();
    const phoneNumberId = String(configResult.data.meta_phone_number_id || "").trim();
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!accessToken || !phoneNumberId || !normalizedPhone) {
      return json(400, { error: "WhatsApp configuration or phone number is invalid" });
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
        to: normalizedPhone,
        type: "text",
        text: { body: message },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(500, {
        error:
          payload?.error?.message ||
          payload?.error?.error_user_msg ||
          "WhatsApp Cloud API request failed",
      });
    }

    const sentAt = new Date().toISOString();
    let conversationId: string | null = null;

    if (hasWhatsappConversations) {
      const { data: existingConversation } = await admin
        .from("whatsapp_conversations")
        .select("id")
        .eq("user_id", user.id)
        .eq("phone_number", normalizedPhone)
        .maybeSingle();

      if (existingConversation?.id) {
        conversationId = existingConversation.id;
        await admin
          .from("whatsapp_conversations")
          .update({
            contact_name: contactName || normalizedPhone,
            last_message_text: message,
            last_message_at: sentAt,
          })
          .eq("id", conversationId)
          .eq("user_id", user.id);
      } else {
        const { data: insertedConversation } = await admin
          .from("whatsapp_conversations")
          .insert({
            user_id: user.id,
            phone_number: normalizedPhone,
            contact_name: contactName || normalizedPhone,
            last_message_text: message,
            last_message_at: sentAt,
          })
          .select("id")
          .single();

        conversationId = insertedConversation?.id ?? null;
      }
    }

    if (hasWhatsappMessages && conversationId) {
      await admin.from("whatsapp_messages").insert({
        conversation_id: conversationId,
        user_id: user.id,
        direction: "outbound",
        body: message,
        provider_message_id: payload?.messages?.[0]?.id ?? null,
        status: "sent",
        raw_payload: payload,
        sent_at: sentAt,
      });
    }

    await notifyExternalWebhook(user.id, {
      event_type: "outbound_message",
      direction: "outbound",
      trigger: "manual_send",
      source: "whatsapp",
      user_id: user.id,
      conversation_id: conversationId,
      phone_number: normalizedPhone,
      message: {
        body: message,
        provider_message_id: payload?.messages?.[0]?.id ?? null,
        status: "sent",
        sent_at: sentAt,
      },
      raw_payload: payload,
    });

    return json(200, {
      success: true,
      messageId: payload?.messages?.[0]?.id ?? null,
      sentAt,
      conversationId,
    });
  } catch (error) {
    console.error("[send-whatsapp-direct-message]", error);
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
});
