import { useEffect, useId, useMemo, useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { ensureWhatsAppWebhookConfig } from "@/lib/whatsapp-webhook";
import { CheckCircle2, Copy, Eye, EyeOff, Info } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage, isEdgeFunctionUnavailable } from "@/lib/edge-functions";

type WhatsAppApiConfigRow = {
  id: string;
  user_id: string;
  meta_access_token: string | null;
  meta_phone_number_id: string | null;
  meta_business_account_id: string | null;
  meta_app_id: string | null;
  validated_at: string | null;
};

type WhatsAppWebhookConfigRow = {
  id: string;
  user_id: string;
  webhook_key: string;
  verify_token: string;
};

type WhatsAppApiPageData = {
  apiConfig: WhatsAppApiConfigRow | null;
  webhookConfig: WhatsAppWebhookConfigRow | null;
};

type CredentialValidationResult = {
  valid: boolean;
  error?: string;
  details?: string;
};

const webhookSteps = [
  "Copy the webhook URL above",
  "Go to Meta Business Manager",
  "Navigate to WhatsApp > Configuration > Webhooks",
  "Paste your webhook URL and the verify token shown above",
  "Subscribe to message and status events",
];

const credentialSteps = [
  "Go to Meta for Developers",
  "Navigate to your App Dashboard",
  'App ID: Found at the top of your App Dashboard (e.g., "App ID: 123456789")',
  "Select WhatsApp > API Setup",
  "Copy your Access Token, Phone Number ID, and Business Account ID (WABA ID)",
];

