import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getVibePath } from "@/lib/vibe-routes";
import { supabase } from "@/integrations/supabase/client";
import { APP_LABELS, connectedWorkspaceApps } from "@/lib/connected-apps";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, Plus, Save, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

interface Props {
  agentId: string;
  userId: string;
  userEmail?: string;
}

type EmailTemplateConfig = {
  to: string;
  subject: string;
  body: string;
};

type ConnectedProvider = {
  id: string;
  provider: string;
  display_name: string | null;
};

const PLACEHOLDER_PATTERN = /<<\s*([^>]+?)\s*>>/g;
const DEFAULT_TEMPLATE: EmailTemplateConfig = {
  to: "<<email>>",
  subject: "",
  body: "",
};

const GMAIL_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48" fill="none">
      <path d="M7 11.5 32 31l25-19.5" fill="#EA4335"/>
      <path d="M7 11.5v25h10.5V21.8L32 33l14.5-11.2v14.7H57v-25l-7.8 6.1L32 31 14.8 17.6 7 11.5Z" fill="#34A853"/>
      <path d="M7 11.5 17.5 19.7v16.8H7v-25Z" fill="#4285F4"/>
      <path d="M57 11.5 46.5 19.7v16.8H57v-25Z" fill="#FBBC04"/>
    </svg>
  `);

const GOOGLE_DOCS_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M18 8h20l12 12v36H18a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z" fill="#4285F4"/>
      <path d="M38 8v14h14" fill="#AECBFA"/>
      <path d="M23 28h18M23 36h18M23 44h14" stroke="white" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `);

