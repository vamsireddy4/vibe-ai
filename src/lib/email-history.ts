// Single emails (Front, Ask Vibe) in History > Email, saved like a one-recipient campaign send
// (gmail_completed_campaigns, which History already lists; RLS: the user's own rows).
import { supabase } from "@/integrations/supabase/client";

export async function recordSingleEmail(e: {
  userId: string; userEmail: string; from: string; to: string; subject: string; body: string;
  ok: boolean; messageId?: string | null; error?: string | null;
}) {
  const now = new Date().toISOString();
  const { error } = await (supabase as any).from("gmail_completed_campaigns").insert({
    user_id: e.userId,
    user_email: e.userEmail,
    name: e.subject.trim() || "(no subject)",
    template_name: "Single email",
    sender_email_address: e.from,
    status: e.ok ? "completed" : "failed",
    total_contacts: 1,
    sent_count: e.ok ? 1 : 0,
    failed_count: e.ok ? 0 : 1,
    selected_contacts: [{ email: e.to }],
    outcomes: [{
      recipient_email: e.to, status: e.ok ? "sent" : "failed", rendered_subject: e.subject, rendered_message: e.body,
      provider_message_id: e.messageId ?? null, error: e.error ?? null, __magicteams_channel: "gmail",
    }],
    started_at: now,
    completed_at: now,
  });
  if (error) console.error("email history not saved", error.message); // the email itself was already handled
}