function CopyButton({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  const disabled = !value || value === "—";

  const handleCopy = async () => {
    if (disabled) return;
    await navigator.clipboard.writeText(value);
    toast({ title: "Copied to clipboard" });
  };

  return (
    <Button
      type="button"
      onClick={() => void handleCopy()}
      disabled={disabled}
      aria-label={`Copy ${label}`}
      className="h-[56px] min-w-[120px] rounded-[16px] bg-[linear-gradient(135deg,#171717,#171717)] px-5 text-[16px] font-bold text-white shadow-none hover:bg-[linear-gradient(135deg,#171717,#171717)]"
    >
      <Copy className="mr-3 h-5 w-5" />
      Copy
    </Button>
  );
}

function ReadonlyField({
  label,
  value,
  helper,
  required = false,
  copyable = false,
  sensitive = false,
}: {
  label: string;
  value: string;
  helper?: string;
  required?: boolean;
  copyable?: boolean;
  sensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();

  return (
    <div className="space-y-3">
      <label htmlFor={inputId} className="block text-[16px] font-semibold text-[#3e495b]">
        {label}
        {required ? <span className="ml-1 text-[#ef4444]">*</span> : null}
      </label>
      <div className="flex flex-col gap-1.5 xl:flex-row xl:items-center">
        <Input
          id={inputId}
          type={sensitive && !revealed ? "password" : "text"}
          value={value}
          readOnly
          className="h-[50px] rounded-[16px] border-[#c8d0dc] bg-white px-5 font-mono text-[15px] text-[#101828] shadow-none"
        />
        {sensitive ? (
          <Button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-label={`${revealed ? "Hide" : "Show"} ${label}`}
            className="h-[56px] min-w-[56px] rounded-[16px] border-0 bg-transparent px-3 text-[#5b6678] shadow-none hover:bg-transparent"
          >
            {revealed ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </Button>
        ) : null}
        {copyable ? <CopyButton value={value} label={label} /> : null}
      </div>
      {helper ? <p className="text-[14px] leading-6 text-[#667085]">{helper}</p> : null}
    </div>
  );
}

function EditableField({
  label,
  value,
  onChange,
  helper,
  required = false,
  copyable = false,
  sensitive = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  required?: boolean;
  copyable?: boolean;
  sensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();

  return (
    <div className="space-y-3">
      <label htmlFor={inputId} className="block text-[16px] font-semibold text-[#3e495b]">
        {label}
        {required ? <span className="ml-1 text-[#ef4444]">*</span> : null}
      </label>
      <div className="flex flex-col gap-4 xl:flex-row">
        <Input
          id={inputId}
          type={sensitive && !revealed ? "password" : "text"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-[50px] rounded-[16px] border-[#c8d0dc] bg-white px-5 text-[15px] text-[#101828] shadow-none"
        />
        {sensitive ? (
          <Button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-label={`${revealed ? "Hide" : "Show"} ${label}`}
            className="h-[56px] min-w-[56px] rounded-[16px] border-0 bg-transparent px-3 text-[#5b6678] shadow-none hover:bg-transparent"
          >
            {revealed ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </Button>
        ) : null}
        {copyable ? <CopyButton value={value} label={label} /> : null}
      </div>
      {helper ? <p className="text-[14px] leading-6 text-[#667085]">{helper}</p> : null}
    </div>
  );
}

function InfoPanel({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div className="rounded-[20px] border border-[#e4e4e7] bg-[#f4f4f5] px-7 py-6">
      <div className="flex items-start gap-4">
        <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#171717] text-white">
          <Info className="h-5 w-5" />
        </div>
        <div className="space-y-3">
          <h3 className="text-[16px] font-semibold text-[#171717]">{title}</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-[14px] leading-6 text-[#171717]">
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

export default function WhatsAppApi({ embedded = false }: { embedded?: boolean }) {
  const Shell = embedded ? Fragment : DashboardLayout;
  const { user } = useAuth();
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [appId, setAppId] = useState("");
  const [isValidated, setIsValidated] = useState(false);
  const [validatedAt, setValidatedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string>("");
  const { toast } = useToast();
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["whatsapp-api-config", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<WhatsAppApiPageData> => {
      const [apiConfigResult, webhookConfigResult] = await Promise.all([
        (supabase as any)
          .from("whatsapp_api_configs")
          .select("*")
          .eq("user_id", user!.id)
          .maybeSingle(),
        ensureWhatsAppWebhookConfig(user!.id), // created on first visit if the account doesn't have one yet
      ]);

      if (apiConfigResult.error) throw apiConfigResult.error;

      return {
        apiConfig: apiConfigResult.data ?? null,
        webhookConfig: webhookConfigResult ?? null,
      };
    },
  });

  useEffect(() => {
    if (!data?.apiConfig) return;

    setAccessToken(data.apiConfig.meta_access_token ?? "");
    setPhoneNumberId(data.apiConfig.meta_phone_number_id ?? "");
    setWabaId(data.apiConfig.meta_business_account_id ?? "");
    setAppId(data.apiConfig.meta_app_id ?? "");
    setIsValidated(Boolean(data.apiConfig.validated_at));
    setValidatedAt(data.apiConfig.validated_at ?? null);
    setValidationMessage("");
  }, [data]);

  const allFieldsFilled = useMemo(
    () => [accessToken, phoneNumberId, wabaId, appId].every((value) => value.trim().length > 0),
    [accessToken, phoneNumberId, wabaId, appId],
  );

  const webhookUrl = data?.webhookConfig?.webhook_key
    ? `${window.location.origin}/whatsapp-webhook/${data.webhookConfig.webhook_key}` // served on Cloudflare (functions/whatsapp-webhook)
    : "—";
  const verifyToken = data?.webhookConfig?.verify_token ?? "—";

  const handleValidate = async () => {
    if (!allFieldsFilled) {
      toast({
        title: "Missing required fields",
        description: "Fill in all WhatsApp API credentials before validating.",
      });
      setIsValidated(false);
      return;
    }

    if (!user?.id) return;

    setSaving(true);
    setValidationMessage("");

    try {
      let validation: CredentialValidationResult | null = null;
      try {
        const { data, error } = await supabase.functions.invoke("validate-whatsapp-api-credentials", {
          body: {
            accessToken: accessToken.trim(),
            phoneNumberId: phoneNumberId.trim(),
            businessAccountId: wabaId.trim(),
          },
        });

        if (error) {
          throw error;
        }

        validation = (data ?? null) as CredentialValidationResult | null;
      } catch (error) {
        if (!isEdgeFunctionUnavailable(error)) {
          throw error;
        }

        const response = await fetch("/api/local/validate-whatsapp-api-credentials", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accessToken: accessToken.trim(),
            phoneNumberId: phoneNumberId.trim(),
            businessAccountId: wabaId.trim(),
          }),
        });

        validation = (await response.json().catch(() => ({}))) as CredentialValidationResult;
        if (!response.ok) {
          throw new Error(validation?.details || validation?.error || "Credential validation failed");
        }
      }

      if (!validation?.valid) {
        setIsValidated(false);
        setValidatedAt(null);
        setValidationMessage(validation?.details || validation?.error || "Credential validation failed.");
        toast({
          title: validation?.error || "Credential validation failed",
          description: validation?.details || "Meta did not accept these credentials.",
          variant: "destructive",
        });
        return;
      }

      const nextValidatedAt = new Date().toISOString();
      const { error } = await (supabase as any).from("whatsapp_api_configs").upsert(
        {
          user_id: user.id,
          meta_access_token: accessToken.trim(),
          meta_phone_number_id: phoneNumberId.trim(),
          meta_business_account_id: wabaId.trim(),
          meta_app_id: appId.trim(),
          validated_at: nextValidatedAt,
        },
        { onConflict: "user_id" },
      );

      if (error) {
        throw error;
      }

      setIsValidated(true);
      setValidatedAt(nextValidatedAt);
      setValidationMessage(validation.details || "WhatsApp Business API credentials are valid and properly linked.");
      void refetch();
      toast({
        title: "Credentials validated",
        description: validation.details || "WhatsApp Business API credentials look ready to use.",
      });
    } catch (error) {
      setIsValidated(false);
      setValidatedAt(null);
      setValidationMessage("");
      toast({
        title: "Unable to validate credentials",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell>
      <div className="space-y-10 text-[#182033]">
        {!embedded && (
        <div>
          <h1 className="text-3xl font-bold tracking-tight">WhatsApp API</h1>
          <p className="mt-3 max-w-4xl text-[16px] leading-7 text-[#5b6678]">
            Configure your Meta WhatsApp Business API credentials and webhook details to enable automated messaging.
          </p>
        </div>
        )}

        <section className="space-y-8 rounded-[28px] border border-[#e5eaf2] bg-white p-10 shadow-sm">
          <div>
            <h2 className="text-[22px] font-bold tracking-tight">WhatsApp Business API</h2>
            <p className="mt-3 text-[16px] leading-7 text-[#5b6678]">
              Configure your Meta WhatsApp Business API credentials to enable automated messaging.
            </p>
          </div>

          <div className="rounded-[22px] border border-[#f4dc64] bg-[#fffbea] px-6 py-5 text-[15px] leading-7 text-[#9a5a0a]">
            <span className="font-bold">Note:</span> Credentials are automatically saved after successful validation. You must validate before using WhatsApp features.
          </div>

          <div className="space-y-7">
            <EditableField
              label="Meta Access Token"
              value={accessToken}
              onChange={(value) => {
                setAccessToken(value);
                setIsValidated(false);
                setValidationMessage("");
              }}
              required
              copyable
              sensitive
            />
            <EditableField
              label="Meta Phone Number ID"
              value={phoneNumberId}
              onChange={(value) => {
                setPhoneNumberId(value);
                setIsValidated(false);
                setValidationMessage("");
              }}
              required
              copyable
              sensitive
            />
            <EditableField
              label="Meta Business Account ID (WABA ID)"
              value={wabaId}
              onChange={(value) => {
                setWabaId(value);
                setIsValidated(false);
                setValidationMessage("");
              }}
              helper="Used for creating templates and sending messages"
              required
              copyable
              sensitive
            />
            <EditableField
              label="Meta App ID"
              value={appId}
              onChange={(value) => {
                setAppId(value);
                setIsValidated(false);
                setValidationMessage("");
              }}
              helper="Required for uploading media (images) for templates"
              required
              copyable
              sensitive
            />
          </div>

          <Button
            type="button"
            onClick={() => void handleValidate()}
            disabled={saving || isLoading}
            className="h-[56px] w-full rounded-[16px] bg-[linear-gradient(135deg,#171717,#171717)] text-[16px] font-bold text-white shadow-none hover:bg-[linear-gradient(135deg,#171717,#171717)]"
          >
            <CheckCircle2 className="mr-3 h-5 w-5" />
            {saving ? "Validating..." : "Validate Credentials"}
          </Button>

          {isValidated ? (
            <div className="rounded-[20px] border border-[#9be2ba] bg-[#effcf3] px-7 py-6">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#22c55e] text-white">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-[18px] font-bold text-[#166534]">Account Connected</h3>
                  <p className="mt-1.5 text-[14px] text-[#16803b]">
                    {validationMessage || `Credentials validated on ${validatedAt ? new Date(validatedAt).toLocaleDateString("en-GB") : "—"}`}
                  </p>
                </div>
              </div>
            </div>
          ) : validationMessage ? (
            <div className="rounded-[20px] border border-[#fecaca] bg-[#fef2f2] px-7 py-6">
              <div className="flex items-start gap-4">
                <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ef4444] text-white">
                  <Info className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-[18px] font-bold text-[#b42318]">Validation failed</h3>
                  <p className="mt-1.5 text-[14px] text-[#b42318]">{validationMessage}</p>
                </div>
              </div>
            </div>
          ) : null}

          <InfoPanel title="Where to find these credentials:" items={credentialSteps} />
        </section>

        <section className="space-y-8 rounded-[28px] border border-[#e5eaf2] bg-white p-10 shadow-sm">
          <div>
            <h2 className="text-[22px] font-bold tracking-tight">Webhook Configuration</h2>
            <p className="mt-3 text-[16px] leading-7 text-[#5b6678]">
              Use this unique webhook URL to receive WhatsApp events from Meta.
            </p>
          </div>

          <ReadonlyField
            label="Your Webhook URL"
            value={isLoading ? "" : webhookUrl}
            helper="This URL is permanent and unique to your account. Configure it in Meta Business Manager."
            copyable
            sensitive
          />

          <ReadonlyField
            label="Webhook Verify Token"
            value={isLoading ? "" : verifyToken}
            helper="Use this token when configuring webhooks in Meta Business Manager."
            copyable
            sensitive
          />

          <InfoPanel title="Setup Instructions:" items={webhookSteps} />
        </section>
      </div>
    </Shell>
  );
}
