import { runVoiceCampaign } from "@/lib/outbound-call";
import * as React from "react";
import { useEffect, useState, useId } from "react";
import { useAuth } from "@/hooks/useAuth";
import { usePersistentState } from "@/hooks/usePersistentState";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Plus, MapPin, Phone, Target, MoreVertical, Pencil, Trash2, Play, Loader2, Users, CalendarDays, Clock, Hash, FileText, ArrowLeft, Bot, Check, ChevronsUpDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { invokeAuthedFunction, isLocalDevHost } from "@/lib/local-functions";
import { cn } from "@/lib/utils";

interface Campaign {
  id: string;
  venue_name: string;
  venue_location: string | null;
  start_date: string | null;
  end_date: string | null;
  times: string | null;
  age_range: string | null;
  round: number;
  status: string;
  booking_target: number | null;
  twilio_phone_number: string | null;
  elevenlabs_campaign_id: string | null;
  notes: string | null;
  created_at: string;
  phone_config_id: string | null;
  agent_id: string | null;
  delay_seconds: number;
  enable_number_locking: boolean;
  calls_made: number;
  total_contacts: number;
}

interface AgentRow { id: string; name: string; }
interface PhoneConfigRow {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  provider: string;
  channel?: string | null;
  user_id?: string | null;
}
interface CampaignCallLog {
  id: string;
  recipient_number: string | null;
  caller_number?: string | null;
  status: string;
  duration: number | null;
  started_at: string | null;
  summary: string | null;
  ended_at: string | null;
  transcript: any;
}

interface MultiPhoneSelectProps {
  label: string;
  value: string[];
  options: PhoneConfigRow[];
  onChange: React.Dispatch<React.SetStateAction<string[]>>;
  helperText?: string;
}

const IS_LOCAL_DASHBOARD = false; // ponytail: local /api/local + edge-function data path needs undeployed functions; read the DB directly

const upsertCampaignOutcome = async (
  campaignId: string,
  contact: any,
  outcome: string,
  attemptNumber: number,
  userId: string,
) => {
  const { data: existing, error: existingError } = await supabase
    .from("call_outcomes")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("contact_id", contact.id || null)
    .eq("attempt_number", attemptNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const payload = {
    user_id: userId,
    campaign_id: campaignId,
    phone_number: contact.phone_number,
    parent_name: contact.first_name || null,
    child_names: contact.child_names || null,
    venue_name: contact.venue_name || null,
    contact_id: contact.id || null,
    outcome,
    attempt_number: attemptNumber,
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("call_outcomes")
      .update(payload)
      .eq("id", existing.id);
    if (error) {
      throw new Error(error.message);
    }
    return existing.id;
  }

  const { data, error } = await supabase
    .from("call_outcomes")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data.id;
};

const getInvokeErrorMessage = async (err: any) => {
  if (!err) return "Unknown error";
  const context = err.context;
  if (context instanceof Response) {
    const payload = await context.clone().json().catch(async () => ({ error: await context.text().catch(() => "") }));
    return payload?.error || payload?.details || err.message || "Function call failed";
  }
  return err.message || "Function call failed";
};

const getQueuedCallSummary = (data: any) => {
  // Voice agent campaigns: calls are queued and dialed one at a time.
  if (typeof data?.queued === "number") {
    return {
      title: "Campaign started",
      description: `Calling ${data.queued} contact${data.queued === 1 ? "" : "s"}, one every ${data.delay_seconds}s${data.skipped_dnc ? ` (${data.skipped_dnc} skipped: do not call)` : ""}. You can close this page.`,
      variant: "default" as const,
    };
  }
  const initiatedCount = Number(data?.initiated_count || 0);
  const failedCount = Number(data?.failed_count || 0);
  const firstError = Array.isArray(data?.results)
    ? data.results.find((result: any) => result?.status === "failed" && result?.error)?.error
    : null;

  if (initiatedCount > 0) {
    return {
      title: "Campaign started",
      description:
        failedCount > 0
          ? `${initiatedCount} call${initiatedCount === 1 ? "" : "s"} queued, ${failedCount} failed`
          : `${initiatedCount} call${initiatedCount === 1 ? "" : "s"} queued`,
      variant: "default" as const,
    };
  }

  return {
    title: "No calls started",
    description: firstError || "No outbound calls were initiated.",
    variant: "destructive" as const,
  };
};

const shouldFallbackToLocalCampaign = (err: any) => {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("cors") ||
    message.includes("failed to fetch") ||
    message.includes("typeerror: failed to fetch") ||
    message.includes("networkerror")
  );
};

