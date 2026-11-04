import { useEffect, useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type WhatsAppAutoReplyConfigRow = {
  user_id: string;
  is_enabled: boolean;
  webhook_url: string | null;
};

const flowSteps = [
  {
    number: 1,
    title: "Customer sends a message",
    description: "A customer texts your WhatsApp business number",
  },
  {
    number: 2,
    title: "Your AI processes the message",
    description: "The message is forwarded to your webhook URL for AI processing",
  },
  {
    number: 3,
    title: "Auto-reply is sent",
    description: "Your AI returns a response which is automatically sent back to the customer",
  },
];

const codeSamples = [
  {
    title: "Response Format",
    description: (
      <>
        Your AI service should return a JSON response with a <code className="rounded bg-[#eef2f7] px-2 py-1 font-mono text-[0.9em]">reply_message</code> field:
      </>
    ),
    code: `{
  "reply_message": "Hello! How can I help you?"
}`,
  },
  {
    title: "Sending multiple messages",
    description: (
      <>
        Use <code className="rounded bg-[#eef2f7] px-2 py-1 font-mono text-[0.9em]">||</code> to split into separate messages:
      </>
    ),
    code: `{
  "reply_message": "Hello!||Here is your information..."
}`,
  },
  {
    title: "Newlines in message",
    description: (
      <>
        Use <code className="rounded bg-[#eef2f7] px-2 py-1 font-mono text-[0.9em]">\\n</code> for newlines:
      </>
    ),
    code: `{
  "reply_message": "Line 1\\nLine 2\\nLine 3"
}`,
  },
  {
    title: "No auto-reply",
    description: (
      <>
        Return any response without <code className="rounded bg-[#eef2f7] px-2 py-1 font-mono text-[0.9em]">reply_message</code> to skip the auto-reply:
      </>
    ),
    code: `// Return empty body or any JSON without reply_message
{}`,
  },
];

function SectionCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-[28px] border border-[#edf0f5] bg-white p-10 shadow-[0_12px_40px_rgba(15,23,42,0.06)] ${className}`}>
      {children}
    </section>
  );
}

export default function WhatsAppExternalIntegrations({ embedded = false }: { embedded?: boolean }) {
  const Shell = embedded ? Fragment : DashboardLayout;
  const { user } = useAuth();
  const [autoRepliesEnabled, setAutoRepliesEnabled] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["whatsapp-auto-reply-config", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<WhatsAppAutoReplyConfigRow | null> => {
      const { data, error } = await (supabase as any)
        .from("whatsapp_auto_reply_configs")
        .select("*")
        .eq("user_id", user!.id)
        .maybeSingle();

      if (error) throw error;
      return data ?? null;
    },
  });

  useEffect(() => {
    if (!data) return;
    setAutoRepliesEnabled(Boolean(data.is_enabled));
    setWebhookUrl(data.webhook_url ?? "");
  }, [data]);

  const handleSave = async () => {
    if (!user?.id) return;

    setSaving(true);
    const { error } = await (supabase as any).from("whatsapp_auto_reply_configs").upsert(
      {
        user_id: user.id,
        is_enabled: autoRepliesEnabled,
        webhook_url: webhookUrl.trim(),
      },
      { onConflict: "user_id" },
    );
    setSaving(false);

    if (error) {
      toast({
        title: "Unable to save integration settings",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    void refetch();
    toast({
      title: "Integration settings saved",
      description: "WhatsApp auto-reply configuration has been updated.",
    });
  };

  return (
    <Shell>
      <div className="space-y-8 text-[#172033]">
        {!embedded && (
        <div>
          <h1 className="text-[2.35rem] font-bold tracking-tight">WhatsApp Integrations</h1>
          <p className="mt-3 max-w-4xl text-[16px] leading-7 text-[#6b7280]">
            Connect AI auto-replies to your WhatsApp messages
          </p>
        </div>
        )}

        <SectionCard>
          <h2 className="text-[20px] font-bold tracking-tight">AI Auto-Replies</h2>

          <div className="mt-8 rounded-[24px] bg-[#f7f8fa] p-8">
            <div className="flex items-center justify-between gap-6">
              <div>
                <h3 className="text-[16px] font-semibold text-[#1f2937]">Enable Auto-Replies</h3>
                <p className="mt-2 text-[14px] text-[#6b7280]">Send automatic AI responses to incoming messages</p>
              </div>
              <Switch aria-label="Enable auto-replies" checked={autoRepliesEnabled} onCheckedChange={setAutoRepliesEnabled} />
            </div>
          </div>

          <div className="mt-8">
            <label htmlFor="whatsapp-auto-reply-webhook-url" className="block text-[15px] font-semibold text-[#374151]">Webhook URL</label>
            <Input
              id="whatsapp-auto-reply-webhook-url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              disabled={isLoading}
              className="mt-4 h-[56px] rounded-[18px] border-[#c7d0db] px-5 text-[15px] text-[#111827] shadow-none"
            />
            <p className="mt-3 text-[14px] text-[#6b7280]">Your AI service URL (n8n, Make.com, or custom)</p>
          </div>

          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || isLoading}
            className="mt-8 h-[52px] rounded-[16px] bg-[linear-gradient(135deg,#171717,#171717)] px-10 text-[16px] font-bold text-white shadow-none hover:bg-[linear-gradient(135deg,#171717,#171717)]"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </SectionCard>

        <SectionCard>
          <h2 className="text-[20px] font-bold tracking-tight">How It Works</h2>

          <div className="mt-8 space-y-8">
            {flowSteps.map((step) => (
              <div key={step.number} className="flex items-start gap-8">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#171717,#171717)] text-[20px] font-bold text-white">
                  {step.number}
                </div>
                <div>
                  <h3 className="text-[16px] font-semibold text-[#1f2937]">{step.title}</h3>
                  <p className="mt-2 text-[14px] leading-7 text-[#6b7280]">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard>
          <div className="space-y-10">
            {codeSamples.map((sample) => (
              <div key={sample.title}>
                <h2 className="text-[20px] font-bold tracking-tight">{sample.title}</h2>
                <div className="mt-4 text-[15px] leading-7 text-[#6b7280]">{sample.description}</div>
                <pre className="mt-4 overflow-x-auto rounded-[20px] bg-[#111827] px-6 py-5 font-mono text-[14px] leading-7 text-white">
                  <code>{sample.code}</code>
                </pre>
              </div>
            ))}

            <div className="rounded-[20px] border border-[#e4e4e7] bg-[#f4f4f5] px-6 py-5 text-[14px] leading-6 text-[#171717]">
              <span className="font-bold">Tip:</span> You don't need to include the customer's phone number. The system automatically routes your reply back to the sender.
            </div>
          </div>
        </SectionCard>
      </div>
    </Shell>
  );
}
