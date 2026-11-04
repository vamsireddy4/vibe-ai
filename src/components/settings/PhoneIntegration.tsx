import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getVibeSpaceFromPath } from "@/lib/vibe-routes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Phone, Trash2, Settings, Eye, EyeOff, CheckCircle2, Pencil, MoreHorizontal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PHONE_PROVIDER_META } from "@/lib/provider-logos";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "react-router-dom";

interface PhoneConfig {
  id: string;
  user_id: string;
  provider: string;
  channel: "voice" | "sms";
  phone_number: string;
  inbound_agent_id: string | null;
  twilio_account_sid: string | null;
  twilio_auth_token: string | null;
  telnyx_api_key: string | null;
  telnyx_connection_id: string | null;
  telnyx_public_key: string | null;
  telnyx_messaging_profile_id: string | null;
  sms_sender_type: "phone_number" | "alpha_sender" | null;
  telnyx_alpha_sender_id: string | null;
  telnyx_dlt_entity_id: string | null;
  telnyx_dlt_template_id: string | null;
  friendly_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  is_active: boolean;
}

const PROVIDERS = [
  {
    id: "twilio",
    name: PHONE_PROVIDER_META.twilio.name,
    logo: PHONE_PROVIDER_META.twilio.logo,
    description: "Industry-standard cloud communications platform for voice calls.",
    fields: [
      { key: "twilio_account_sid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", type: "text", help: "Find this in your Twilio Console dashboard." },
      { key: "twilio_auth_token", label: "Auth Token", placeholder: "Your Twilio auth token", type: "password", help: "Your auth token is also in the Twilio Console." },
      { key: "phone_number", label: "Phone Number", placeholder: "+15551234567", type: "text", help: "Your Twilio phone number in E.164 format." },
    ],
  },
  {
    id: "telnyx",
    name: PHONE_PROVIDER_META.telnyx.name,
    logo: PHONE_PROVIDER_META.telnyx.logo,
    description: "Global carrier-grade voice platform with competitive pricing.",
    fields: [
      { key: "telnyx_api_key", label: "API Key", placeholder: "KEY...", type: "password", help: "Find your API key in the Telnyx Mission Control Portal under Auth." },
      { key: "telnyx_connection_id", label: "Connection ID", placeholder: "123456789...", type: "text", help: "The SIP Connection ID from Telnyx Mission Control → SIP Connections." },
      { key: "telnyx_public_key", label: "Public Key", placeholder: "Leave empty: fetched automatically from your API key", type: "text", help: "Optional. Filled in from your Telnyx account when you connect.", voiceOnly: true },
      {
        key: "sms_sender_type",
        label: "SMS Sender Type",
        type: "select",
        help: "Choose whether SMS should be sent from a phone number or an alphanumeric sender ID.",
        smsOnly: true,
        options: [
          { value: "phone_number", label: "Phone Number" },
          { value: "alpha_sender", label: "Alpha Sender" },
        ],
      },
      { key: "phone_number", label: "Phone Number", placeholder: "+15551234567", type: "text", help: "Your Telnyx phone number in E.164 format.", phoneNumberOnly: true },
      { key: "telnyx_messaging_profile_id", label: "Messaging Profile ID", placeholder: "4001xxxxxxxx", type: "text", help: "Required for Telnyx alphanumeric sender delivery.", smsOnly: true, alphaOnly: true },
      { key: "telnyx_alpha_sender_id", label: "Alpha Sender ID", placeholder: "VIBEAI", type: "text", help: "Your approved alphanumeric sender ID.", smsOnly: true, alphaOnly: true },
    ],
  },
];

