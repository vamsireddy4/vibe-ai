import { supabase } from "@/integrations/supabase/client";

/** A random 6-digit numeric verify token (crypto-random, 100000-999999). */
export function sixDigitToken() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + n);
}

/**
 * The user's WhatsApp webhook URL key + verify token, created once per account (RLS: only their own row;
 * user_id is unique, so a second call never replaces an existing token).
 */
export async function ensureWhatsAppWebhookConfig(userId: string) {
  const table = (supabase as any).from("whatsapp_webhook_configs");
  const { data: existing } = await table.select("*").eq("user_id", userId).maybeSingle();
  if (existing) return existing;
  await (supabase as any)
    .from("whatsapp_webhook_configs")
    .upsert({ user_id: userId, verify_token: sixDigitToken() }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data } = await (supabase as any).from("whatsapp_webhook_configs").select("*").eq("user_id", userId).maybeSingle();
  return data ?? null;
}