const GOOGLE_SHEETS_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M18 8h20l12 12v36H18a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z" fill="#34A853"/>
      <path d="M38 8v14h14" fill="#8FD19E"/>
      <path d="M23 28h16M23 36h18M23 44h18M31 22v28" stroke="white" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `);

const PROVIDER_META: Record<string, { label: string; logo: string | null }> = {
  gmail: { label: "Email", logo: GMAIL_LOGO },
  google_docs: { label: "Google Docs", logo: GOOGLE_DOCS_LOGO },
  google_sheets: { label: "Google Sheets", logo: GOOGLE_SHEETS_LOGO },
};

const parseTemplateConfig = (value: string | null | undefined): EmailTemplateConfig => {
  if (!value) return DEFAULT_TEMPLATE;

  try {
    const parsed = JSON.parse(value) as Partial<EmailTemplateConfig>;
    return {
      to: typeof parsed.to === "string" && parsed.to.trim() ? parsed.to : DEFAULT_TEMPLATE.to,
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return {
      ...DEFAULT_TEMPLATE,
      body: value,
    };
  }
};

const serializeTemplateConfig = (value: EmailTemplateConfig) =>
  JSON.stringify({
    to: value.to.trim() || DEFAULT_TEMPLATE.to,
    subject: value.subject,
    body: value.body,
  });

export default function AgentBodyTemplate({ agentId, userId, userEmail = "" }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const isLocalDashboard = typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProvider[]>([]);
  const [templateConfig, setTemplateConfig] = useState<EmailTemplateConfig>(DEFAULT_TEMPLATE);
  const [savedTemplate, setSavedTemplate] = useState(serializeTemplateConfig(DEFAULT_TEMPLATE));
  const [isOpen, setIsOpen] = useState(true);
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  const invokeAuthedFunction = async <T,>(functionName: string, body: Record<string, unknown>) => {
    const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
    });
    if (error) throw error;
    return (data ?? {}) as T;
  };

  const persistProviders = async (providerIds: string[]) => {
    if (isLocalDashboard) {
      try {
        await invokeAuthedFunction("agent-crm-data", {
          action: "updateProviders",
          agentId,
          userId,
          userEmail,
          providerIds,
        });
      } catch (error: any) {
        toast({
          title: "Could not update Custom CRM",
          description: error?.message || "Failed to update CRM providers",
          variant: "destructive",
        });
        return false;
      }
      return true;
    }

    const { error } = await supabase
      .from("agents")
      .update({
        custom_crm_providers: providerIds,
        use_google_docs: providerIds.includes("google_docs"),
      } as never)
      .eq("id", agentId);

    if (error) {
      toast({
        title: "Could not update Custom CRM",
        description: error.message,
        variant: "destructive",
      });
      return false;
    }

    return true;
  };

  const fetchData = async () => {
    setLoading(true);
    let agentData: any = null;
    let integrationsData: ConnectedProvider[] = [];

    if (isLocalDashboard) {
      const payload = await invokeAuthedFunction<any>("agent-crm-data", {
          action: "load",
          agentId,
          userId,
          userEmail,
      });
      agentData = payload?.agent || null;
      integrationsData = Array.isArray(payload?.integrations) ? payload.integrations : [];
    } else {
      const [agentResponse, apps] = await Promise.all([
        supabase.from("agents").select("gmail_body_template, custom_crm_providers, use_google_docs").eq("id", agentId).maybeSingle(),
        connectedWorkspaceApps(userId), // older Google sign-in + every app connected in CRM Integrations
      ]);
      agentData = agentResponse.data || null;
      integrationsData = apps as ConnectedProvider[];
    }

    const providers = Array.isArray(integrationsData) ? integrationsData as ConnectedProvider[] : [];
    const parsedTemplate = parseTemplateConfig(
      typeof agentData?.gmail_body_template === "string" ? agentData.gmail_body_template : "",
    );

    setConnectedProviders(providers);
    setSavedTemplate(serializeTemplateConfig(parsedTemplate));
    setTemplateConfig(parsedTemplate);

    const connectedProviderIds = providers.map((provider) => provider.provider);
    const savedProviders = Array.isArray(agentData?.custom_crm_providers)
      ? agentData.custom_crm_providers.filter((value): value is string => typeof value === "string")
      : [];
    const filteredSavedProviders = savedProviders.filter((providerId) => connectedProviderIds.includes(providerId));
    // Only an agent that never had its list set gets Email by default (with a written template).
    // An empty list means the user removed everything: keep it empty ("to" always has <<email>>, so it can't decide).
    const neverSet = !Array.isArray(agentData?.custom_crm_providers);
    const fallbackProviders =
      neverSet && (parsedTemplate.body.trim() || parsedTemplate.subject.trim()) && connectedProviderIds.includes("gmail") ? ["gmail"] : [];
    const nextActiveProviders = filteredSavedProviders.length > 0 ? filteredSavedProviders : fallbackProviders;

    if (nextActiveProviders.includes("google_docs") && !agentData?.use_google_docs) {
      if (isLocalDashboard) {
        await invokeAuthedFunction("agent-crm-data", {
            action: "updateProviders",
            agentId,
            userId,
            userEmail,
            providerIds: nextActiveProviders,
          }).catch(() => undefined);
      } else {
        await supabase
          .from("agents")
          .update({ use_google_docs: true } as never)
          .eq("id", agentId);
      }
    }

    setActiveProviders(nextActiveProviders);
    setSelectedProvider((current) => {
      if (current && nextActiveProviders.includes(current)) return current;
      return nextActiveProviders[0] || null;
    });
    setLoading(false);
  };

  useEffect(() => {
    void fetchData();

    const channel = supabase
      .channel(`agent-custom-crm-${agentId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agents", filter: `id=eq.${agentId}` }, () => {
        void fetchData();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_integrations" }, () => {
        void fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [agentId, userId, userEmail, isLocalDashboard]);

  const placeholders = useMemo(() => {
    const combined = `${templateConfig.to}\n${templateConfig.subject}\n${templateConfig.body}`;
    const matches = combined.matchAll(PLACEHOLDER_PATTERN);
    return Array.from(new Set(Array.from(matches, (match) => match[1].trim()))).filter(Boolean);
  }, [templateConfig]);

  const serializedTemplate = useMemo(() => serializeTemplateConfig(templateConfig), [templateConfig]);
  const hasChanges = serializedTemplate !== savedTemplate;

  const availableToAdd = connectedProviders.filter((provider) => !activeProviders.includes(provider.provider));
  const selectedProviderMeta = selectedProvider ? (PROVIDER_META[selectedProvider] ?? { label: APP_LABELS[selectedProvider] ?? selectedProvider, logo: null }) : null;

  const handleSave = async () => {
    setSaving(true);
    const normalizedTemplate = serializeTemplateConfig(templateConfig);
    if (isLocalDashboard) {
      try {
        await invokeAuthedFunction("agent-crm-data", {
          action: "updateTemplate",
          agentId,
          userId,
          userEmail,
          gmail_body_template: normalizedTemplate,
        });
      } catch (error: any) {
        setSaving(false);
        toast({
          title: "Could not save email template",
          description: error?.message || "Failed to save template",
          variant: "destructive",
        });
        return;
      }
      setSaving(false);
    } else {
      const { error } = await supabase
        .from("agents")
        .update({ gmail_body_template: normalizedTemplate } as never)
        .eq("id", agentId);

      setSaving(false);

      if (error) {
        toast({
          title: "Could not save email template",
          description: error.message,
          variant: "destructive",
        });
        return;
      }
    }

    const nextValue = parseTemplateConfig(normalizedTemplate);
    setSavedTemplate(serializeTemplateConfig(nextValue));
    setTemplateConfig(nextValue);
    toast({ title: "Email template saved" });
  };

  const addProvider = async (providerId: string) => {
    const nextProviders = activeProviders.includes(providerId) ? activeProviders : [...activeProviders, providerId];
    const saved = await persistProviders(nextProviders);
    if (!saved) return;

    setActiveProviders(nextProviders);
    setSelectedProvider(providerId);
    setIsOpen(true);
  };

  const removeProvider = async (providerId: string) => {
    const nextProviders = activeProviders.filter((id) => id !== providerId);
    const saved = await persistProviders(nextProviders);
    if (!saved) return;

    setActiveProviders(nextProviders);
    setSelectedProvider((selected) => {
      if (selected !== providerId) return selected;
      return nextProviders[0] || null;
    });
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Custom CRM</CardTitle>
          <CardDescription>Add connected CRM actions for this agent.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            className="flex flex-1 items-start justify-between gap-4 text-left"
          >
            <div className="space-y-1">
              <CardTitle>Custom CRM</CardTitle>
              <p className="text-sm text-muted-foreground">
                Add connected CRM workflows for this agent. Select a connected tool to configure its behavior.
              </p>
            </div>
            <ChevronDown className={`mt-1 h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="Add CRM tool" title={availableToAdd.length ? "Add a connected tool" : "Every connected tool is already added. Connect more in CRM Integrations."} disabled={availableToAdd.length === 0}>
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {availableToAdd.length === 0 ? (
                <DropdownMenuItem disabled>No more connected CRMs</DropdownMenuItem>
              ) : (
                availableToAdd.map((provider) => (
                  <DropdownMenuItem key={provider.id} onClick={() => addProvider(provider.provider)}>
                    {PROVIDER_META[provider.provider]?.label || APP_LABELS[provider.provider] || provider.display_name || provider.provider}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-4">
          {connectedProviders.length === 0 ? (
            <div className="rounded-xl border border-dashed p-5">
              <p className="text-sm text-muted-foreground">
                Connect a CRM integration first to add it here for this agent.
              </p>
              <Button className="mt-4" variant="outline" onClick={() => navigate(getVibePath("voice", "crm-integrations"))}>
                Open CRM Integrations
              </Button>
            </div>
          ) : (
            <>
              {activeProviders.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {activeProviders.map((providerId) => {
                    const meta = PROVIDER_META[providerId];
                    const isActive = providerId === selectedProvider;
                    return (
                      <Button
                        key={providerId}
                        type="button"
                        variant={isActive ? "default" : "outline"}
                        size="sm"
                        onClick={() => setSelectedProvider(providerId)}
                        className="gap-2 pr-2"
                      >
                        {meta?.label || APP_LABELS[providerId] || providerId}
                        <span
                          role="button"
                          tabIndex={0}
                          className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm opacity-80 transition-opacity hover:opacity-100"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeProvider(providerId);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              removeProvider(providerId);
                            }
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </Button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed p-5">
                  <p className="text-sm text-muted-foreground">
                    Click the <span className="font-medium text-foreground">+</span> button to add one of your connected CRM tools here.
                  </p>
                </div>
              )}

              {selectedProvider === "gmail" ? (
                <div className="space-y-4 rounded-xl border p-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">Email</p>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Configure the To, Subject, and Body used when you open Gmail from campaign outcomes.
                    </p>
                    <p className="text-sm text-muted-foreground">
                      This template is used when you click <span className="font-medium text-foreground">Open Email</span> in campaign outcomes.
                      Use placeholders like <code>&lt;&lt;name&gt;&gt;</code>, <code>&lt;&lt;email&gt;&gt;</code>, or any uploaded custom column such as <code>&lt;&lt;company&gt;&gt;</code>.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">To</p>
                    <Input
                      value={templateConfig.to}
                      onChange={(event) => setTemplateConfig((current) => ({ ...current, to: event.target.value }))}
                      placeholder="<<email>>"
                    />
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
                    <Input
                      value={templateConfig.subject}
                      onChange={(event) => setTemplateConfig((current) => ({ ...current, subject: event.target.value }))}
                      placeholder="Follow up for <<name>>"
                    />
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Body</p>
                    <Textarea
                      value={templateConfig.body}
                      onChange={(event) => setTemplateConfig((current) => ({ ...current, body: event.target.value }))}
                      rows={8}
                      placeholder={"Hi <<name>>,\n\nFollowing up on your campaign.\n\nEmail: <<email>>\nCompany: <<company>>"}
                    />
                  </div>

                  {placeholders.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Detected placeholders</p>
                      <div className="flex flex-wrap gap-2">
                        {placeholders.map((placeholder) => (
                          <Badge key={placeholder} variant="secondary">
                            {`<<${placeholder}>>`}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Placeholder matching is case-insensitive and supports names with spaces or underscores.
                    </p>
                    <Button onClick={handleSave} disabled={saving || !hasChanges}>
                      <Save className="mr-2 h-4 w-4" />
                      {saving ? "Saving..." : "Save Template"}
                    </Button>
                  </div>
                </div>
              ) : selectedProvider ? (
                <div className="rounded-xl border border-dashed p-5">
                  <p className="font-medium">{selectedProviderMeta?.label || selectedProvider}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    On calls, this agent can use {selectedProviderMeta?.label || selectedProvider} when a caller needs it, for example to look up
                    or save their details. It uses the account you connected in CRM Integrations, and starts with the next call.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