/** Phone integration content. Used by the Phone Integration page and the account window (embedded: no page title). */
export default function PhoneIntegration({ embedded = false }: { embedded?: boolean }) {
  const location = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [configs, setConfigs] = useState<PhoneConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [replaceSavedCredentials, setReplaceSavedCredentials] = useState(false);
  const [editingConfig, setEditingConfig] = useState<PhoneConfig | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [inboundDialogOpen, setInboundDialogOpen] = useState(false);
  const [editingInboundConfig, setEditingInboundConfig] = useState<PhoneConfig | null>(null);
  const [selectedInboundAgentId, setSelectedInboundAgentId] = useState<string>("");
  const [savingInbound, setSavingInbound] = useState(false);
  const rawSpace = getVibeSpaceFromPath(location.pathname);
  const phoneChannel: "voice" | "sms" = rawSpace === "sms" ? "sms" : "voice";
  const isLocalDashboard = false; // ponytail: local /api/local + edge-function data path needs undeployed functions; read the DB directly

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

  const getSavedProviderCredentials = (providerId: string, channel: "voice" | "sms") => {
    const existingConfigs = configs.filter((config) => config.provider === providerId && config.channel === channel);
    if (existingConfigs.length === 0) return null;

    if (providerId === "twilio") {
      const existing = existingConfigs.find((config) => config.twilio_account_sid && config.twilio_auth_token);
      if (!existing) return null;
      return {
        twilio_account_sid: existing.twilio_account_sid || "",
        twilio_auth_token: existing.twilio_auth_token || "",
      };
    }

    if (providerId === "telnyx") {
      const existing = existingConfigs.find((config) => config.telnyx_api_key && config.telnyx_connection_id);
      if (!existing) return null;
      return {
        telnyx_api_key: existing.telnyx_api_key || "",
        telnyx_connection_id: existing.telnyx_connection_id || "",
        telnyx_public_key: existing.telnyx_public_key || "",
        telnyx_messaging_profile_id: existing.telnyx_messaging_profile_id || "",
        sms_sender_type: existing.sms_sender_type || "phone_number",
        telnyx_alpha_sender_id: existing.telnyx_alpha_sender_id || "",
        phone_number: existing.phone_number || "",
      };
    }

    return null;
  };

  const fetchConfigs = async () => {
    if (!user) return;

    if (isLocalDashboard) {
      const payload = await invokeAuthedFunction<any>("phone-config-data", {
        userId: user.id,
        userEmail: user.email || "",
      });
      setConfigs(Array.isArray(payload?.phoneConfigs) ? payload.phoneConfigs : []);
      setAgents(Array.isArray(payload?.agents) ? payload.agents : []);
      setLoading(false);
      return;
    }

    const [{ data }, { data: agentRows }] = await Promise.all([
      supabase.from("phone_configs").select("*").order("created_at", { ascending: false }),
      supabase.from("agents").select("id, name, is_active").eq("is_active", true).order("name"),
    ]);
    const rows = (data as PhoneConfig[]) || [];
    setConfigs(rows);
    setAgents((agentRows as AgentRow[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchConfigs();
    const channel = supabase
      .channel('phone-configs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'phone_configs' }, () => fetchConfigs())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, isLocalDashboard]);

  const openConnectDialog = (providerId: string, config?: PhoneConfig) => {
    setSelectedProvider(providerId);
    setShowSecrets({});
    setReplaceSavedCredentials(false);
    if (config) {
      setEditingConfig(config);
      const formData: Record<string, string> = { phone_number: config.phone_number };
      if (providerId === "twilio") {
        formData.twilio_account_sid = config.twilio_account_sid || "";
        formData.twilio_auth_token = config.twilio_auth_token || "";
      } else if (providerId === "telnyx") {
        formData.telnyx_api_key = config.telnyx_api_key || "";
        formData.telnyx_connection_id = config.telnyx_connection_id || "";
        formData.telnyx_public_key = config.telnyx_public_key || "";
        formData.telnyx_messaging_profile_id = config.telnyx_messaging_profile_id || "";
        formData.sms_sender_type = config.sms_sender_type || "phone_number";
        formData.telnyx_alpha_sender_id = config.telnyx_alpha_sender_id || "";
      }
      setForm(formData);
    } else {
      setEditingConfig(null);
      setForm({ ...(getSavedProviderCredentials(providerId, phoneChannel) || {}) });
    }
    setDialogOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedProvider) return;
    setSaving(true);

    const data: Record<string, any> = {
      user_id: user.id,
      provider: selectedProvider,
      channel: phoneChannel,
      phone_number: form.phone_number,
    };

    const savedProviderCredentials = getSavedProviderCredentials(selectedProvider, phoneChannel);
    const shouldReplaceSavedCredentials = replaceSavedCredentials;
    const shouldSyncProviderCredentials = Boolean(
      shouldReplaceSavedCredentials ||
      editingConfig
    );

    if (selectedProvider === "twilio") {
      data.twilio_account_sid = form.twilio_account_sid || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.twilio_account_sid : null) || null;
      data.twilio_auth_token = form.twilio_auth_token || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.twilio_auth_token : null) || null;
    } else if (selectedProvider === "telnyx") {
      const senderMode =
        phoneChannel === "sms"
          ? (form.sms_sender_type || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.sms_sender_type : null) || "phone_number")
          : null;

      data.telnyx_api_key = form.telnyx_api_key || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_api_key : null) || null;
      data.telnyx_connection_id = form.telnyx_connection_id || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_connection_id : null) || null;
      data.telnyx_public_key = form.telnyx_public_key || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_public_key : null) || null;
      data.sms_sender_type = senderMode;
      data.telnyx_messaging_profile_id = senderMode === "alpha_sender"
        ? (form.telnyx_messaging_profile_id || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_messaging_profile_id : null) || null)
        : null;
      data.telnyx_alpha_sender_id = senderMode === "alpha_sender"
        ? (form.telnyx_alpha_sender_id || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_alpha_sender_id : null) || null)
        : null;
      data.telnyx_dlt_entity_id = null;
      data.telnyx_dlt_template_id = null;
      data.phone_number = senderMode === "alpha_sender"
        ? (form.telnyx_alpha_sender_id || (!shouldReplaceSavedCredentials ? savedProviderCredentials?.telnyx_alpha_sender_id : null) || form.phone_number || null)
        : form.phone_number;
    }

    if (selectedProvider === "twilio" && (!data.twilio_account_sid || !data.twilio_auth_token)) {
      setSaving(false);
      toast({ title: "Missing credentials", description: "Save your Twilio Account SID and Auth Token once before adding more numbers.", variant: "destructive" });
      return;
    }

    if (selectedProvider === "telnyx" && (!data.telnyx_api_key || !data.telnyx_connection_id)) {
      setSaving(false);
      toast({ title: "Missing credentials", description: "Save your Telnyx API key and Connection ID once before adding more numbers.", variant: "destructive" });
      return;
    }

    // Public key (verifies Telnyx webhook signatures) comes from the account itself; fetch it with the API key.
    if (selectedProvider === "telnyx" && !data.telnyx_public_key) {
      try {
        const res = await fetch("https://api.telnyx.com/v2/public_key", { headers: { Authorization: `Bearer ${data.telnyx_api_key}` } });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.errors?.[0]?.detail || `HTTP ${res.status}`);
        data.telnyx_public_key = body?.data?.public || null; // {data: {public, record_type, organization_id}}
        if (!data.telnyx_public_key) throw new Error("No public key in Telnyx response");
      } catch (err) {
        setSaving(false);
        toast({ title: "Could not fetch Telnyx public key", description: `${(err as Error).message}. Check the API key, or paste the public key manually.`, variant: "destructive" });
        return;
      }
    }

    if (selectedProvider === "telnyx" && phoneChannel === "sms") {
      if (data.sms_sender_type === "phone_number" && !data.phone_number) {
        setSaving(false);
        toast({ title: "Missing sender", description: "Phone Number is required for phone-number SMS sending.", variant: "destructive" });
        return;
      }

      if (data.sms_sender_type === "alpha_sender" && (!data.telnyx_messaging_profile_id || !data.telnyx_alpha_sender_id)) {
        setSaving(false);
        toast({ title: "Missing sender", description: "Messaging Profile ID and Alpha Sender ID are required for alphanumeric SMS sending.", variant: "destructive" });
        return;
      }
    }

    try {
      if (shouldSyncProviderCredentials) {
        // New credentials apply to every number of this provider on the account (RLS: only the user's own rows).
        const creds =
          selectedProvider === "twilio"
            ? { twilio_account_sid: data.twilio_account_sid?.trim() || null, twilio_auth_token: data.twilio_auth_token?.trim() || null }
            : { telnyx_api_key: data.telnyx_api_key?.trim() || null, telnyx_connection_id: data.telnyx_connection_id?.trim() || null, telnyx_public_key: data.telnyx_public_key?.trim() || null };
        const { error } = await supabase
          .from("phone_configs")
          .update(creds as any)
          .eq("user_id", user.id)
          .eq("provider", selectedProvider)
          .eq("channel", phoneChannel);
        if (error) throw error;
      }

      let error;
      if (editingConfig) {
        ({ error } = await supabase.from("phone_configs").update(data as any).eq("id", editingConfig.id));
      } else if (data.phone_number) {
        ({ error } = await supabase.from("phone_configs").insert(data as any));
      }
      if (error) throw error;
      setSaving(false);
      const provider = PROVIDERS.find(p => p.id === selectedProvider);
      toast({
        title: editingConfig ? `${provider?.name} config updated` : `${provider?.name} phone number added successfully`,
        description: data.phone_number
          ? `${data.phone_number} is now using the latest saved ${provider?.name} credentials.`
          : undefined,
      });
      setDialogOpen(false);
      setSelectedProvider(null);
      setEditingConfig(null);
      setReplaceSavedCredentials(false);
      setForm({});
      fetchConfigs();
    } catch (error: any) {
      setSaving(false);
      toast({ title: "Error", description: error?.message || "Failed to save phone configuration", variant: "destructive" });
    }
  };

  const deleteConfig = async (id: string) => {
    if (isLocalDashboard) {
      await invokeAuthedFunction("phone-config-manage", { action: "delete", id });
    } else {
      await Promise.all([
        supabase.from("campaign_phone_configs").delete().eq("phone_config_id", id),
        supabase.from("campaigns").update({ phone_config_id: null } as any).eq("phone_config_id", id),
        supabase.from("agents").update({ phone_number_id: null } as any).eq("phone_number_id", id),
      ]);
      await supabase.from("phone_configs").delete().eq("id", id);
    }
    toast({ title: "Configuration deleted" });
    fetchConfigs();
  };

  const toggleActive = async (id: string, current: boolean) => {
    if (isLocalDashboard) {
      await invokeAuthedFunction("phone-config-manage", { action: "toggleActive", id, isActive: !current });
    } else {
      await supabase.from("phone_configs").update({ is_active: !current } as any).eq("id", id);
    }
    fetchConfigs();
  };

  const currentProviderConfig = PROVIDERS.find(p => p.id === selectedProvider);
  const currentProviderFields = currentProviderConfig?.fields.filter((field) => {
    if ((field as any).smsOnly) return selectedProvider === "telnyx" && phoneChannel === "sms";
    if ((field as any).voiceOnly) return phoneChannel !== "sms";
    if ((field as any).alphaOnly) return form.sms_sender_type === "alpha_sender";
    if ((field as any).phoneNumberOnly) return phoneChannel !== "sms" || form.sms_sender_type !== "alpha_sender";
    return true;
  });
  const savedCredentials = selectedProvider ? getSavedProviderCredentials(selectedProvider, phoneChannel) : null;
  const reusingSavedCredentials = Boolean(savedCredentials && !editingConfig && !replaceSavedCredentials);
  const getAgentName = (agentId: string | null) =>
    agentId ? agents.find((agent) => agent.id === agentId)?.name || "Unknown agent" : null;
  const visibleConfigs = phoneChannel === "sms"
    ? configs.filter((config) => config.provider === "telnyx" && config.channel === "sms")
    : configs.filter((config) => config.channel !== "sms");
  const visibleProviders = phoneChannel === "sms"
    ? PROVIDERS.filter((provider) => provider.id === "telnyx")
    : PROVIDERS;

  const openInboundDialog = (config: PhoneConfig) => {
    setEditingInboundConfig(config);
    setSelectedInboundAgentId(config.inbound_agent_id || "");
    setInboundDialogOpen(true);
  };

  const saveInboundAgent = async () => {
    if (!editingInboundConfig) return;
    setSavingInbound(true);
    try {
      if (isLocalDashboard) {
        await invokeAuthedFunction("phone-config-manage", {
          action: "setInboundAgent",
          id: editingInboundConfig.id,
          inboundAgentId: selectedInboundAgentId || "",
        });
      } else {
        const { error } = await supabase
          .from("phone_configs")
          .update({ inbound_agent_id: selectedInboundAgentId || null } as any)
          .eq("id", editingInboundConfig.id);
        if (error) throw error;
      }
      setSavingInbound(false);
    } catch (error: any) {
      setSavingInbound(false);
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }

    toast({
      title: selectedInboundAgentId ? "Inbound bot updated" : "Inbound bot removed",
      description: selectedInboundAgentId
        ? `${getAgentName(selectedInboundAgentId) || "Selected agent"} will answer calls to ${editingInboundConfig.phone_number}.`
        : "This number will no longer route to a dedicated inbound bot.",
    });
    setInboundDialogOpen(false);
    setEditingInboundConfig(null);
    setSelectedInboundAgentId("");
    fetchConfigs();
  };

  return (
      <div className="space-y-6 animate-rise-in">
        {!embedded && <div>
          <h1 className="text-3xl font-bold tracking-tight">{phoneChannel === "sms" ? "SMS Configuration" : "Phone Configuration"}</h1>
          <p className="mt-1 text-muted-foreground">
            {phoneChannel === "sms"
              ? "Connect your messaging provider and sender setup for SMS campaigns."
              : "Connect your telephony provider to enable inbound and outbound voice calls."}
          </p>
        </div>}

        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <Card key={i} className="animate-pulse"><CardContent className="p-6 h-20" /></Card>
            ))}
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={phoneChannel}
              initial={{ y: 8 }}
              animate={{ y: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="space-y-6"
            >
              {/* Connected numbers */}
              {visibleConfigs.length > 0 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold">Connected Numbers</h2>
                  {visibleConfigs.map((config) => {
                    const provider = PROVIDERS.find(p => p.id === config.provider);
                    return (
                      <Card key={config.id}>
                        <CardContent className="flex items-center justify-between p-4">
                          <div className="flex items-center gap-3">
                            <img src={provider?.logo} alt={provider?.name} className="h-8 w-8 rounded object-contain" />
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-medium">{config.phone_number}</p>
                                <Badge variant="outline" className="text-xs">{provider?.name}</Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {config.provider === "twilio" && config.twilio_account_sid
                                  ? `SID: ${config.twilio_account_sid.slice(0, 8)}...`
                                  : config.provider === "telnyx" && config.telnyx_connection_id
                                  ? `Connection: ${config.telnyx_connection_id.slice(0, 8)}...`
                                  : ""}
                              </p>
                              {config.inbound_agent_id && (
                                <p className="text-xs text-muted-foreground">
                                  Inbound bot: {getAgentName(config.inbound_agent_id)}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="Open phone actions">
                                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem onClick={() => toggleActive(config.id, config.is_active)}>
                                  <Badge variant={config.is_active ? "default" : "secondary"} className="mr-2">
                                    {config.is_active ? "Active" : "Inactive"}
                                  </Badge>
                                  {config.is_active ? "Mark Inactive" : "Mark Active"}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => openConnectDialog(config.provider, config)}>
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => openInboundDialog(config)}>
                                  <Settings className="mr-2 h-4 w-4" />
                                  Settings
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => deleteConfig(config.id)} className="text-destructive focus:text-destructive">
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Provider cards */}
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">Available Providers</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {visibleProviders.map((provider) => (
                    <Card key={provider.id}>
                      <CardHeader className="pb-3">
                        <div className="flex items-center gap-3">
                          <img src={provider.logo} alt={provider.name} className="h-10 w-10 rounded object-contain" />
                          <CardTitle className="text-base">{provider.name}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground mb-4">{provider.description}</p>
                        <Button className="w-full" onClick={() => openConnectDialog(provider.id)}>
                          Add {provider.name} Number
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        )}

        {/* Connect dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {currentProviderConfig && <img src={currentProviderConfig.logo} alt={currentProviderConfig.name} className="h-6 w-6 rounded object-contain" />}
                {editingConfig ? "Edit" : "Connect"} {currentProviderConfig?.name}
              </DialogTitle>
              <DialogDescription>
                {reusingSavedCredentials
                  ? `Using your saved ${currentProviderConfig?.name} ${phoneChannel.toUpperCase()} credentials. Enter a phone number to connect another line.`
                  : editingConfig
                  ? `Update the selected phone number and, if needed, replace the saved ${currentProviderConfig?.name} credentials used for ${phoneChannel === "sms" ? "SMS" : "voice calls"}.`
                  : `Enter your ${currentProviderConfig?.name} credentials to enable ${phoneChannel === "sms" ? "SMS" : "voice calls"}.`}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              {reusingSavedCredentials && (
                <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Saved provider credentials found for this {phoneChannel === "sms" ? "SMS" : "Voice"} configuration. You only need to enter the new phone number.
                </div>
              )}
              {editingConfig && !["twilio", "telnyx"].includes(selectedProvider || "") && (
                <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Editing phone number: <span className="font-medium text-foreground">{editingConfig.phone_number}</span>
                </div>
              )}
              {savedCredentials && !["twilio", "telnyx"].includes(selectedProvider || "") && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReplaceSavedCredentials((current) => !current)}
                >
                  {replaceSavedCredentials
                    ? "Reuse Saved Credentials Instead"
                    : editingConfig
                    ? "Replace Saved Credentials For This Provider"
                    : "Replace Saved Credentials"}
                </Button>
              )}
              {currentProviderFields?.map((field) => (
                reusingSavedCredentials && field.key !== "phone_number" ? null : (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  {field.type === "password" ? (
                    <div className="relative">
                      <Input
                        id={field.key}
                        type={showSecrets[field.key] ? "text" : "password"}
                        value={form[field.key] || ""}
                        onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                        placeholder={field.placeholder}
                        required={replaceSavedCredentials || !reusingSavedCredentials}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                        onClick={() => setShowSecrets({ ...showSecrets, [field.key]: !showSecrets[field.key] })}
                      >
                        {showSecrets[field.key] ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                      </Button>
                    </div>
                  ) : field.type === "select" ? (
                    <select
                      id={field.key}
                      value={form[field.key] || "phone_number"}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      required={replaceSavedCredentials || !reusingSavedCredentials}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {((field as any).options || []).map((option: { value: string; label: string }) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={field.key}
                      value={form[field.key] || ""}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      required={field.key === "telnyx_public_key" ? false : field.key === "phone_number" ? (!replaceSavedCredentials || Boolean(form.phone_number)) : (replaceSavedCredentials || !reusingSavedCredentials)}
                    />
                  )}
                  <p className="text-xs text-muted-foreground">{field.help}</p>
                </div>
                )
              ))}
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? "Saving..." : editingConfig ? `Update ${currentProviderConfig?.name}` : `Connect ${currentProviderConfig?.name}`}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog
          open={inboundDialogOpen}
          onOpenChange={(open) => {
            setInboundDialogOpen(open);
            if (!open) {
              setEditingInboundConfig(null);
              setSelectedInboundAgentId("");
            }
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Edit Inbound</DialogTitle>
              <DialogDescription>
                Choose which AI agent should answer inbound calls for {editingInboundConfig?.phone_number || "this number"}.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Inbound Agent</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={selectedInboundAgentId}
                  onChange={(e) => setSelectedInboundAgentId(e.target.value)}
                >
                  <option value="">No dedicated inbound bot</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3">
                <Button onClick={saveInboundAgent} disabled={savingInbound}>
                  {savingInbound ? "Saving..." : "Save Inbound"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setInboundDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
  );
}
