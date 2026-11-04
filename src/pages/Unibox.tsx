import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Send, Loader2, Phone } from "lucide-react";
import { placeMetaTelnyxCall, runVoiceCampaign } from "@/lib/outbound-call";
import { localApi } from "@/lib/local-functions";
import { extractEdgeFunctionError } from "@/lib/edge-functions";
import { recordSingleEmail } from "@/lib/email-history";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
export default function Unibox() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [messageType, setMessageType] = useState("sms");
  const [phoneConfigs, setPhoneConfigs] = useState<Tables<"phone_configs">[]>([]);
  const [selectedFromNumber, setSelectedFromNumber] = useState<string>("+16183301932");

  // Gmail Account States
  const [gmailAccounts, setGmailAccounts] = useState<any[]>([]);
  const [selectedGmailAccount, setSelectedGmailAccount] = useState<string>("");
  const [composioGmail, setComposioGmail] = useState<string | null>(null); // Gmail connected in CRM Integrations
  const [subject, setSubject] = useState("");

  // Template and Sending State
  const [smsTemplates, setSmsTemplates] = useState<Tables<"sms_templates">[]>([]);
  const [gmailTemplates, setGmailTemplates] = useState<Tables<"gmail_templates">[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("none");
  const [messageText, setMessageText] = useState<string>("");
  const [toField, setToField] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);

  // Campaign Sending States
  const [toMode, setToMode] = useState<"individual" | "campaign">("individual");
  const [smsCampaigns, setSmsCampaigns] = useState<any[]>([]);
  const [gmailCampaigns, setGmailCampaigns] = useState<any[]>([]);
  const [whatsappCampaigns, setWhatsappCampaigns] = useState<any[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");

  // Voice: the agent places the call (individual) or runs a voice campaign.
  const [voiceAgents, setVoiceAgents] = useState<Tables<"agents">[]>([]);
  const [voiceCampaigns, setVoiceCampaigns] = useState<any[]>([]);
  const [voiceAgentId, setVoiceAgentId] = useState("");
  const isVoice = messageType === "voice";

  // Ask Vibe's compose_message task opens Front with the composer filled in (router state, not the URL);
  // the user still presses Send / Call.
  const location = useLocation();
  useEffect(() => {
    const c = (location.state as any)?.compose;
    if (!c) return;
    setMessageType(c.channel);
    setToMode("individual");
    setToField(c.to ?? "");
    setSubject(c.subject ?? "");
    setMessageText(c.message ?? "");
    if (c.agentId) setVoiceAgentId(c.agentId);
    window.history.replaceState({}, ""); // don't refill on reload
  }, [location.state]);
  const callNumbers = phoneConfigs.filter((pc) => pc.provider === "twilio" || pc.provider === "telnyx");
  useEffect(() => {
    if (isVoice && callNumbers.length && !callNumbers.some((pc) => pc.phone_number === selectedFromNumber)) setSelectedFromNumber(callNumbers[0].phone_number || "");
  }, [isVoice, phoneConfigs]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("phone_configs")
      .select("*")
      .eq("is_active", true)
      .then(({ data }) => {
        const configs = data || [];
        setPhoneConfigs(configs);
        if (configs.length > 0) {
          setSelectedFromNumber(configs[0].phone_number || "");
        }
      });

    supabase.from("agents").select("*").eq("is_active", true).then(({ data }) => {
      setVoiceAgents(data || []);
      if (data?.length) setVoiceAgentId((id) => id || data[0].id);
    });
    // Voice campaigns keep their name in venue_name (the Campaigns page shows it as the campaign name).
    supabase.from("campaigns").select("id, venue_name, total_contacts, agent_id").order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) console.error("voice campaigns", error.message);
        setVoiceCampaigns((data || []).map((c: any) => ({ ...c, name: c.venue_name || "Untitled campaign" })));
      });

    // Gmail connected through Composio (CRM Integrations) sends Front's emails.
    localApi<{ email: string | null }>("/api/local/composio", { action: "gmail_account" })
      .then(({ email }) => {
        if (!email) return;
        setComposioGmail(email);
        setGmailAccounts((cur) => (cur.some((a) => a.display_name === email) ? cur : [{ id: "composio-gmail", display_name: email }, ...cur]));
        setSelectedGmailAccount((cur) => cur || email);
      })
      .catch(() => undefined);

    // Fetch Gmail integrations
    supabase
      .from("calendar_integrations")
      .select("*")
      .eq("provider", "gmail")
      .eq("is_active", true)
      .then(({ data }) => {
        const accounts = data || [];
        setGmailAccounts((cur) => [...cur.filter((a) => a.id === "composio-gmail"), ...accounts]);
        if (accounts.length > 0) {
          setSelectedGmailAccount(accounts[0].display_name || "");
        }
      });

    // Fetch templates
    supabase
      .from("sms_templates")
      .select("*")
      .then(({ data }) => {
        const smsRows = data || [];
        setSmsTemplates(smsRows.filter(t => String(t.category || "").toLowerCase() !== "gmail:email"));
        
        // Load fallback Gmail templates saved inside sms_templates
        const gmailFallbackRows = smsRows.filter(t => String(t.category || "").toLowerCase() === "gmail:email");
        if (gmailFallbackRows.length > 0) {
          setGmailTemplates(current => {
            const merged = [...current];
            gmailFallbackRows.forEach(row => {
              if (!merged.some(m => m.id === row.id)) {
                merged.push({
                  ...row,
                  category: "gmail:email"
                } as any);
              }
            });
            return merged;
          });
        }
      });

    supabase
      .from("gmail_templates")
      .select("*")
      .then(({ data }) => {
        setGmailTemplates(current => {
          const merged = [...current];
          (data || []).forEach(row => {
            if (!merged.some(m => m.id === row.id)) {
              merged.push(row);
            }
          });
          return merged;
        });
      });

    // Fetch SMS Campaigns
    supabase
      .from("sms_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setSmsCampaigns(data || []);
      });

    // Fetch Gmail Campaigns
    supabase
      .from("gmail_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setGmailCampaigns(data || []);
      });

    // Fetch WhatsApp Campaigns (handling missing tables gracefully)
    supabase
      .from("whatsapp_campaigns" as any)
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!error) {
          setWhatsappCampaigns(data || []);
        } else {
          // try audience_campaigns as fallback
          supabase
            .from("audience_campaigns" as any)
            .select("*")
            .order("created_at", { ascending: false })
            .then(({ data: audData }) => {
              setWhatsappCampaigns(audData || []);
            });
        }
      });
  }, [user]);

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId || templateId === "none") {
      setMessageText("");
      return;
    }
    if (messageType === "email") {
      const template = gmailTemplates.find((t) => t.id === templateId);
      if (template) {
        try {
          const parsed = JSON.parse(template.message);
          setMessageText(parsed.body || template.message || "");
        } catch {
          setMessageText(template.message || "");
        }
      }
    } else {
      const template = smsTemplates.find((t) => t.id === templateId);
      if (template) {
        setMessageText(template.message || "");
      }
    }
  };

  const invokeWhatsappCampaignFunction = async (campaignId: string) => {
    const WHATSAPP_CAMPAIGN_FUNCTION_NAMES = ["send-campaign-messages", "run-whatsapp-campaign"] as const;
    let lastError: any = null;

    for (const functionName of WHATSAPP_CAMPAIGN_FUNCTION_NAMES) {
      try {
        const { data, error } = await supabase.functions.invoke(functionName, {
          body: { campaign_id: campaignId },
        });

        if (!error && data?.success !== false) {
          return { data, error: null };
        }
        lastError = data?.error || error;
      } catch (err) {
        lastError = err;
      }
    }
    return { data: null, error: lastError || new Error("Failed to start WhatsApp campaign") };
  };

  const placeVoice = async () => {
    if (!voiceAgentId) return toast({ title: "Agent required", description: "Pick the agent that will talk on the calls.", variant: "destructive" });
    if (toMode === "campaign") {
      if (!selectedCampaignId) return toast({ title: "Campaign required", description: "Pick a voice campaign to call.", variant: "destructive" });
    } else {
      if (!/^\+[1-9]\d{6,14}$/.test(toField.replace(/[^\d+]/g, ""))) return toast({ title: "Check the number", description: "Use the full number with country code, like +14155551234.", variant: "destructive" });
    }
    const number = callNumbers.find((pc) => pc.phone_number === selectedFromNumber) || callNumbers[0];
    if (!number) return toast({ title: "No calling number", description: "Add a Twilio or Telnyx number in Phone numbers first.", variant: "destructive" });
    setIsSending(true);
    try {
      if (toMode === "campaign") {
        const r: any = await runVoiceCampaign(selectedCampaignId, undefined, { agentId: voiceAgentId, from: number!.phone_number || undefined });
        toast({ title: "Campaign started", description: `Calling ${r?.queued ?? "the"} contacts one at a time.` });
      } else {
        await placeMetaTelnyxCall(voiceAgents.find((a) => a.id === voiceAgentId)!, number!, toField, user!.id);
        toast({ title: "Calling", description: `${toField} is being called from ${number!.phone_number}.` });
      }
      setToField("");
      setSelectedCampaignId("");
    } catch (err: any) {
      toast({ title: toMode === "campaign" ? "Couldn't start the campaign" : "Couldn't place the call", description: err.message, variant: "destructive" });
    } finally {
      setIsSending(false);
    }
  };

  const handleSendMessage = async () => {
    if (isVoice) return placeVoice();
    if (toMode === "individual") {
      if (!toField.trim()) {
        toast({
          title: "Recipient required",
          description: `Please enter a recipient ${messageType === "email" ? "email address" : "phone number"}.`,
          variant: "destructive",
        });
        return;
      }
    } else {
      if (!selectedCampaignId) {
        toast({
          title: "Campaign required",
          description: "Please select a campaign to send the message to.",
          variant: "destructive",
        });
        return;
      }
      if (selectedTemplateId === "none") {
        toast({
          title: "Template required",
          description: "Please select a template to run a campaign send.",
          variant: "destructive",
        });
        return;
      }
    }

    if (!messageText.trim()) {
      toast({
        title: "Message text required",
        description: "Please enter a message or choose a template to send.",
        variant: "destructive",
      });
      return;
    }

    setIsSending(true);
    try {
      if (toMode === "campaign") {
        const selectedCampaign = getFilteredCampaigns().find((c: any) => c.id === selectedCampaignId);
        const totalContacts = selectedCampaign?.total_contacts || 0;
        const indices = Array.from({ length: totalContacts }, (_, i) => i);

        if (messageType === "sms") {
          const activeConfig = phoneConfigs.find((pc) => pc.phone_number === selectedFromNumber) || phoneConfigs[0];
          const { error } = await supabase.functions.invoke("run-sms-campaign", {
            body: {
              campaign_id: selectedCampaignId,
              template_id: selectedTemplateId,
              phone_config_id: activeConfig?.id,
              selected_contact_indexes: indices,
            },
          });
          if (error) throw error;
        } else if (messageType === "whatsapp") {
          const { error } = await invokeWhatsappCampaignFunction(selectedCampaignId);
          if (error) throw error;
        } else if (messageType === "email") {
          const { error } = await supabase.functions.invoke("run-gmail-campaign", {
            body: {
              campaign_id: selectedCampaignId,
              template_id: selectedTemplateId,
              selected_contact_indexes: indices,
            },
          });
          if (error) throw error;
        }
      } else {
        if (messageType === "sms") {
          const activeConfig = phoneConfigs.find((pc) => pc.phone_number === selectedFromNumber) || phoneConfigs[0];
          const { error } = await supabase.functions.invoke("send-sms-message", {
            body: {
              phone_config_id: activeConfig?.id,
              recipient_number: toField,
              message: messageText,
            },
          });
          if (error) throw error;
        } else if (messageType === "whatsapp") {
          const { error } = await supabase.functions.invoke("send-whatsapp-direct-message", {
            body: {
              phoneNumber: toField,
              message: messageText,
            },
          });
          if (error) throw error;
        } else if (messageType === "email") {
          // Single email: send, then save it to History > Email (failures too, with the reason).
          const record = (ok: boolean, extra: { messageId?: string | null; error?: string | null }) =>
            recordSingleEmail({ userId: user!.id, userEmail: user?.email || "", from: selectedGmailAccount || user?.email || "", to: toField.trim(), subject: subject.trim(), body: messageText, ok, ...extra });
          try {
            if (composioGmail && selectedGmailAccount === composioGmail) {
              const r = await localApi<{ id?: string | null }>("/api/local/composio", { action: "gmail_send", to: toField.trim(), subject: subject.trim(), body: messageText });
              await record(true, { messageId: r?.id });
            } else {
              const { data, error } = await supabase.functions.invoke("run-gmail-campaign", {
                body: {
                  recipient_email: toField,
                  subject: subject.trim() || "Unibox Message",
                  message: messageText,
                  user_email: selectedGmailAccount || user?.email,
                },
              });
              if (error) throw error;
              await record(true, { messageId: (data as any)?.messageId });
            }
          } catch (sendError) {
            await record(false, { error: (await extractEdgeFunctionError(sendError)) || (sendError as Error)?.message || String(sendError) });
            throw sendError;
          }
        }
      }

      toast({
        title: "Message sent successfully!",
        description: toMode === "campaign" 
          ? `Campaign dispatch has been initiated successfully.`
          : `Your message has been delivered via ${messageType.toUpperCase()}.`,
      });
      setMessageText("");
      setSubject("");
      setSelectedTemplateId("none");
      setToField("");
      setSelectedCampaignId("");
    } catch (err: any) {
      console.error("Failed to send message via edge function", err);
      toast({
        title: "Failed to send message",
        description: (await extractEdgeFunctionError(err)) || err.message || "An unexpected error occurred while sending.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  const currentTemplates = messageType === "email" ? gmailTemplates : smsTemplates;
  
  const isGmailFallbackCampaign = (campaign: any) => {
    const contacts = Array.isArray(campaign.extracted_contacts) ? campaign.extracted_contacts : [];
    return contacts.some((contact: any) => {
      const metadata = contact?.metadata;
      return !!metadata && typeof metadata === "object" && metadata["__magicteams_channel"] === "gmail";
    });
  };

  const getFilteredCampaigns = () => {
    if (isVoice) return voiceCampaigns;
    if (messageType === "email") {
      const dedicated = gmailCampaigns || [];
      const fallbacks = (smsCampaigns || []).filter(isGmailFallbackCampaign);
      return [...dedicated, ...fallbacks];
    } else if (messageType === "whatsapp") {
      const wCampaigns = whatsappCampaigns.length > 0 ? whatsappCampaigns : smsCampaigns;
      return wCampaigns.filter((c: any) => !isGmailFallbackCampaign(c));
    } else {
      return (smsCampaigns || []).filter((c: any) => !isGmailFallbackCampaign(c));
    }
  };

  return (
    <DashboardLayout>
      <div className="flex h-full flex-col overflow-hidden bg-background p-4 lg:p-6 animate-rise-in gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Front</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Send an SMS, WhatsApp, email or call. Everything you send is in History.</p>
        </div>

        <div className="flex flex-1 overflow-hidden gap-4">
          {/* Main Content Area */}
          <div className="flex flex-1 flex-col rounded-xl border border-border bg-card overflow-hidden">
            {/* New conversation: Front is just the composer; sent messages are in History */}
            {(
              <div className="flex h-full flex-col relative animate-rise-in">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-border/50 py-4 px-6">
                  <div>
                    <h3 className="text-lg font-bold text-foreground">New conversation</h3>
                    <p className="text-sm text-muted-foreground">
                      Pick an existing contact or enter a phone or email to start fresh.
                    </p>
                  </div>
                </div>

                {/* Composition Area */}
                <div className="flex-1 p-4 flex flex-col justify-end">
                  <div className="rounded-xl border border-border bg-card shadow-sm w-full max-w-2xl mx-auto overflow-hidden focus-within:ring-1 focus-within:ring-primary/20 transition-all">
                    
                    {/* Top Bar: Channel & Sending Mode Select */}
                    <div className="p-2 border-b border-border/50 bg-card flex items-center justify-between">
                      <Select value={messageType} onValueChange={setMessageType}>
                        <SelectTrigger className="w-[120px] h-8 bg-card border-border/50 text-xs font-medium">
                          <SelectValue placeholder="Channel" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sms">SMS</SelectItem>
                          <SelectItem value="whatsapp">WhatsApp</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                          <SelectItem value="voice">Voice</SelectItem>
                        </SelectContent>
                      </Select>

                      {/* Toggle button */}
                      <div className="relative flex rounded-lg bg-card p-0.5 text-xs shrink-0 border border-border/50 h-8 items-center w-[170px]">
                        {/* Sliding pill indicator */}
                        <div
                          className={cn(
                            "absolute top-0.5 bottom-0.5 rounded-[5px] bg-muted shadow-sm transition-all duration-300 ease-out",
                            toMode === "individual"
                              ? "left-0.5 w-[calc(50%-2px)]"
                              : "left-[calc(50%+1px)] w-[calc(50%-2px)]"
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => setToMode("individual")}
                          className={cn(
                            "relative z-10 w-1/2 h-full flex items-center justify-center font-medium transition-colors duration-200 text-xs rounded-[5px]",
                            toMode === "individual" ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          Individual
                        </button>
                        <button
                          type="button"
                          onClick={() => setToMode("campaign")}
                          className={cn(
                            "relative z-10 w-1/2 h-full flex items-center justify-center font-medium transition-colors duration-200 text-xs rounded-[5px]",
                            toMode === "campaign" ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          Campaign
                        </button>
                      </div>
                    </div>

                    {/* Agent Field (voice): who talks on the call(s); a campaign preselects its own agent */}
                    {isVoice && (
                      <div className="flex items-center px-4 py-2 border-b border-border/50 text-sm">
                        <span className="w-16 text-muted-foreground font-medium">Agent</span>
                        {voiceAgents.length > 0 ? (
                          <Select value={voiceAgentId} onValueChange={setVoiceAgentId}>
                            <SelectTrigger className="h-7 w-fit bg-card border-none text-foreground font-medium p-0 focus:ring-0 gap-1.5 shadow-none hover:bg-muted/40 px-2 rounded">
                              <SelectValue placeholder="Select an agent" />
                            </SelectTrigger>
                            <SelectContent>
                              {voiceAgents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-muted-foreground text-xs italic px-2">No active agents. Create one in Agents.</span>
                        )}
                      </div>
                    )}

                    {/* Template Field */}
                    {!isVoice && <div className="flex items-center px-4 py-2 border-b border-border/50 text-sm">
                      <span className="w-16 text-muted-foreground font-medium">Template</span>
                      <Select value={selectedTemplateId} onValueChange={handleTemplateChange}>
                        <SelectTrigger className="h-7 w-fit bg-card border-none text-foreground font-medium p-0 focus:ring-0 gap-1.5 shadow-none hover:bg-muted/40 px-2 rounded">
                          <SelectValue placeholder="Select a template" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None (Custom Message)</SelectItem>
                          {currentTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>}

                    {/* From Field */}
                    <div className="flex items-center px-4 py-2 border-b border-border/50 text-sm">
                      <span className="w-16 text-muted-foreground font-medium">From</span>
                      {messageType === "email" ? (
                        gmailAccounts.length > 0 ? (
                          <Select value={selectedGmailAccount} onValueChange={setSelectedGmailAccount}>
                            <SelectTrigger className="h-7 w-fit bg-card border-none text-foreground font-medium p-0 focus:ring-0 gap-1.5 shadow-none hover:bg-muted/40 px-2 rounded">
                              <SelectValue placeholder="Select an email" />
                            </SelectTrigger>
                            <SelectContent>
                              {gmailAccounts.map((account) => (
                                <SelectItem key={account.id} value={account.display_name || ""}>
                                  {account.display_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-muted-foreground text-xs italic px-2">No connected Gmail accounts found</span>
                        )
                      ) : (isVoice ? callNumbers : phoneConfigs).length > 0 ? (
                        <Select value={selectedFromNumber} onValueChange={setSelectedFromNumber}>
                          <SelectTrigger className="h-7 w-fit bg-card border-none text-foreground font-medium p-0 focus:ring-0 gap-1.5 shadow-none hover:bg-muted/40 px-2 rounded">
                            <SelectValue placeholder="Select a number" />
                          </SelectTrigger>
                          <SelectContent>
                            {(isVoice ? callNumbers : phoneConfigs).map((pc) => (
                              <SelectItem key={pc.id} value={pc.phone_number || ""}>
                                {pc.phone_number} {pc.friendly_name ? `(${pc.friendly_name})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : isVoice ? (
                        <span className="text-muted-foreground text-xs italic px-2">No Twilio or Telnyx number. Add one in Phone numbers.</span>
                      ) : (
                        <span className="text-foreground font-medium">+16183301932</span>
                      )}
                    </div>

                    {/* To Field */}
                    <div className="flex items-center px-4 py-2 border-b border-border/50 text-sm h-11 relative overflow-hidden">
                      <span className="w-16 text-muted-foreground font-medium shrink-0">To</span>
                      
                      <div className="relative flex-1 h-full flex items-center">
                        {/* Individual Mode view */}
                        <div
                          className={cn(
                            "absolute inset-0 flex items-center gap-2 transition-all duration-300 ease-in-out",
                            toMode === "individual"
                              ? "opacity-100 translate-x-0 pointer-events-auto"
                              : "opacity-0 -translate-x-4 pointer-events-none"
                          )}
                        >
                          <Search className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                          <input
                            type="text"
                            value={toField}
                            onChange={(e) => setToField(e.target.value)}
                            aria-label="Recipient"
                            placeholder={messageType === "email" ? "Search contacts, or type an email address" : "Search contacts, or type a phone (+14155551234)"}
                            className="flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground/60 focus:ring-0 text-sm py-0.5"
                          />
                        </div>

                        {/* Campaign Mode view */}
                        <div
                          className={cn(
                            "absolute inset-0 flex items-center transition-all duration-300 ease-in-out",
                            toMode === "campaign"
                              ? "opacity-100 translate-x-0 pointer-events-auto"
                              : "opacity-0 translate-x-4 pointer-events-none"
                          )}
                        >
                          {getFilteredCampaigns().length > 0 ? (
                            <Select
                              value={selectedCampaignId}
                              onValueChange={(id) => {
                                setSelectedCampaignId(id);
                                const own = voiceCampaigns.find((c) => c.id === id)?.agent_id;
                                if (isVoice && own && voiceAgents.some((a) => a.id === own)) setVoiceAgentId(own);
                              }}
                            >
                              <SelectTrigger className="h-7 w-full bg-card border-none text-foreground font-medium p-0 focus:ring-0 gap-1.5 shadow-none hover:bg-muted/40 px-2 rounded">
                                <SelectValue placeholder="Select a campaign to send to" />
                              </SelectTrigger>
                              <SelectContent>
                                {getFilteredCampaigns().map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.name} ({c.total_contacts || 0} contacts)
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-muted-foreground text-xs italic px-2">No campaigns found for this channel</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {messageType === "email" && toMode === "individual" && (
                      <div className="flex items-center px-4 py-2 border-b border-border/50 text-sm h-11">
                        <label htmlFor="front-subject" className="w-16 text-muted-foreground font-medium shrink-0">Subject</label>
                        <input
                          id="front-subject"
                          value={subject}
                          onChange={(e) => setSubject(e.target.value)}
                          placeholder="Email subject"
                          className="flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground/60 text-sm"
                        />
                      </div>
                    )}

                    {/* Message Input (voice: the agent's own instructions run the call) */}
                    {isVoice ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        {toMode === "campaign"
                          ? "Each contact in the campaign is called one at a time, by the agent above from the number above."
                          : "The selected agent calls this number and talks using its own instructions, tools and knowledge base."}
                      </p>
                    ) : <div className="p-3">
                      <textarea
                        value={messageText}
                        onChange={(e) => setMessageText(e.target.value)}
                        aria-label="Message"
                        placeholder={`Type your ${messageType.toUpperCase()} message...`}
                        className="w-full min-h-[80px] resize-none bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground/60 focus:ring-0"
                      />
                    </div>}

                    {/* Footer Actions */}
                    <div className="flex items-center justify-between p-3 border-t border-border/50 bg-card">
                      <span className="text-[11px] font-medium text-muted-foreground/70">
                        ⌘/Ctrl + Enter to send
                      </span>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-foreground h-8 px-4"
                          onClick={() => {
                            setMessageText("");
                            setSelectedTemplateId("none");
                            setToField("");
                          }}
                          disabled={isSending}
                        >
                          Cancel
                        </Button>

                        <Button
                          size="sm"
                          className="h-8 px-4 gap-2 bg-[#171717] hover:bg-[#000000] text-white shadow-sm"
                          onClick={handleSendMessage}
                          disabled={isSending}
                        >
                          {isSending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : isVoice ? (
                            <Phone className="h-3.5 w-3.5" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                          {isVoice ? (toMode === "campaign" ? "Start calls" : "Call") : "Send"}
                        </Button>
                      </div>
                    </div>

                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