const inferCampaignCountryCode = (contacts: Array<{ phone_number?: string | null }>) => {
  const counts = new Map<string, number>();

  for (const contact of contacts) {
    const trimmed = String(contact?.phone_number || "").trim();
    if (!trimmed.startsWith("+")) continue;
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 11) continue;
    const nationalNumberLengths = [10];
    for (const nationalLength of nationalNumberLengths) {
      if (digits.length <= nationalLength) continue;
      const countryCode = digits.slice(0, digits.length - nationalLength);
      if (!countryCode) continue;
      counts.set(countryCode, (counts.get(countryCode) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};

const normalizeCampaignPhoneNumber = (raw: string, fromNumber?: string | null, inferredCountryCode?: string | null) => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("00")) return `+${trimmed.slice(2)}`;

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  if (digits.length >= 11) return `+${digits}`;

  if (digits.length === 10 && inferredCountryCode) {
    return `+${inferredCountryCode}${digits}`;
  }

  const fromDigits = String(fromNumber || "").replace(/\D/g, "");
  if (digits.length === 10 && fromDigits.length >= 11) {
    const countryCode = fromDigits.slice(0, fromDigits.length - 10);
    if (countryCode) return `+${countryCode}${digits}`;
  }

  return trimmed;
};

const normalizeComparablePhone = (raw: string | null | undefined) =>
  String(raw || "").replace(/\D/g, "");

const getPhoneLabel = (phoneConfig: PhoneConfigRow) =>
  `${phoneConfig.friendly_name || phoneConfig.phone_number} (${phoneConfig.provider})`;

const isVoiceCapablePhoneConfig = (phoneConfig: PhoneConfigRow) =>
  String(phoneConfig.channel || "").toLowerCase() !== "sms";

const normalizeCampaignPhoneIds = (
  phoneIds: string[],
  allPhoneConfigs: PhoneConfigRow[],
) => {
  const normalized: string[] = [];

  for (const phoneId of phoneIds) {
    const phoneConfig = allPhoneConfigs.find((config) => config.id === phoneId);
    if (!phoneConfig) continue;

    if (isVoiceCapablePhoneConfig(phoneConfig)) {
      if (!normalized.includes(phoneConfig.id)) normalized.push(phoneConfig.id);
      continue;
    }

    const voiceReplacement = allPhoneConfigs.find(
      (candidate) =>
        candidate.id !== phoneConfig.id &&
        isVoiceCapablePhoneConfig(candidate) &&
        candidate.phone_number === phoneConfig.phone_number &&
        candidate.provider === phoneConfig.provider &&
        (candidate.user_id || null) === (phoneConfig.user_id || null),
    );

    if (voiceReplacement && !normalized.includes(voiceReplacement.id)) {
      normalized.push(voiceReplacement.id);
    }
  }

  return normalized;
};

const dedupePhoneIds = (phoneIds: string[]) => Array.from(new Set(phoneIds.filter(Boolean)));

const togglePhoneSelection = (current: string[], phoneId: string, checked: boolean) => {
  if (checked) return current.includes(phoneId) ? current : [...current, phoneId];
  return current.filter((id) => id !== phoneId);
};

const getPhoneSelectionLabel = (selectedIds: string[], phoneConfigs: PhoneConfigRow[]) => {
  if (selectedIds.length === 0) return "Select phone numbers";
  if (selectedIds.length === 1) {
    const selectedConfig = phoneConfigs.find((phoneConfig) => phoneConfig.id === selectedIds[0]);
    return selectedConfig ? getPhoneLabel(selectedConfig) : "1 phone selected";
  }
  return `${selectedIds.length} phone numbers selected`;
};

function MultiPhoneSelect({ label, value, options, onChange, helperText }: MultiPhoneSelectProps) {
  const [open, setOpen] = useState(false);
  const labelId = useId(); // unique per picker: the page can show more than one

  return (
    <div className="space-y-2">
      <Label id={labelId}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-labelledby={labelId}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{getPhoneSelectionLabel(value, options)}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search phone number..." />
            <CommandList>
              <CommandEmpty>No phone numbers found.</CommandEmpty>
              <CommandGroup>
                {options.map((phoneConfig) => {
                  const isSelected = value.includes(phoneConfig.id);
                  return (
                    <CommandItem
                      key={phoneConfig.id}
                      value={`${phoneConfig.phone_number} ${phoneConfig.friendly_name || ""} ${phoneConfig.provider}`}
                      onSelect={() => onChange((prev) => togglePhoneSelection(prev, phoneConfig.id, !isSelected))}
                    >
                      <Check className={cn("mr-2 h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{phoneConfig.friendly_name || phoneConfig.phone_number}</span>
                        <span className="text-xs text-muted-foreground">
                          {phoneConfig.phone_number} · {phoneConfig.provider}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {helperText ? <p className="text-xs text-muted-foreground">{helperText}</p> : null}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  completed: "bg-primary text-primary-foreground",
};

const emptyForm = {
  venue_name: "", venue_location: "", start_date: "", end_date: "", times: "", age_range: "",
  round: 1, status: "draft", booking_target: "", twilio_phone_number: "", elevenlabs_campaign_id: "",
  notes: "", agent_id: "", phone_config_id: "", delay_seconds: "30", enable_number_locking: true,
};

const ACTIVE_CALL_STATUSES = ["queued", "initiated", "ringing", "in-progress"];
const ACTIVE_CALL_LOCK_WINDOW_MS = 10 * 60 * 1000;

export default function CampaignsTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [phoneConfigs, setPhoneConfigs] = useState<PhoneConfigRow[]>([]);
  const [campaignPhoneMap, setCampaignPhoneMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = usePersistentState("campaigns-tab-dialog-open", false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = usePersistentState("campaigns-tab-form", emptyForm);
  const [filter, setFilter] = usePersistentState("campaigns-tab-filter", "all");
  const [runningCampaign, setRunningCampaign] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = usePersistentState<string | null>("campaigns-tab-selected-campaign-id", null);
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [contactCount, setContactCount] = useState(0);
  const [outcomeCounts, setOutcomeCounts] = useState<Record<string, number>>({});
  const [contacts, setContacts] = useState<any[]>([]);
  const [callOutcomes, setCallOutcomes] = useState<any[]>([]);
  const [campaignCallLogs, setCampaignCallLogs] = useState<CampaignCallLog[]>([]);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<any | null>(null);
  const [contactForm, setContactForm] = useState<Record<string, string>>({});
  const [contactMetadataForm, setContactMetadataForm] = useState<Record<string, string>>({});
  const [savingContact, setSavingContact] = useState(false);
  const [customFieldDialogOpen, setCustomFieldDialogOpen] = useState(false);
  const [customFieldName, setCustomFieldName] = useState("");
  const [addingCustomField, setAddingCustomField] = useState(false);
  // Contact selection for calling
  const [selectedContactIdsState, setSelectedContactIdsState] = usePersistentState<string[]>("campaigns-tab-selected-contact-ids", []);
  const selectedContactIds = React.useMemo(() => new Set(selectedContactIdsState), [selectedContactIdsState]);
  const [detailAgent, setDetailAgent] = usePersistentState("campaigns-tab-detail-agent", "");
  const [detailPhoneIds, setDetailPhoneIds] = usePersistentState<string[]>("campaigns-tab-detail-phone-ids", []);
  const [detailDelay, setDetailDelay] = usePersistentState("campaigns-tab-detail-delay", "30");
  const [detailNumberLocking, setDetailNumberLocking] = usePersistentState("campaigns-tab-detail-locking", true);
  const [startingCall, setStartingCall] = useState(false);
  const startCampaignInFlightRef = React.useRef(false);
  const [formPhoneIds, setFormPhoneIds] = usePersistentState<string[]>("campaigns-tab-form-phone-ids", []);

  const getCampaignPhoneIds = React.useCallback((campaign: Campaign) => {
    const linkedIds = campaignPhoneMap[campaign.id] || [];
    if (linkedIds.length > 0) return linkedIds;
    return campaign.phone_config_id ? [campaign.phone_config_id] : [];
  }, [campaignPhoneMap]);

  const effectiveDetailAgent = React.useMemo(() => {
    if (detailAgent && agents.some((agent) => agent.id === detailAgent)) return detailAgent;
    if (selectedCampaign?.agent_id && agents.some((agent) => agent.id === selectedCampaign.agent_id)) {
      return selectedCampaign.agent_id;
    }
    return agents[0]?.id || "";
  }, [agents, detailAgent, selectedCampaign]);

  const effectiveDetailPhoneIds = React.useMemo(() => {
    const validPhoneIds = new Set(phoneConfigs.map((phoneConfig) => phoneConfig.id));
    const selectedPhoneIds = dedupePhoneIds(detailPhoneIds).filter((phoneId) => validPhoneIds.has(phoneId));
    if (selectedPhoneIds.length > 0) return selectedPhoneIds;
    if (!selectedCampaign) return [];
    const campaignPhoneIds = dedupePhoneIds(getCampaignPhoneIds(selectedCampaign)).filter((phoneId) => validPhoneIds.has(phoneId));
    if (campaignPhoneIds.length > 0) return campaignPhoneIds;
    return phoneConfigs[0]?.id ? [phoneConfigs[0].id] : [];
  }, [detailPhoneIds, getCampaignPhoneIds, phoneConfigs, selectedCampaign]);

  useEffect(() => {
    if (!selectedCampaign) return;

    if (effectiveDetailAgent && effectiveDetailAgent !== detailAgent) {
      setDetailAgent(effectiveDetailAgent);
    }

    const persistedPhoneIds = dedupePhoneIds(detailPhoneIds);
    if (
      effectiveDetailPhoneIds.length > 0 &&
      (persistedPhoneIds.length !== effectiveDetailPhoneIds.length ||
        persistedPhoneIds.some((phoneId, index) => phoneId !== effectiveDetailPhoneIds[index]))
    ) {
      setDetailPhoneIds(effectiveDetailPhoneIds);
    }
  }, [
    detailAgent,
    detailPhoneIds,
    effectiveDetailAgent,
    effectiveDetailPhoneIds,
    selectedCampaign,
    setDetailAgent,
    setDetailPhoneIds,
  ]);

  const syncCampaignPhoneConfigs = async (campaignId: string, phoneIds: string[]) => {
    if (!user) return;
    const normalizedPhoneIds = dedupePhoneIds(phoneIds);

    if (isLocalDevHost()) {
      await invokeAuthedFunction("sync-campaign-phone-configs", {
        campaignId,
        phoneIds: normalizedPhoneIds,
      });
      return;
    }

    await supabase.from("campaign_phone_configs").delete().eq("campaign_id", campaignId);
    if (normalizedPhoneIds.length === 0) return;

    const rows = normalizedPhoneIds.map((phoneId, index) => ({
      user_id: user.id,
      campaign_id: campaignId,
      phone_config_id: phoneId,
      sort_order: index,
    }));

    const { error } = await supabase.from("campaign_phone_configs").insert(rows as any);
    if (error) throw error;
  };

  const getCampaignResultFromCallLog = (callLog: CampaignCallLog) => {
    if (callLog.status === "completed" && (callLog.duration || 0) > 10) return "ANSWERED";
    if (callLog.status === "completed" && (callLog.duration || 0) <= 10) return "VOICEMAIL";
    if (["no-answer", "canceled", "busy"].includes(callLog.status)) return "NO_ANSWER";
    if (callLog.status === "failed") return "DECLINED";
    if (["initiated", "in-progress", "ringing", "queued"].includes(callLog.status)) return "PENDING";
    return String(callLog.status || "PENDING").toUpperCase();
  };

  const fetchData = async () => {
    if (!user) return;
    if (IS_LOCAL_DASHBOARD) {
      const [campaignPayload, spacePayload] = await Promise.all([
        invokeAuthedFunction<any>("voice-campaign-data", {
          userId: user.id,
          userEmail: user.email || "",
        }),
        invokeAuthedFunction<any>("voice-space-data", {
          userId: user.id,
          userEmail: user.email || "",
        }),
      ]);
      const nextCampaigns = (Array.isArray(campaignPayload?.campaigns) ? campaignPayload.campaigns : []) as Campaign[];
      const nextAgents = Array.isArray(spacePayload?.agents) ? spacePayload.agents : [];
      const allPhoneConfigs = (Array.isArray(spacePayload?.phoneConfigs) ? spacePayload.phoneConfigs : []) as PhoneConfigRow[];
      const nextCampaignPhoneMap = ((Array.isArray(campaignPayload?.campaignPhoneConfigs) ? campaignPayload.campaignPhoneConfigs : []) as any[]).reduce((acc, row) => {
        acc[row.campaign_id] = acc[row.campaign_id] || [];
        acc[row.campaign_id].push(row.phone_config_id);
        return acc;
      }, {} as Record<string, string[]>);
      Object.keys(nextCampaignPhoneMap).forEach((campaignId) => {
        nextCampaignPhoneMap[campaignId] = normalizeCampaignPhoneIds(nextCampaignPhoneMap[campaignId], allPhoneConfigs);
      });
      setCampaigns(nextCampaigns);
      setAgents(nextAgents);
      setPhoneConfigs(allPhoneConfigs.filter(isVoiceCapablePhoneConfig));
      setCampaignPhoneMap(nextCampaignPhoneMap);
      setLoading(false);
      return;
    }
    const [{ data: camps }, { data: ag }, { data: pc }, { data: campaignPhones }] = await Promise.all([
      supabase.from("campaigns").select("*").order("created_at", { ascending: false }),
      supabase.from("agents").select("id, name"),
      supabase.from("phone_configs").select("id, phone_number, friendly_name, provider, channel"),
      supabase.from("campaign_phone_configs").select("campaign_id, phone_config_id, sort_order").order("sort_order", { ascending: true }),
    ]);
    const nextCampaigns = (camps as Campaign[]) || [];
    const nextAgents = ag || [];
    const allPhoneConfigs = ((pc as PhoneConfigRow[]) || []);
    const nextCampaignPhoneMap = ((campaignPhones as any[]) || []).reduce((acc, row) => {
      acc[row.campaign_id] = acc[row.campaign_id] || [];
      acc[row.campaign_id].push(row.phone_config_id);
      return acc;
    }, {} as Record<string, string[]>);
    Object.keys(nextCampaignPhoneMap).forEach((campaignId) => {
      nextCampaignPhoneMap[campaignId] = normalizeCampaignPhoneIds(nextCampaignPhoneMap[campaignId], allPhoneConfigs);
    });
    setCampaigns(nextCampaigns);
    setAgents(nextAgents);
    setPhoneConfigs(allPhoneConfigs.filter(isVoiceCapablePhoneConfig));
    setCampaignPhoneMap(nextCampaignPhoneMap);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const channel = supabase
      .channel('campaigns-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_phone_configs' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const openCampaignDetail = async (c: Campaign) => {
    setSelectedCampaign(c);
    const campaignPhoneIds = getCampaignPhoneIds(c);
    const primaryCampaignPhoneId = campaignPhoneIds[0] || c.phone_config_id;
    const campaignPhoneNumber = phoneConfigs.find((pc) => pc.id === primaryCampaignPhoneId)?.phone_number || null;
    let contactsData: any[] = [];
    let cCount = 0;
    let outcomes: any[] = [];

    if (IS_LOCAL_DASHBOARD) {
      const payload = await invokeAuthedFunction<any>("voice-campaign-data", {
        userId: user.id,
        userEmail: user.email || "",
        campaignId: c.id,
      });
      contactsData = Array.isArray(payload?.contacts) ? payload.contacts : [];
      cCount = contactsData.length;
      outcomes = Array.isArray(payload?.callOutcomes) ? payload.callOutcomes : [];
      let callLogsData = (Array.isArray(payload?.callLogs) ? payload.callLogs : []) as CampaignCallLog[];
      const recipientNumbers = [...new Set(
        contactsData
          .flatMap((contact: any) => {
            const raw = String(contact.phone_number || "").trim();
            const normalized = normalizeCampaignPhoneNumber(raw, campaignPhoneNumber);
            return [raw, normalized].filter(Boolean);
          })
      )];
      if (recipientNumbers.length > 0) {
        callLogsData = callLogsData.filter((log) => {
          if (new Date(log.started_at).getTime() < new Date(c.created_at || 0).getTime()) return false; // before this campaign
          const recipientDigits = normalizeComparablePhone(log.recipient_number);
          return contactsData.some((contact: any) => {
            const rawDigits = normalizeComparablePhone(contact.phone_number);
            const normalizedDigits = normalizeComparablePhone(normalizeCampaignPhoneNumber(contact.phone_number, campaignPhoneNumber));
            return recipientDigits === rawDigits || recipientDigits === normalizedDigits;
          });
        });
      } else {
        callLogsData = [];
      }
      setContacts(contactsData || []);
      setContactCount(cCount || 0);
      setCallOutcomes(outcomes || []);
      setCampaignCallLogs(callLogsData);
      const counts: Record<string, number> = {};
      if (callLogsData.length > 0) {
        callLogsData.forEach((log) => {
          const outcome = getCampaignResultFromCallLog(log);
          counts[outcome] = (counts[outcome] || 0) + 1;
        });
      } else {
        (outcomes || []).forEach((o: any) => { counts[o.outcome] = (counts[o.outcome] || 0) + 1; });
      }
      setOutcomeCounts(counts);
      setSelectedContactIdsState((prev) => {
        const nextIds = new Set((contactsData || []).map((ct: any) => ct.id));
        const prevSet = new Set(prev);

        if (selectedCampaign?.id !== c.id || prevSet.size === 0) {
          return Array.from(nextIds);
        }

        const preserved = Array.from(prevSet).filter((id) => nextIds.has(id));
        return preserved.length > 0 ? preserved : Array.from(nextIds);
      });
      setSelectedCampaignId(c.id);
      // Only when opening a different campaign: the 15 s refresh must not undo the user's unsaved picks.
      if (selectedCampaign?.id !== c.id) {
        setDetailAgent(c.agent_id || "");
        setDetailPhoneIds(campaignPhoneIds);
        setDetailDelay(String(c.delay_seconds || 30));
        setDetailNumberLocking(c.enable_number_locking ?? true);
      }
      return;
    }

    const [{ data: contactsRows, count }, { data: outcomesRows }] = await Promise.all([
      supabase.from("contacts").select("*", { count: "exact" }).eq("campaign_id", c.id).order("created_at"),
      supabase.from("call_outcomes").select("*").eq("campaign_id", c.id).order("created_at", { ascending: false }),
    ]);
    contactsData = contactsRows || [];
    cCount = count || 0;
    outcomes = outcomesRows || [];
    const recipientNumbers = [...new Set(
      (contactsData || [])
        .flatMap((contact: any) => {
          const raw = String(contact.phone_number || "").trim();
          const normalized = normalizeCampaignPhoneNumber(raw, campaignPhoneNumber);
          return [raw, normalized].filter(Boolean);
        })
    )];
    let callLogsData: CampaignCallLog[] = [];
    if (recipientNumbers.length > 0) {
      const query = supabase
        .from("call_logs")
        .select("id, recipient_number, caller_number, status, duration, started_at, ended_at, summary, transcript")
        .eq("direction", "outbound")
        .in("recipient_number", recipientNumbers)
        .order("started_at", { ascending: false });
      const narrowedQuery = c.agent_id ? query.eq("agent_id", c.agent_id) : query;
      const callerScopedQuery = campaignPhoneNumber ? narrowedQuery.eq("caller_number", campaignPhoneNumber) : narrowedQuery;
      const { data } = await callerScopedQuery;
      callLogsData = ((data as CampaignCallLog[]) || []).filter((log) => {
        if (new Date(log.started_at).getTime() < new Date(c.created_at || 0).getTime()) return false; // before this campaign
        const recipientDigits = normalizeComparablePhone(log.recipient_number);
        return (contactsData || []).some((contact: any) => {
          const rawDigits = normalizeComparablePhone(contact.phone_number);
          const normalizedDigits = normalizeComparablePhone(normalizeCampaignPhoneNumber(contact.phone_number, campaignPhoneNumber));
          return recipientDigits === rawDigits || recipientDigits === normalizedDigits;
        });
      });
    }
    setContacts(contactsData || []);
    setContactCount(cCount || 0);
    setCallOutcomes(outcomes || []);
    setCampaignCallLogs(callLogsData);
    const counts: Record<string, number> = {};
    if (callLogsData.length > 0) {
      callLogsData.forEach((log) => {
        const outcome = getCampaignResultFromCallLog(log);
        counts[outcome] = (counts[outcome] || 0) + 1;
      });
    } else {
      (outcomes || []).forEach((o: any) => { counts[o.outcome] = (counts[o.outcome] || 0) + 1; });
    }
    setOutcomeCounts(counts);
    // Pre-select all contacts only when opening a different campaign.
    // While polling the same campaign, preserve the user's manual selection
    // and only drop ids that no longer exist.
    setSelectedContactIdsState((prev) => {
      const nextIds = new Set((contactsData || []).map((ct: any) => ct.id));
      const prevSet = new Set(prev);

      if (selectedCampaign?.id !== c.id || prevSet.size === 0) {
        return Array.from(nextIds);
      }

      const preserved = Array.from(prevSet).filter((id) => nextIds.has(id));
      return preserved.length > 0 ? preserved : Array.from(nextIds);
    });
    setSelectedCampaignId(c.id);
    // Only when opening a different campaign: the 15 s refresh must not undo the user's unsaved picks.
    if (selectedCampaign?.id !== c.id) {
      setDetailAgent(c.agent_id || "");
      setDetailPhoneIds(dedupePhoneIds(campaignPhoneIds));
      setDetailDelay(String(c.delay_seconds || 30));
      setDetailNumberLocking(c.enable_number_locking ?? true);
    }
  };

  useEffect(() => {
    if (!selectedCampaign) return;

    const interval = window.setInterval(() => {
      openCampaignDetail(selectedCampaign);
    }, 15000);

    return () => window.clearInterval(interval);
  }, [selectedCampaign, phoneConfigs]);

  useEffect(() => {
    if (!selectedCampaignId || campaigns.length === 0 || selectedCampaign) return;
    const persistedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId);
    if (persistedCampaign) {
      openCampaignDetail(persistedCampaign);
    }
  }, [campaigns, selectedCampaign, selectedCampaignId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const payload = {
      user_id: user.id, venue_name: form.venue_name, venue_location: form.venue_location || null,
      start_date: form.start_date || null, end_date: form.end_date || null, times: form.times || null,
      age_range: form.age_range || null, round: form.round, status: form.status,
      booking_target: form.booking_target ? parseInt(form.booking_target) : null,
      twilio_phone_number: form.twilio_phone_number || null, elevenlabs_campaign_id: form.elevenlabs_campaign_id || null,
      notes: form.notes || null, agent_id: form.agent_id || null, phone_config_id: formPhoneIds[0] || null,
      delay_seconds: parseInt(form.delay_seconds) || 30,
      enable_number_locking: form.enable_number_locking,
    };
    let error;
    let campaignId = editingId;
    if (editingId) {
      ({ error } = await supabase.from("campaigns").update(payload).eq("id", editingId));
    } else {
      const response = await supabase.from("campaigns").insert(payload as any).select("id").single();
      error = response.error;
      campaignId = response.data?.id || null;
    }
    if (error || !campaignId) { toast({ title: "Error", description: error?.message || "Failed to save campaign", variant: "destructive" }); }
    else {
      try {
        await syncCampaignPhoneConfigs(campaignId, formPhoneIds);
        toast({ title: editingId ? "Campaign updated" : "Campaign created" });
        setDialogOpen(false);
        setEditingId(null);
        setForm(emptyForm);
        setFormPhoneIds([]);
        fetchData();
      } catch (syncError: any) {
        toast({ title: "Error", description: syncError.message || "Failed to save campaign numbers", variant: "destructive" });
      }
    }
  };

  const editCampaign = (c: Campaign) => {
    setEditingId(c.id);
    setForm({
      venue_name: c.venue_name, venue_location: c.venue_location || "", start_date: c.start_date || "",
      end_date: c.end_date || "", times: c.times || "", age_range: c.age_range || "", round: c.round,
      status: c.status, booking_target: c.booking_target?.toString() || "", twilio_phone_number: c.twilio_phone_number || "",
      elevenlabs_campaign_id: c.elevenlabs_campaign_id || "", notes: c.notes || "", agent_id: c.agent_id || "",
      phone_config_id: c.phone_config_id || "", delay_seconds: c.delay_seconds?.toString() || "30",
      enable_number_locking: c.enable_number_locking ?? true,
    });
    setFormPhoneIds(getCampaignPhoneIds(c));
    setDialogOpen(true);
  };

  const deleteCampaign = async (id: string) => {
    const deleteRelatedTablesInOrder = async () => {
      const { error: outcomesError } = await supabase.from("call_outcomes").delete().eq("campaign_id", id);
      if (outcomesError) throw outcomesError;

      const { error: contactsError } = await supabase.from("contacts").delete().eq("campaign_id", id);
      if (contactsError) throw contactsError;

      const { error: phoneMapError } = await supabase.from("campaign_phone_configs").delete().eq("campaign_id", id);
      if (phoneMapError) throw phoneMapError;

      const { error: campaignError } = await supabase.from("campaigns").delete().eq("id", id);
      if (campaignError) throw campaignError;
    };

    try {
      await deleteRelatedTablesInOrder();
      toast({ title: "Campaign deleted" });
      if (selectedCampaign?.id === id) {
        setSelectedCampaign(null);
        setSelectedCampaignId(null);
      }
      fetchData();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const startCampaign = async (campaignId: string) => {
    if (startCampaignInFlightRef.current) return;
    startCampaignInFlightRef.current = true;
    setRunningCampaign(campaignId);
    try {
      const data = await runVoiceCampaign(campaignId);
      toast(getQueuedCallSummary(data));
      fetchData();
    } catch (err: any) {
      toast({ title: "Error", description: await getInvokeErrorMessage(err), variant: "destructive" });
    } finally {
      setRunningCampaign(null);
      startCampaignInFlightRef.current = false;
    }
  };

  const startSelectedCalls = async () => {
    if (startCampaignInFlightRef.current) return;
    if (!selectedCampaign || !user) return;
    if (!effectiveDetailAgent || effectiveDetailPhoneIds.length === 0) { toast({ title: "Select agent and at least one phone number", variant: "destructive" }); return; }
    if (selectedContactIds.size === 0) { toast({ title: "No contacts selected", variant: "destructive" }); return; }
    startCampaignInFlightRef.current = true;
    setStartingCall(true);
    try {
      const normalizedDetailPhoneIds = dedupePhoneIds(effectiveDetailPhoneIds);

      // Update campaign with agent/phone if changed
      await supabase.from("campaigns").update({
        agent_id: effectiveDetailAgent, phone_config_id: normalizedDetailPhoneIds[0] || null,
        delay_seconds: parseInt(detailDelay) || 30,
        enable_number_locking: detailNumberLocking,
      }).eq("id", selectedCampaign.id);
      setDetailPhoneIds(normalizedDetailPhoneIds);
      await syncCampaignPhoneConfigs(selectedCampaign.id, normalizedDetailPhoneIds);

      // Pass selected contact IDs so only those are called
      const data = await runVoiceCampaign(selectedCampaign.id, Array.from(selectedContactIds));
      toast(getQueuedCallSummary(data));
      // Refresh detail
      const updated = {
        ...selectedCampaign,
        agent_id: effectiveDetailAgent,
        phone_config_id: normalizedDetailPhoneIds[0] || null,
        delay_seconds: parseInt(detailDelay) || 30,
        enable_number_locking: detailNumberLocking,
      };
      const updatedPhones = normalizedDetailPhoneIds;
      setCampaignPhoneMap((prev) => ({ ...prev, [selectedCampaign.id]: updatedPhones }));
      openCampaignDetail(updated as Campaign);
      fetchData();
    } catch (err: any) {
      toast({ title: "Error", description: await getInvokeErrorMessage(err), variant: "destructive" });
    } finally {
      setStartingCall(false);
      startCampaignInFlightRef.current = false;
    }
  };

  const toggleContactSelect = (id: string) => {
    setSelectedContactIdsState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  };
  const toggleAllContacts = () => {
    if (selectedContactIds.size === contacts.length) setSelectedContactIdsState([]);
    else setSelectedContactIdsState(contacts.map((ct) => ct.id));
  };

  const getContactEditableFields = (contact: any) => {
    const baseKeys = Object.keys(contact || {}).filter((key) => ![
      "id",
      "campaign_id",
      "user_id",
      "created_at",
      "updated_at",
      "metadata",
    ].includes(key));

    return Array.from(new Set([
      "first_name",
      "phone_number",
      ...baseKeys,
    ]));
  };

  const normalizeContactAlias = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

  const contactAliasGroups: Record<string, string[]> = {
    first_name: ["name", "first_name", "firstname", "full_name"],
    phone_number: ["phone_number", "phonenumber", "phone", "mobile", "number"],
    email: ["email", "email_address", "mail"],
    serial_number: ["serial_number", "serial", "s_no", "sno"],
  };

  const canonicalContactKeys = new Set(
    Object.entries(contactAliasGroups).flatMap(([canonicalKey, aliases]) => [
      normalizeContactAlias(canonicalKey),
      ...aliases.map(normalizeContactAlias),
    ]),
  );

  const formatFieldLabel = (key: string) =>
    key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

  const syncContactMetadataAliases = (
    metadata: Record<string, any>,
    values: Record<string, any>,
  ) => {
    const nextMetadata = { ...metadata };

    const mirrorValue = (aliases: string[], value: any) => {
      const normalizedAliases = aliases.map(normalizeContactAlias);
      Object.keys(nextMetadata).forEach((existingKey) => {
        if (normalizedAliases.includes(normalizeContactAlias(existingKey))) {
          nextMetadata[existingKey] = value;
        }
      });
    };

    if ("first_name" in values) {
      mirrorValue(["name", "first_name", "firstname", "full_name"], values.first_name);
    }

    if ("phone_number" in values) {
      mirrorValue(["phone_number", "phonenumber", "phone", "mobile", "number"], values.phone_number);
    }

    if ("email" in values) {
      mirrorValue(["email", "email_address", "mail"], values.email);
    }

    if ("serial_number" in values) {
      mirrorValue(["serial_number", "serial", "s_no", "sno"], values.serial_number);
    }

    return nextMetadata;
  };

  const openContactEditor = (contact: any) => {
    const nextForm: Record<string, string> = {};
    getContactEditableFields(contact).forEach((key) => {
      nextForm[key] = contact?.[key] == null ? "" : String(contact[key]);
    });

    const nextMetadataForm: Record<string, string> = {};
    const metadata = contact?.metadata && typeof contact.metadata === "object"
      ? contact.metadata as Record<string, any>
      : {};
    Object.entries(metadata).forEach(([key, value]) => {
      if (!canonicalContactKeys.has(normalizeContactAlias(key))) {
        nextMetadataForm[key] = value == null ? "" : String(value);
      }
    });

    setEditingContact(contact);
    setContactForm(nextForm);
    setContactMetadataForm(nextMetadataForm);
    setContactDialogOpen(true);
  };

  const saveContactEdits = async () => {
    if (!editingContact) return;

    setSavingContact(true);
    try {
      const payload: Record<string, any> = {};
      Object.entries(contactForm).forEach(([key, value]) => {
        payload[key] = value.trim() === "" ? null : value;
      });

      const nextMetadata = Object.fromEntries(
        Object.entries(contactMetadataForm).map(([key, value]) => [key, value.trim() === "" ? null : value]),
      );

      Object.entries(contactAliasGroups).forEach(([canonicalKey, aliases]) => {
        if (payload[canonicalKey] != null && String(payload[canonicalKey]).trim() !== "") return;

        const matchedAliasKey = Object.keys(nextMetadata).find((existingKey) =>
          aliases.map(normalizeContactAlias).includes(normalizeContactAlias(existingKey)),
        );
        if (!matchedAliasKey) return;

        const aliasValue = nextMetadata[matchedAliasKey];
        if (aliasValue != null && String(aliasValue).trim() !== "") {
          payload[canonicalKey] = aliasValue;
        }
      });

      payload.metadata = syncContactMetadataAliases(nextMetadata, payload);

      const { error } = await supabase
        .from("contacts")
        .update(payload)
        .eq("id", editingContact.id);

      if (error) throw error;

      toast({ title: "Contact updated" });
      setContactDialogOpen(false);
      setEditingContact(null);
      if (selectedCampaign) {
        await openCampaignDetail(selectedCampaign);
      } else {
        await fetchData();
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to update contact",
        variant: "destructive",
      });
    } finally {
      setSavingContact(false);
    }
  };

  const deleteContact = async (contactId: string) => {
    try {
      const { error: detachError } = await supabase
        .from("call_outcomes")
        .update({ contact_id: null })
        .eq("contact_id", contactId);

      if (detachError) throw detachError;

      const { error } = await supabase.from("contacts").delete().eq("id", contactId);
      if (error) throw error;

      toast({ title: "Contact deleted" });
      if (selectedCampaign) {
        await openCampaignDetail(selectedCampaign);
      } else {
        await fetchData();
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to delete contact",
        variant: "destructive",
      });
    }
  };

  const normalizeCustomFieldKey = (value: string) =>
    value
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

  const addCustomField = async () => {
    if (!selectedCampaign) return;

    const rawName = customFieldName.trim();
    const fieldKey = normalizeCustomFieldKey(rawName);

    if (!rawName || !fieldKey) {
      toast({
        title: "Invalid field name",
        description: "Enter a valid custom field name.",
        variant: "destructive",
      });
      return;
    }

    setAddingCustomField(true);
    try {
      for (const contact of contacts) {
        const metadata =
          contact?.metadata && typeof contact.metadata === "object"
            ? { ...(contact.metadata as Record<string, any>) }
            : {};

        if (!(fieldKey in metadata)) {
          metadata[fieldKey] = "";
          const { error } = await supabase
            .from("contacts")
            .update({ metadata })
            .eq("id", contact.id);

          if (error) throw error;
        }
      }

      toast({ title: "Custom field added" });
      setCustomFieldDialogOpen(false);
      setCustomFieldName("");
      await openCampaignDetail(selectedCampaign);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add custom field",
        variant: "destructive",
      });
    } finally {
      setAddingCustomField(false);
    }
  };

  const filtered = filter === "all" ? campaigns : campaigns.filter((c) => c.status === filter);
  const statusCounts = campaigns.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {} as Record<string, number>);
  const getAgentName = (id: string | null) => id ? agents.find(a => a.id === id)?.name || "Unknown" : "—";
  const getCampaignPhoneLabel = (id: string | null) => { if (!id) return "—"; const pc = phoneConfigs.find(p => p.id === id); return pc ? (pc.friendly_name || pc.phone_number) : "Unknown"; };
  const getPhoneLabels = (campaign: Campaign) => getCampaignPhoneIds(campaign).map((id) => getCampaignPhoneLabel(id)).filter((label) => label !== "Unknown");

  // Campaign detail view
  if (selectedCampaign) {
    const c = selectedCampaign;
    const totalOutcomes = Object.values(outcomeCounts).reduce((a, b) => a + b, 0);

    // Build dynamic columns from metadata if available
    const metadataKeys = Array.from(
      new Set(
        contacts.flatMap((contact) =>
          contact?.metadata && typeof contact.metadata === "object"
            ? Object.keys(contact.metadata as Record<string, any>)
            : [],
        ),
      ),
    );
    const fixedCols = [
      { key: "first_name", label: "Name" },
      { key: "serial_number", label: "S.No" },
      { key: "email", label: "Email" },
      { key: "phone_number", label: "Phone" },
      { key: "venue_name", label: "Venue" },
      { key: "venue_location", label: "Location" },
      { key: "child_names", label: "Children" },
      { key: "age_range", label: "Age Range" },
      { key: "start_date", label: "Start Date" },
      { key: "end_date", label: "End Date" },
      { key: "times", label: "Times" },
      { key: "language", label: "Language" },
    ];

    const fixedDisplayCols = fixedCols.filter((col) =>
      ["first_name", "serial_number", "email", "phone_number"].includes(col.key) ||
      contacts.some((ct) => {
        const value = ct?.[col.key];
        return value != null && String(value).trim() !== "" && value !== "en";
      }),
    );

    const metadataCols: { key: string; label: string }[] = metadataKeys
      .filter((key) => !canonicalContactKeys.has(normalizeContactAlias(key)))
      .map((key) => ({
        key,
        label: key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
      }));

    const displayCols = [...fixedDisplayCols, ...metadataCols];

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Back to campaigns" onClick={() => { setSelectedCampaign(null); setSelectedCampaignId(null); }}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h2 className="text-2xl font-bold">{c.venue_name}</h2>
            {c.venue_location && <p className="text-muted-foreground flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {c.venue_location}</p>}
          </div>
          <Badge className={`${STATUS_COLORS[c.status] || ""} text-sm px-3 py-1`}>{String(c.status || "").charAt(0).toUpperCase() + String(c.status || "").slice(1)}</Badge>
        </div>

        <div className="grid gap-4 grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>Total Contacts</CardDescription>
              <CardTitle className="flex items-center gap-2 text-3xl">
                <Users className="h-6 w-6 text-primary" />
                {contactCount}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>Calls Made</CardDescription>
              <CardTitle className="flex items-center gap-2 text-3xl">
                <Phone className="h-6 w-6 text-primary" />
                {c.calls_made}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        {c.total_contacts > 0 && (
          <Card><CardContent className="pt-6"><div className="flex justify-between text-sm mb-2"><span className="text-muted-foreground">Call Progress</span><span className="font-medium">{c.calls_made} / {c.total_contacts}</span></div><Progress value={c.total_contacts > 0 ? (c.calls_made / c.total_contacts) * 100 : 0} className="h-3" /></CardContent></Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Campaign Details</CardTitle></CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                {c.agent_id && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Agent:</span><span className="font-medium">{getAgentName(c.agent_id)}</span></div>}
                {getCampaignPhoneIds(c).length > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground w-28">Numbers:</span>
                    <span className="font-medium">{getPhoneLabels(c).join(", ")}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Delay:</span><span className="font-medium">{c.delay_seconds}s between calls</span></div>
                <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Locking:</span><span className="font-medium">{c.enable_number_locking ? "Enabled" : "Disabled"}</span></div>
                {c.age_range && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Age Range:</span><span className="font-medium">{c.age_range}</span></div>}
              </div>
              <div className="space-y-3">
                {c.start_date && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Dates:</span><span className="font-medium">{c.start_date} → {c.end_date || "TBD"}</span></div>}
                {c.times && <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Times:</span><span className="font-medium">{c.times}</span></div>}
                <div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground w-28">Created:</span><span className="font-medium">{new Date(c.created_at).toLocaleDateString()}</span></div>
              </div>
            </div>
            {c.notes && (
              <>
                <Separator className="my-4" />
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground flex items-center gap-1"><FileText className="h-3.5 w-3.5" /> Notes</p>
                  <p className="text-sm">{c.notes}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Contacts Table with Selection */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4" /> Contacts ({contacts.length})
                </CardTitle>
                <CardDescription>{selectedContactIds.size} of {contacts.length} selected</CardDescription>
              </div>
              <Button type="button" variant="outline" onClick={() => setCustomFieldDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Custom Field
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No contacts uploaded for this campaign.</p>
            ) : (
              <ScrollArea className="max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={selectedContactIds.size === contacts.length && contacts.length > 0}
                          onCheckedChange={toggleAllContacts}
                          aria-label="Select all contacts"
                        />
                      </TableHead>
                      <TableHead className="w-12">#</TableHead>
                      {displayCols.map((col) => (
                        <TableHead key={col.key}>{col.label}</TableHead>
                      ))}
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contacts.map((ct, idx) => (
                      <TableRow key={ct.id} className={selectedContactIds.has(ct.id) ? "bg-primary/5" : ""}>
                        <TableCell>
                          <Checkbox
                            checked={selectedContactIds.has(ct.id)}
                            onCheckedChange={() => toggleContactSelect(ct.id)}
                            aria-label={`Select contact ${ct.phone_number || idx + 1}`}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{idx + 1}</TableCell>
                        {displayCols.map((col) => {
                          const val =
                            ct?.[col.key] ??
                            (ct.metadata as Record<string, any> | undefined)?.[col.key];
                          return (
                            <TableCell key={col.key} className={col.key.includes("name") && !col.key.includes("child") ? "font-medium" : col.key.includes("phone") ? "font-mono text-xs" : ""}>
                              {val || "—"}
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button type="button" variant="ghost" size="icon" aria-label={`More actions for contact ${ct.phone_number || idx + 1}`}>
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openContactEditor(ct)}>
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => deleteContact(ct.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <Dialog open={customFieldDialogOpen} onOpenChange={setCustomFieldDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add Custom Field</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="custom-field-name">Field Name</Label>
                <Input
                  id="custom-field-name"
                  value={customFieldName}
                  onChange={(event) => setCustomFieldName(event.target.value)}
                  placeholder="Appointment Date"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCustomFieldDialogOpen(false);
                    setCustomFieldName("");
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={() => void addCustomField()} disabled={addingCustomField}>
                  {addingCustomField ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                  Add Field
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Start Calling Section */}
        {contacts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Phone className="h-5 w-5" /> Start Calling</CardTitle>
              <CardDescription>Call {selectedContactIds.size} selected contacts using your AI agent.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="campaign-detail-agent">Agent *</Label>
                  <Select value={effectiveDetailAgent} onValueChange={setDetailAgent}>
                    <SelectTrigger id="campaign-detail-agent"><SelectValue placeholder="Select agent" /></SelectTrigger>
                    <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <MultiPhoneSelect
                    label="Phone Numbers *"
                    value={effectiveDetailPhoneIds}
                    options={phoneConfigs}
                    onChange={setDetailPhoneIds}
                    helperText="Selected numbers rotate in round-robin order for outbound calls."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="campaign-detail-delay">Delay Between Calls (sec)</Label>
                  <Input id="campaign-detail-delay" type="number" value={detailDelay} onChange={(e) => setDetailDelay(e.target.value)} min={5} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="campaign-detail-locking">Number Locking</Label>
                  <div className="flex h-10 items-center gap-3 rounded-md border px-3">
                    <Checkbox id="campaign-detail-locking" checked={detailNumberLocking} onCheckedChange={(checked) => setDetailNumberLocking(Boolean(checked))} />
                    <span className="text-sm">Only use one active call per number</span>
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <Button onClick={startSelectedCalls} disabled={startingCall || selectedContactIds.size === 0 || !effectiveDetailAgent || effectiveDetailPhoneIds.length === 0} size="lg">
                  {startingCall ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Starting Campaign...</> : <><Play className="h-4 w-4 mr-2" /> Call {selectedContactIds.size} Contacts</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => editCampaign(c)}><Pencil className="h-4 w-4 mr-2" /> Edit</Button>
          <Button variant="destructive" onClick={() => deleteCampaign(c.id)}><Trash2 className="h-4 w-4 mr-2" /> Delete</Button>
        </div>

        <Dialog
          open={contactDialogOpen}
          onOpenChange={(open) => {
            setContactDialogOpen(open);
            if (!open) {
              setEditingContact(null);
              setContactForm({});
              setContactMetadataForm({});
            }
          }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Contact</DialogTitle>
            </DialogHeader>
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.keys(contactForm).map((key) => (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`contact-field-${key}`}>{formatFieldLabel(key)}</Label>
                    <Input
                      id={`contact-field-${key}`}
                      value={contactForm[key] ?? ""}
                      onChange={(e) => setContactForm((prev) => ({ ...prev, [key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>

              {Object.keys(contactMetadataForm).length > 0 && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-medium">Additional Details</h3>
                    <p className="text-sm text-muted-foreground">Metadata fields stored with this contact.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {Object.keys(contactMetadataForm).map((key) => (
                      <div key={key} className="space-y-2">
                        <Label htmlFor={`contact-meta-${key}`}>{formatFieldLabel(key)}</Label>
                        <Input
                          id={`contact-meta-${key}`}
                          value={contactMetadataForm[key] ?? ""}
                          onChange={(e) => setContactMetadataForm((prev) => ({ ...prev, [key]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <Button type="button" onClick={saveContactEdits} disabled={savingContact}>
                  {savingContact ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...</> : "Save Contact"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setContactDialogOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => setEditingId(null)}><Plus className="h-4 w-4 mr-2" /> New Campaign</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{editingId ? "Edit Campaign" : "New Campaign"}</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="campaign-venue-name">Venue Name *</Label><Input id="campaign-venue-name" value={form.venue_name} onChange={(e) => setForm({ ...form, venue_name: e.target.value })} required /></div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-location">Location</Label><Input id="campaign-location" value={form.venue_location} onChange={(e) => setForm({ ...form, venue_location: e.target.value })} /></div>
                <div className="space-y-2"><Label htmlFor="campaign-age-range">Age Range</Label><Input id="campaign-age-range" value={form.age_range} onChange={(e) => setForm({ ...form, age_range: e.target.value })} placeholder="e.g. 5-12" /></div>
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-start-date">Start Date</Label><Input id="campaign-start-date" type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
                <div className="space-y-2"><Label htmlFor="campaign-end-date">End Date</Label><Input id="campaign-end-date" type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-agent">Agent</Label><Select value={form.agent_id} onValueChange={(v) => setForm({ ...form, agent_id: v })}><SelectTrigger id="campaign-agent"><SelectValue placeholder="Select agent" /></SelectTrigger><SelectContent>{agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
                <MultiPhoneSelect
                  label="Phone Numbers"
                  value={formPhoneIds}
                  options={phoneConfigs}
                  onChange={setFormPhoneIds}
                />
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-delay-between-calls-sec">Delay Between Calls (sec)</Label><Input id="campaign-delay-between-calls-sec" type="number" value={form.delay_seconds} onChange={(e) => setForm({ ...form, delay_seconds: e.target.value })} min={5} /></div>
                <div className="space-y-2"><Label htmlFor="campaign-booking-target">Booking Target</Label><Input id="campaign-booking-target" type="number" value={form.booking_target} onChange={(e) => setForm({ ...form, booking_target: e.target.value })} /></div>
              </div>
              <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                <Checkbox
                  id="campaign-number-locking"
                  checked={form.enable_number_locking}
                  onCheckedChange={(checked) => setForm({ ...form, enable_number_locking: Boolean(checked) })}
                />
                <div>
                  <Label htmlFor="campaign-number-locking" className="text-sm">Enable Number Locking</Label>
                  <p className="text-xs text-muted-foreground">Keep each number on only one active call at a time.</p>
                </div>
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-round">Round</Label><Select value={String(form.round)} onValueChange={(v) => setForm({ ...form, round: parseInt(v) })}><SelectTrigger id="campaign-round"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1">Round 1</SelectItem><SelectItem value="2">Round 2</SelectItem><SelectItem value="3">Round 3</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label htmlFor="campaign-status">Status</Label><Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}><SelectTrigger id="campaign-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="draft">Draft</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="paused">Paused</SelectItem><SelectItem value="completed">Completed</SelectItem></SelectContent></Select></div>
              </div>
              <div className="grid gap-4 grid-cols-2">
                <div className="space-y-2"><Label htmlFor="campaign-times">Times</Label><Input id="campaign-times" value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} placeholder="e.g. 9am-3pm" /></div>
              </div>
              <div className="space-y-2"><Label htmlFor="campaign-notes">Notes</Label><Textarea id="campaign-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} /></div>
              <div className="flex gap-3"><Button type="submit">{editingId ? "Update" : "Create"}</Button><Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button></div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex gap-2 flex-wrap">
        {["all", "draft", "active", "paused", "completed"].map((s) => (
          <Button key={s} variant={filter === s ? "default" : "outline"} size="sm" onClick={() => setFilter(s)}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <Card key={i}><CardContent className="h-40 animate-pulse bg-muted/50 rounded-lg" /></Card>)}
        </div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center"><p className="text-muted-foreground">No campaigns yet. Create one to get started.</p></CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <Card key={c.id} className="relative cursor-pointer hover:shadow-md transition-shadow" onClick={() => openCampaignDetail(c)} role="button" tabIndex={0} aria-label={`Open ${c.venue_name}`} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openCampaignDetail(c); } }}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{c.venue_name}</CardTitle>
                      {c.round > 1 && <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-5 min-w-max">Retry {c.round}</Badge>}
                    </div>
                    {c.venue_location && <CardDescription className="flex items-center gap-1 mt-1"><MapPin className="h-3 w-3" /> {c.venue_location}</CardDescription>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge className={STATUS_COLORS[c.status] || ""}>{String(c.status || "").charAt(0).toUpperCase() + String(c.status || "").slice(1)}</Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for ${c.venue_name}`} onClick={(e) => e.stopPropagation()}><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); editCampaign(c); }}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={(e) => { e.stopPropagation(); deleteCampaign(c.id); }}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2 flex-wrap">
                  {c.age_range && <Badge variant="secondary">{c.age_range}</Badge>}
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  {c.start_date && <p className="flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {c.start_date} → {c.end_date || "TBD"}</p>}
                  {c.times && <p className="flex items-center gap-1"><Clock className="h-3 w-3" /> {c.times}</p>}
                  {c.booking_target && <p className="flex items-center gap-1"><Target className="h-3 w-3" /> Target: {c.booking_target}</p>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
