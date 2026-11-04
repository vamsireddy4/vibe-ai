import * as React from "react";
import { useLocation } from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";
import ChannelSelect from "@/components/ChannelSelect";
import { getVibeSpaceFromPath } from "@/lib/vibe-routes";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Megaphone, FileSpreadsheet, ClipboardList, RefreshCw, Plus, ArrowLeft, Play, Users, FileText, Pencil, MoreHorizontal, Trash2, Clock3, CheckCircle2, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import CampaignsTab from "@/components/campaigns/CampaignsTab";
import DataCleaningTab from "@/components/campaigns/DataCleaningTab";
import OutcomesTab from "@/components/campaigns/OutcomesTab";
import RetryCSVTab from "@/components/campaigns/RetryCSVTab";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage, isEdgeFunctionUnavailable } from "@/lib/edge-functions";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

type SmsTemplate = Database["public"]["Tables"]["sms_templates"]["Row"] & {
  linked_tags: string[];
};
type GmailTemplate = Database["public"]["Tables"]["gmail_templates"]["Row"] & {
  linked_tags: string[];
};

type SmsCampaign = Omit<Database["public"]["Tables"]["sms_campaigns"]["Row"], "extracted_contacts"> & {
  extracted_contacts: Array<Record<string, unknown>>;
};
type GmailCampaign = Omit<Database["public"]["Tables"]["gmail_campaigns"]["Row"], "extracted_contacts"> & {
  extracted_contacts: Array<Record<string, unknown>>;
};

type SmsCompletedCampaign = Omit<Database["public"]["Tables"]["sms_completed_campaigns"]["Row"], "selected_contacts" | "outcomes"> & {
  selected_contacts: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
};
type GmailCompletedCampaign = Omit<Database["public"]["Tables"]["gmail_completed_campaigns"]["Row"], "selected_contacts" | "outcomes"> & {
  selected_contacts: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
};
type MessagingTemplate = SmsTemplate | GmailTemplate;
type MessagingCampaign = SmsCampaign | GmailCampaign;
type MessagingCompletedCampaign = SmsCompletedCampaign | GmailCompletedCampaign;

type EmailTemplateConfig = {
  to: string;
  subject: string;
  body: string;
};

const IS_LOCAL_SMS = false; // ponytail: local route path needs undeployed edge functions
const PLACEHOLDER_PATTERN = /<<\s*([^>]+?)\s*>>/g;
const GMAIL_TEMPLATE_FALLBACK_CATEGORY = "gmail:email";
const GMAIL_CHANNEL_MARKER = "__magicteams_channel";
const DEFAULT_GMAIL_TEMPLATE: EmailTemplateConfig = {
  to: "<<email>>",
  subject: "",
  body: "",
};

const parseEmailTemplateConfig = (value: string | null | undefined): EmailTemplateConfig => {
  if (!value) return DEFAULT_GMAIL_TEMPLATE;

  try {
    const parsed = JSON.parse(value) as Partial<EmailTemplateConfig>;
    return {
      to: typeof parsed.to === "string" && parsed.to.trim() ? parsed.to : DEFAULT_GMAIL_TEMPLATE.to,
      subject: typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject : DEFAULT_GMAIL_TEMPLATE.subject,
      body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body : DEFAULT_GMAIL_TEMPLATE.body,
    };
  } catch {
    return DEFAULT_GMAIL_TEMPLATE;
  }
};

const serializeEmailTemplateConfig = (value: EmailTemplateConfig) =>
  JSON.stringify({
    to: value.to.trim() || DEFAULT_GMAIL_TEMPLATE.to,
    subject: value.subject.trim() || DEFAULT_GMAIL_TEMPLATE.subject,
    body: value.body.trim() || DEFAULT_GMAIL_TEMPLATE.body,
  });

const extractPlaceholders = (value: string) => {
  const seen = new Set<string>();
  const matches = value.matchAll(PLACEHOLDER_PATTERN);
  for (const match of matches) {
    const cleaned = match[1]?.trim();
    if (cleaned) seen.add(`<<${cleaned}>>`);
  }
  return Array.from(seen);
};

const isMissingTableError = (message: string | undefined) => {
  if (!message) return false;

  const normalized = message.toLowerCase();
  return (
    normalized.includes("schema cache") ||
    normalized.includes("could not find the table") ||
    normalized.includes("relation") ||
    normalized.includes("does not exist") ||
    normalized.includes("not found")
  );
};

const isGmailFallbackCampaign = (campaign: MessagingCampaign) => {
  const contacts = Array.isArray(campaign.extracted_contacts) ? (campaign.extracted_contacts as Array<Record<string, unknown>>) : [];
  return contacts.some((contact) => {
    const metadata = contact?.metadata;
    return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)[GMAIL_CHANNEL_MARKER] === "gmail";
  });
};

const isGmailFallbackCompletedCampaign = (campaign: MessagingCompletedCampaign) => {
  const contacts = Array.isArray(campaign.selected_contacts) ? (campaign.selected_contacts as Array<Record<string, unknown>>) : [];
  const outcomes = Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [];

  return contacts.some((contact) => {
    const metadata = contact?.metadata;
    return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)[GMAIL_CHANNEL_MARKER] === "gmail";
  }) || outcomes.some((outcome) => outcome?.[GMAIL_CHANNEL_MARKER] === "gmail");
};

const isGmailFallbackTemplate = (template: MessagingTemplate) =>
  String(template.category || "").toLowerCase() === GMAIL_TEMPLATE_FALLBACK_CATEGORY;

async function loadRowsByUserOrEmail<T>(table: string, selectClause: string, userId: string, userEmail?: string | null) {
  const byUserId = await supabase
    .from(table as any)
    .select(selectClause)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (byUserId.error) return { data: null as T[] | null, error: byUserId.error };

  if (!userEmail) {
    return { data: (byUserId.data as T[] | null) || [], error: null };
  }

  const byEmail = await supabase
    .from(table as any)
    .select(selectClause)
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false });

  if (byEmail.error) return { data: null as T[] | null, error: byEmail.error };

  const merged = new Map<string, T>();
  for (const row of ([...(byUserId.data || []), ...(byEmail.data || [])] as T[] & Array<{ id?: string }>)) {
    const id = (row as any)?.id;
    if (id && !merged.has(id)) merged.set(id, row as T);
  }

  return { data: Array.from(merged.values()), error: null };
}

type PhoneConfig = Database["public"]["Tables"]["phone_configs"]["Row"];

const SMS_CAMPAIGN_STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground hover:bg-muted",
  active: "bg-green-100 text-green-700 hover:bg-green-100",
  paused: "bg-amber-100 text-amber-700 hover:bg-amber-100",
  completed: "bg-primary text-primary-foreground hover:bg-primary",
};

const normalizeColumnKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMN_ALIASES = new Map<string, string>([
    ["name", "name"],
    ["firstname", "name"],
    ["fullname", "name"],
    ["customername", "name"],
    ["phone", "phone_number"],
    ["phonenumber", "phone_number"],
    ["mobile", "phone_number"],
    ["number", "phone_number"],
    ["email", "email"],
    ["emailaddress", "email"],
    ["sno", "__row_index"],
    ["srno", "__row_index"],
    ["serialnumber", "__row_index"],
    ["rownumber", "__row_index"],
]);
/** The column a contact field shows under (e.g. "Phone Number" -> phone_number). */
const columnOf = (key: string) => COLUMN_ALIASES.get(normalizeColumnKey(key)) || key;
// Fields every extracted contact carries; shown only when some contact has a value.
const SYSTEM_FIELDS = new Set(["first_name", "age_range", "child_names", "start_date", "end_date", "times", "venue_name", "venue_location"]);

const deriveVisibleSmsColumns = (contacts: Array<Record<string, unknown>>) => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const blockedKeys = new Set(["metadata", "id", "user_id", "campaign_id", "created_at", "updated_at"]);
  const aliasGroups = COLUMN_ALIASES;
  const canonicalChoices = new Map<string, string>();
  const canonicalPriority = new Map<string, string[]>([
    ["name", ["name", "Name", "first_name", "first name", "full_name", "fullName", "customer_name", "customerName"]],
    ["phone_number", ["phone_number", "phone number", "phone", "Phone", "phonenumber", "mobile", "Mobile", "number"]],
    ["email", ["email", "Email", "email_address", "email address"]],
  ]);

  contacts.forEach((contact) => {
    Object.entries(contact).forEach(([key, value]) => {
      if (seen.has(key) || blockedKeys.has(key)) return;
      if (value != null && typeof value === "object") return;

      // Unset (null) system fields stay hidden; a column the user added starts as "" and must still show.
      const hasMeaningfulValue = contacts.some((row) => {
        const candidate = row[key];
        if (candidate == null) return false;
        if (typeof candidate === "object") return false;
        if (typeof candidate === "string" && SYSTEM_FIELDS.has(key)) return candidate.trim() !== "";
        return true;
      });

      if (!hasMeaningfulValue) return;
      seen.add(key);

      const normalized = normalizeColumnKey(key);
      const canonicalKey = aliasGroups.get(normalized) || key;
      if (canonicalKey === "__row_index") return;

      if (!canonicalChoices.has(canonicalKey)) {
        canonicalChoices.set(canonicalKey, key);
        ordered.push(canonicalKey);
        return;
      }

      const currentChoice = canonicalChoices.get(canonicalKey)!;
      const priorityList = canonicalPriority.get(canonicalKey);
      if (!priorityList) return;
      const currentRank = priorityList.indexOf(currentChoice);
      const nextRank = priorityList.indexOf(key);
      if (nextRank !== -1 && (currentRank === -1 || nextRank < currentRank)) {
        canonicalChoices.set(canonicalKey, key);
      }
    });
  });

  const resolvedColumns = ordered.map((canonicalKey) => canonicalChoices.get(canonicalKey) || canonicalKey);
  const priority = ["name", "Name", "first_name", "first name", "email", "Email", "phone_number", "phone number", "phone", "Phone", "mobile", "Mobile", "number"];
  resolvedColumns.sort((a, b) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return resolvedColumns;
};

const formatMessagingFieldLabel = (key: string) =>
  key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const normalizeCustomMessagingFieldKey = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

export default function Campaigns() {
  const location = useLocation();
  const { user, session } = useAuth();
  const { toast } = useToast();
  const [templateDialogOpen, setTemplateDialogOpen] = React.useState(false);
  const [templateName, setTemplateName] = React.useState("");
  const [templateCategory, setTemplateCategory] = React.useState("welcome");
  const [templateMessage, setTemplateMessage] = React.useState("");
  const [linkedTemplateTags, setLinkedTemplateTags] = React.useState<string[]>([]);
  const [editingSmsTemplateId, setEditingSmsTemplateId] = React.useState<string | null>(null);
  const [smsTemplateDeleteTarget, setSmsTemplateDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [deletingSmsTemplate, setDeletingSmsTemplate] = React.useState(false);
  const [smsTemplates, setSmsTemplates] = React.useState<MessagingTemplate[]>([]);
  const [smsCampaigns, setSmsCampaigns] = React.useState<MessagingCampaign[]>([]);
  const [smsCompletedCampaigns, setSmsCompletedCampaigns] = React.useState<MessagingCompletedCampaign[]>([]);
  const [phoneConfigs, setPhoneConfigs] = React.useState<PhoneConfig[]>([]);
  const [selectedSmsTemplateId, setSelectedSmsTemplateId] = React.useState("");
  const [selectedSmsPhoneConfigId, setSelectedSmsPhoneConfigId] = React.useState("");
  const [selectedSmsCampaignId, setSelectedSmsCampaignId] = React.useState<string | null>(null);
  const [selectedSmsCompletedCampaignId, setSelectedSmsCompletedCampaignId] = React.useState<string | null>(null);
  const [selectedSmsContactIndexes, setSelectedSmsContactIndexes] = React.useState<number[]>([]);
  const [editingSmsContactIndex, setEditingSmsContactIndex] = React.useState<number | null>(null);
  const [editingSmsContactFields, setEditingSmsContactFields] = React.useState<Record<string, string>>({});
  const [savingSmsContact, setSavingSmsContact] = React.useState(false);
  const [customSmsContactFieldDialogOpen, setCustomSmsContactFieldDialogOpen] = React.useState(false);
  const [customSmsContactFieldName, setCustomSmsContactFieldName] = React.useState("");
  const [addingCustomSmsContactField, setAddingCustomSmsContactField] = React.useState(false);
  const [selectedSmsCompletedContactDetail, setSelectedSmsCompletedContactDetail] = React.useState<{ index: number; contact: Record<string, unknown> } | null>(null);
  const [selectedSmsCompletedOutcomeDetail, setSelectedSmsCompletedOutcomeDetail] = React.useState<{ index: number; outcome: Record<string, unknown> } | null>(null);
  const [smsCampaignStatusFilter, setSmsCampaignStatusFilter] = React.useState<"all" | "draft" | "active" | "paused" | "completed">("all");
  const [smsCompletedOutcomeSearchTerm, setSmsCompletedOutcomeSearchTerm] = React.useState("");
  const [smsCompletedOutcomeFilter, setSmsCompletedOutcomeFilter] = React.useState("ALL");
  const [smsCompletedCampaignFilter, setSmsCompletedCampaignFilter] = React.useState("ALL");
  const [smsCampaignDeleteTarget, setSmsCampaignDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [smsCompletedDeleteTarget, setSmsCompletedDeleteTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [deletingSmsCampaign, setDeletingSmsCampaign] = React.useState(false);
  const [deletingSmsCompletedCampaign, setDeletingSmsCompletedCampaign] = React.useState(false);
  const [smsCampaignDialogOpen, setSmsCampaignDialogOpen] = React.useState(false);
  const [creatingSmsCampaign, setCreatingSmsCampaign] = React.useState(false);
  const [newSmsCampaignName, setNewSmsCampaignName] = React.useState("");
  const [newSmsCampaignContacts, setNewSmsCampaignContacts] = React.useState<Array<{ name: string; phone: string }>>([{ name: "", phone: "" }]);
  const [startingSmsCampaign, setStartingSmsCampaign] = React.useState(false);
  const [gmailTemplateTo, setGmailTemplateTo] = React.useState(DEFAULT_GMAIL_TEMPLATE.to);
  const [gmailTemplateSubject, setGmailTemplateSubject] = React.useState(DEFAULT_GMAIL_TEMPLATE.subject);
  const [gmailTemplateBody, setGmailTemplateBody] = React.useState(DEFAULT_GMAIL_TEMPLATE.body);
  const [gmailTemplateStorageMode, setGmailTemplateStorageMode] = usePersistentState<"dedicated" | "shared">(
    "campaigns-page-gmail-template-storage-mode",
    "dedicated",
  );
  const [gmailCampaignStorageMode, setGmailCampaignStorageMode] = usePersistentState<"dedicated" | "shared">(
    "campaigns-page-gmail-campaign-storage-mode",
    "dedicated",
  );
  const [gmailCompletedStorageMode, setGmailCompletedStorageMode] = usePersistentState<"dedicated" | "shared">(
    "campaigns-page-gmail-completed-storage-mode",
    "dedicated",
  );
  const [voiceActiveTab, setVoiceActiveTab] = usePersistentState("campaigns-page-active-tab", "data-cleaning");
  const [smsActiveTab, setSmsActiveTab] = usePersistentState("campaigns-page-sms-active-tab", "template");
  const campaignChannel = getVibeSpaceFromPath(location.pathname);
  const isMessagingCampaignSpace = campaignChannel === "sms" || campaignChannel === "whatsapp" || campaignChannel === "gmail";
  const isGmailCampaignSpace = campaignChannel === "gmail";
  const useLocalSmsRoutes = IS_LOCAL_SMS && !isGmailCampaignSpace;
  const templateTable = isGmailCampaignSpace ? "gmail_templates" : "sms_templates";
  const campaignTable = isGmailCampaignSpace ? "gmail_campaigns" : "sms_campaigns";
  const completedCampaignTable = isGmailCampaignSpace ? "gmail_completed_campaigns" : "sms_completed_campaigns";
  const activeTemplateTable = isGmailCampaignSpace && gmailTemplateStorageMode === "shared" ? "sms_templates" : templateTable;
  const activeCampaignTable = isGmailCampaignSpace && gmailCampaignStorageMode === "shared" ? "sms_campaigns" : campaignTable;
  const activeCompletedCampaignTable = isGmailCampaignSpace && gmailCompletedStorageMode === "shared"
    ? "sms_completed_campaigns"
    : completedCampaignTable;
  const messagingLabel = isGmailCampaignSpace ? "Gmail" : campaignChannel === "whatsapp" ? "WhatsApp" : "SMS";
  const campaignTitle = campaignChannel === "sms"
    ? "SMS Campaigns"
    : campaignChannel === "whatsapp"
      ? "WhatsApp Campaigns"
    : campaignChannel === "gmail"
      ? "Email Campaigns"
      : "Voice Campaigns";
  const campaignDescription = campaignChannel === "sms"
    ? "Manage SMS templates, extract contacts, run campaigns, and review completed sends."
    : campaignChannel === "whatsapp"
      ? "Manage WhatsApp templates, extract contacts, run campaigns, and review completed sends."
    : campaignChannel === "gmail"
      ? "Manage Gmail templates, extract contacts, run campaigns, and review completed sends."
      : "Manage campaigns, clean data, track outcomes, and generate retries.";

  const voiceTabs = [
    { value: "data-cleaning", label: "Data Cleaning", icon: FileSpreadsheet },
    { value: "campaigns", label: "Campaigns", icon: Megaphone },
    { value: "outcomes", label: "Outcomes", icon: ClipboardList },
    { value: "retry-csv", label: "Retry CSV", icon: RefreshCw },
  ] as const;

  const smsTabs = [
    { value: "template", label: "Template", icon: FileSpreadsheet },
    { value: "data-extract", label: "Data Extract", icon: FileSpreadsheet },
    { value: "campaigns", label: "Campaigns", icon: Megaphone },
    { value: "completed", label: "Completed", icon: ClipboardList },
  ] as const;

  const smsTemplateTags = ["VIP Exclusive Offer"];
  const smsLength = templateMessage.length;
  const smsSegments = Math.max(1, Math.ceil(Math.max(smsLength, 1) / 160));
  const selectedSmsTemplate = smsTemplates.find((template) => template.id === selectedSmsTemplateId) || null;
  const selectedSmsCampaign = smsCampaigns.find((campaign) => campaign.id === selectedSmsCampaignId) || null;
  const selectedSmsCompletedCampaign = smsCompletedCampaigns.find((campaign) => campaign.id === selectedSmsCompletedCampaignId) || null;
  const selectedSmsCampaignTemplate = smsTemplates.find((template) => template.id === selectedSmsCampaign?.template_id) || null;
  const selectedSmsCampaignContacts = Array.isArray(selectedSmsCampaign?.extracted_contacts)
    ? selectedSmsCampaign.extracted_contacts
    : [];
  const selectedSmsCompletedCampaignContacts = Array.isArray(selectedSmsCompletedCampaign?.selected_contacts)
    ? selectedSmsCompletedCampaign.selected_contacts
    : [];
  const selectedSmsCompletedCampaignOutcomes = Array.isArray(selectedSmsCompletedCampaign?.outcomes)
    ? selectedSmsCompletedCampaign.outcomes
    : [];
  const smsCampaignCards = React.useMemo(
    () => smsCampaigns,
    [smsCampaigns],
  );
  const filteredSmsCampaignCards = React.useMemo(
    () => smsCampaignStatusFilter === "all"
      ? smsCampaignCards
      : smsCampaignCards.filter((campaign) => String(campaign.status || "draft").toLowerCase() === smsCampaignStatusFilter),
    [smsCampaignCards, smsCampaignStatusFilter],
  );
  const gmailDetectedPlaceholders = React.useMemo(
    () => extractPlaceholders(`${gmailTemplateTo}\n${gmailTemplateSubject}\n${gmailTemplateBody}`),
    [gmailTemplateBody, gmailTemplateSubject, gmailTemplateTo],
  );

  const smsTemplateMap = React.useMemo(
    () => new Map(smsTemplates.map((template) => [template.id, template])),
    [smsTemplates],
  );
  const smsPhoneConfigs = React.useMemo(
    () => phoneConfigs.filter((config) => config.provider === "telnyx" && config.channel === "sms"),
    [phoneConfigs],
  );
  const selectedSmsPhoneConfig = React.useMemo(
    () => smsPhoneConfigs.find((config) => config.id === selectedSmsPhoneConfigId) || null,
    [smsPhoneConfigs, selectedSmsPhoneConfigId],
  );
  const smsContactColumns = React.useMemo(
    () => deriveVisibleSmsColumns(selectedSmsCampaignContacts),
    [selectedSmsCampaignContacts],
  );
  const selectedSmsRecipients = React.useMemo(
    () => selectedSmsContactIndexes
      .map((index) => selectedSmsCampaignContacts[index])
      .filter(Boolean) as Array<Record<string, unknown>>,
    [selectedSmsCampaignContacts, selectedSmsContactIndexes],
  );
  const selectedSmsRecipientsIncludeIndia = React.useMemo(
    () => selectedSmsRecipients.some((contact) => {
      const values = Object.values(contact || {});
      return values.some((value) => typeof value === "string" && value.replace(/\D/g, "").startsWith("91"));
    }),
    [selectedSmsRecipients],
  );
  const smsCompletedContactColumns = React.useMemo(
    () => deriveVisibleSmsColumns(selectedSmsCompletedCampaignContacts),
    [selectedSmsCompletedCampaignContacts],
  );
  const selectedSmsCompletedContactEntries = React.useMemo(
    () => selectedSmsCompletedContactDetail ? Object.entries(selectedSmsCompletedContactDetail.contact).filter(([_, value]) => value != null && typeof value !== "object" && String(value).trim() !== "") : [],
    [selectedSmsCompletedContactDetail],
  );
  const selectedSmsCompletedOutcomeEntries = React.useMemo(
    () => selectedSmsCompletedOutcomeDetail ? Object.entries(selectedSmsCompletedOutcomeDetail.outcome).filter(([_, value]) => value != null && typeof value !== "object" && String(value).trim() !== "") : [],
    [selectedSmsCompletedOutcomeDetail],
  );

  const filteredSmsCompletedCampaignOutcomes = React.useMemo(() => {
    const term = smsCompletedOutcomeSearchTerm.trim().toLowerCase();
    return selectedSmsCompletedCampaignOutcomes.filter((outcome) => {
      const status = typeof outcome.status === "string" ? outcome.status.toLowerCase() : "unknown";
      if (smsCompletedOutcomeFilter !== "ALL" && status !== smsCompletedOutcomeFilter.toLowerCase()) return false;
      if (!term) return true;
      const haystacks = [
        typeof outcome.recipient_number === "string" ? outcome.recipient_number : "",
        typeof outcome.rendered_message === "string" ? outcome.rendered_message : "",
        typeof outcome.error === "string" ? outcome.error : "",
        typeof outcome.provider_message_id === "string" ? outcome.provider_message_id : "",
        typeof outcome.status === "string" ? outcome.status : "",
      ];
      return haystacks.some((value) => value.toLowerCase().includes(term));
    });
  }, [selectedSmsCompletedCampaignOutcomes, smsCompletedOutcomeFilter, smsCompletedOutcomeSearchTerm]);

  const normalizeSmsOutcomeStatus = React.useCallback((value: unknown) => {
    const status = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!status) return "unknown";
    if (["sent", "delivered"].includes(status)) return "sent";
    if (["rejected", "reject", "undelivered"].includes(status)) return "rejected";
    if (["failed", "failure", "error"].includes(status)) return "failed";
    if (["queued", "queue", "pending", "accepted", "sending", "scheduled"].includes(status)) return "queued";
    return status;
  }, []);

  const filteredSmsCompletedCampaignCards = React.useMemo(() => {
    if (smsCompletedCampaignFilter === "ALL") return smsCompletedCampaigns;

    return smsCompletedCampaigns.filter((campaign) => {
      const outcomes = Array.isArray(campaign.outcomes) ? campaign.outcomes : [];
      if (!outcomes.length) return false;
      return outcomes.some((outcome) => normalizeSmsOutcomeStatus(outcome?.status) === smsCompletedCampaignFilter);
    });
  }, [normalizeSmsOutcomeStatus, smsCompletedCampaignFilter, smsCompletedCampaigns]);

  const getContactValue = React.useCallback((contact: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const value = contact[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }, []);

  const getSmsContactTitle = React.useCallback((contact: Record<string, unknown>, index: number) => {
    return (
      getContactValue(contact, ["name", "Name", "full_name", "fullName", "customer_name", "customerName"]) ||
      getContactValue(contact, ["phone", "Phone", "mobile", "Mobile", "number"]) ||
      getContactValue(contact, ["email", "Email"]) ||
      `Contact ${index + 1}`
    );
  }, [getContactValue]);

  const getSmsContactMeta = React.useCallback((contact: Record<string, unknown>) => {
    const phone = getContactValue(contact, ["phone", "Phone", "mobile", "Mobile", "number"]);
    const email = getContactValue(contact, ["email", "Email"]);
    return [phone, email].filter(Boolean).join(" • ");
  }, [getContactValue]);

  const formatSmsPhoneDisplay = React.useCallback((value: unknown) => {
    const raw = String(value ?? "").trim();
    if (!raw) return "—";
    const digits = raw.replace(/\D/g, "");
    if (!digits) return raw;
    return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
  }, []);

  const openSmsContactEditor = React.useCallback((contact: Record<string, unknown>, index: number) => {
    const blockedKeys = new Set(["metadata", "id", "user_id", "campaign_id", "created_at", "updated_at", "row_number", "row number", "s.no", "s_no", "sno"]);
    const initialFields = Object.entries(contact)
      .filter(([key, value]) => !blockedKeys.has(key) && (value == null || typeof value !== "object"))
      .reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = value == null ? "" : String(value);
        return acc;
      }, {});

    if (!Object.keys(initialFields).length) {
      initialFields.name = "";
      initialFields.email = "";
      initialFields.phone_number = "";
    }

    setEditingSmsContactIndex(index);
    setEditingSmsContactFields(initialFields);
  }, [formatSmsPhoneDisplay, getContactValue]);

  const updateSmsCampaignInState = React.useCallback((campaignId: string, updater: (campaign: MessagingCampaign) => MessagingCampaign) => {
    setSmsCampaigns((current) => current.map((campaign) => (
      campaign.id === campaignId ? updater(campaign) : campaign
    )));
  }, []);

  const addSmsContactColumn = React.useCallback(async () => {
    if (!selectedSmsCampaign) return;

    const rawName = customSmsContactFieldName.trim();
    const fieldKey = normalizeCustomMessagingFieldKey(rawName);

    if (!rawName || !fieldKey) {
      toast({ title: "Invalid column name", description: "Enter a valid column name.", variant: "destructive" });
      return;
    }

    if (smsContactColumns.some((column) => normalizeColumnKey(column) === normalizeColumnKey(fieldKey))) {
      toast({ title: "Column already exists", description: "Use a different column name.", variant: "destructive" });
      return;
    }

    const contacts = selectedSmsCampaignContacts.map((contact) => (
      fieldKey in contact ? contact : { ...contact, [fieldKey]: "" }
    ));

    setAddingCustomSmsContactField(true);
    const { error } = await supabase
      .from(activeCampaignTable as any)
      .update({
        extracted_contacts: contacts,
        total_contacts: contacts.length,
      })
      .eq("id", selectedSmsCampaign.id);
    setAddingCustomSmsContactField(false);

    if (error) {
      toast({ title: "Failed to add column", description: error.message, variant: "destructive" });
      return;
    }

    updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({
      ...campaign,
      extracted_contacts: contacts,
      total_contacts: contacts.length,
    }));
    setCustomSmsContactFieldDialogOpen(false);
    setCustomSmsContactFieldName("");
    toast({ title: "Column added" });
  }, [
    activeCampaignTable,
    customSmsContactFieldName,
    selectedSmsCampaign,
    selectedSmsCampaignContacts,
    smsContactColumns,
    toast,
    updateSmsCampaignInState,
  ]);

  /** Remove a column (every field that shows under it) from all of this campaign's contacts. */
  const deleteSmsContactColumn = React.useCallback(async (column: string) => {
    if (!selectedSmsCampaign) return;
    if (!window.confirm(`Delete the "${column.replace(/_/g, " ")}" column from every contact?`)) return;
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => columnOf(k) !== column));
    const contacts = selectedSmsCampaignContacts.map((c) => {
      const next = strip(c);
      if (c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)) next.metadata = strip(c.metadata as Record<string, unknown>);
      return next;
    });
    const { error } = await supabase.from(activeCampaignTable as any).update({ extracted_contacts: contacts }).eq("id", selectedSmsCampaign.id);
    if (error) return toast({ title: "Couldn't delete the column", description: error.message, variant: "destructive" });
    updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({ ...campaign, extracted_contacts: contacts }));
    toast({ title: "Column deleted" });
  }, [activeCampaignTable, selectedSmsCampaign, selectedSmsCampaignContacts, toast, updateSmsCampaignInState]);

  const deleteSmsContact = React.useCallback(async (index: number) => {
    if (!selectedSmsCampaign) return;

    const contacts = selectedSmsCampaignContacts.filter((_, contactIndex) => contactIndex !== index);

    const { error } = await supabase
      .from(activeCampaignTable as any)
      .update({
        extracted_contacts: contacts,
        total_contacts: contacts.length,
      })
      .eq("id", selectedSmsCampaign.id);

    if (error) {
      toast({ title: "Failed to delete contact", description: error.message, variant: "destructive" });
      return;
    }

    updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({
      ...campaign,
      extracted_contacts: contacts,
      total_contacts: contacts.length,
    }));
    setSelectedSmsContactIndexes((current) => current
      .filter((contactIndex) => contactIndex !== index)
      .map((contactIndex) => (contactIndex > index ? contactIndex - 1 : contactIndex)));
    toast({ title: "Contact deleted" });
  }, [
    activeCampaignTable,
    selectedSmsCampaign,
    selectedSmsCampaignContacts,
    toast,
    updateSmsCampaignInState,
  ]);

  const openSmsCampaign = React.useCallback((campaign: MessagingCampaign) => {
    setSelectedSmsCompletedCampaignId(null);
    setSelectedSmsCampaignId(campaign.id);
    setSelectedSmsTemplateId(campaign.template_id || "");
    setSelectedSmsContactIndexes(campaign.extracted_contacts.map((_, index) => index));
  }, []);
  const resetNewSmsCampaignForm = React.useCallback(() => {
    setNewSmsCampaignName("");
    setNewSmsCampaignContacts([{ name: "", phone: "" }]);
  }, []);

  const updateNewSmsCampaignContact = React.useCallback((index: number, field: "name" | "phone", value: string) => {
    setNewSmsCampaignContacts((current) => current.map((contact, contactIndex) => (
      contactIndex === index ? { ...contact, [field]: value } : contact
    )));
  }, []);

  const addNewSmsCampaignContact = React.useCallback(() => {
    setNewSmsCampaignContacts((current) => [...current, { name: "", phone: "" }]);
  }, []);

  const removeNewSmsCampaignContact = React.useCallback((index: number) => {
    setNewSmsCampaignContacts((current) => current.length === 1 ? current : current.filter((_, contactIndex) => contactIndex !== index));
  }, []);

  const createSmsCampaign = async () => {
    if (!user || !user.email) return;

    const name = newSmsCampaignName.trim();
    const contacts = newSmsCampaignContacts
      .map((contact) => ({
        name: contact.name.trim(),
        phone: formatSmsPhoneDisplay(contact.phone) === "—" ? "" : formatSmsPhoneDisplay(contact.phone),
      }))
      .filter((contact) => contact.name || contact.phone);

    if (!name) {
      toast({ title: "Campaign name required", description: "Enter a campaign name to continue.", variant: "destructive" });
      return;
    }

    if (!contacts.length) {
      toast({ title: "Add at least one contact", description: "Add a name and phone number before saving.", variant: "destructive" });
      return;
    }

    const invalidContact = contacts.find((contact) => !contact.name || !contact.phone || contact.phone === "—");
    if (invalidContact) {
      toast({ title: "Complete all contact fields", description: "Each contact needs both a name and phone number.", variant: "destructive" });
      return;
    }

    const extractedContacts = contacts.map((contact, index) => ({
      id: crypto.randomUUID(),
      "first name": contact.name,
      "phone number": contact.phone,
      metadata: isGmailCampaignSpace ? { [GMAIL_CHANNEL_MARKER]: "gmail" } : undefined,
      row_number: index + 1,
    }));

    setCreatingSmsCampaign(true);
    const payload = {
      user_id: user.id,
      user_email: user.email,
      name,
      status: "draft",
      total_contacts: extractedContacts.length,
      extracted_contacts: extractedContacts,
    };
    let { data, error } = await supabase
      .from(activeCampaignTable as any)
      .insert(payload)
      .select()
      .single();

    if (isGmailCampaignSpace && gmailCampaignStorageMode === "dedicated" && error && isMissingTableError(error.message)) {
      setGmailCampaignStorageMode("shared");
      const fallbackResult = await supabase
        .from("sms_campaigns" as any)
        .insert(payload)
        .select()
        .single();
      data = fallbackResult.data;
      error = fallbackResult.error;
    }
    setCreatingSmsCampaign(false);

    if (error || !data) {
      toast({ title: `Failed to create ${messagingLabel} campaign`, description: error?.message || "Please try again.", variant: "destructive" });
      return;
    }

    const rawCampaign = data as unknown as Record<string, unknown>;
    const createdCampaign: MessagingCampaign = {
      ...(rawCampaign as unknown as MessagingCampaign),
      extracted_contacts: Array.isArray(rawCampaign.extracted_contacts)
        ? (rawCampaign.extracted_contacts as Array<Record<string, unknown>>)
        : [],
    };

    setSmsCampaigns((current) => [createdCampaign, ...current.filter((campaign) => campaign.id !== createdCampaign.id)]);
    setSmsCampaignDialogOpen(false);
    resetNewSmsCampaignForm();
    openSmsCampaign(createdCampaign);
    setSmsActiveTab("campaigns");
    toast({ title: `${messagingLabel} campaign created` });
  };


  const confirmDeleteSmsCampaign = async () => {
    if (!smsCampaignDeleteTarget) return;
    setDeletingSmsCampaign(true);

    const { error } = await supabase
      .from(activeCampaignTable as any)
      .delete()
      .eq("id", smsCampaignDeleteTarget.id);

    setDeletingSmsCampaign(false);

    if (error) {
      toast({
        title: "Failed to delete campaign",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setSmsCampaigns((current) => current.filter((campaign) => campaign.id !== smsCampaignDeleteTarget.id));
    if (selectedSmsCampaignId === smsCampaignDeleteTarget.id) {
      setSelectedSmsCampaignId(null);
      setSelectedSmsContactIndexes([]);
    }
    toast({ title: "Campaign deleted" });
    setSmsCampaignDeleteTarget(null);
  };

  const openSmsCompletedCampaign = React.useCallback((campaign: MessagingCompletedCampaign) => {
    setSelectedSmsCampaignId(null);
    setSelectedSmsCompletedCampaignId(campaign.id);
  }, []);

  const confirmDeleteSmsCompletedCampaign = async () => {
    if (!smsCompletedDeleteTarget) return;
    setDeletingSmsCompletedCampaign(true);

    let { error } = await supabase
      .from(activeCompletedCampaignTable as any)
      .delete()
      .eq("id", smsCompletedDeleteTarget.id);

    if (
      isGmailCampaignSpace &&
      gmailCompletedStorageMode === "dedicated" &&
      error &&
      isMissingTableError(error.message)
    ) {
      setGmailCompletedStorageMode("shared");
      const fallbackResult = await supabase
        .from("sms_completed_campaigns" as any)
        .delete()
        .eq("id", smsCompletedDeleteTarget.id);
      error = fallbackResult.error;
    }

    setDeletingSmsCompletedCampaign(false);

    if (error) {
      toast({
        title: "Failed to delete completed campaign",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setSmsCompletedCampaigns((current) => current.filter((campaign) => campaign.id !== smsCompletedDeleteTarget.id));
    if (selectedSmsCompletedCampaignId === smsCompletedDeleteTarget.id) {
      setSelectedSmsCompletedCampaignId(null);
    }
    toast({ title: "Completed campaign deleted" });
    setSmsCompletedDeleteTarget(null);
  };

  React.useEffect(() => {
    let cancelled = false;

    const loadSmsData = async () => {
      if (!user) {
        if (!cancelled) {
          setSmsCampaigns([]);
          setSmsCompletedCampaigns([]);
          setSmsTemplates([]);
        }
        return;
      }

      if (useLocalSmsRoutes) {
        try {
          let payload: any = null;
          const accessToken = session?.access_token || (await supabase.auth.getSession()).data.session?.access_token || "";

          try {
            const invokeResult = await supabase.functions.invoke("sms-campaign-data", {
              headers: accessToken
                ? {
                    Authorization: `Bearer ${accessToken}`,
                  }
                : undefined,
              body: { action: "load" },
            });

            if (invokeResult.error) {
              if (!isEdgeFunctionUnavailable(invokeResult.error)) {
                throw new Error(getErrorMessage(invokeResult.error) || "Failed to load SMS campaign data");
              }
            } else {
              payload = invokeResult.data;
            }
          } catch (edgeError) {
            if (!(edgeError instanceof Error) || !isEdgeFunctionUnavailable(edgeError)) {
              throw edgeError;
            }
          }

          if (!payload) {
            const response = await fetch("/api/local/sms-campaign-data", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: user.id, userEmail: user.email }),
            });
            payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(String(payload?.error || `HTTP ${response.status}`));
          }

          if (!cancelled) {
            const rawCampaigns = (Array.isArray(payload?.campaigns) ? payload.campaigns : []).map((campaign: MessagingCampaign) => ({
              ...campaign,
              extracted_contacts: Array.isArray(campaign.extracted_contacts) ? (campaign.extracted_contacts as Array<Record<string, unknown>>) : [],
            }));
            const rawCompleted = (Array.isArray(payload?.completed) ? payload.completed : []).map((campaign: MessagingCompletedCampaign) => ({
              ...campaign,
              selected_contacts: Array.isArray(campaign.selected_contacts) ? (campaign.selected_contacts as Array<Record<string, unknown>>) : [],
              outcomes: Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [],
            }));
            const rawTemplates = (Array.isArray(payload?.templates) ? payload.templates : []).map((template: MessagingTemplate) => ({
              ...template,
              linked_tags: Array.isArray(template.linked_tags) ? template.linked_tags : [],
            }));

            const campaigns = isGmailCampaignSpace
              ? rawCampaigns.filter(isGmailFallbackCampaign)
              : rawCampaigns.filter((campaign) => !isGmailFallbackCampaign(campaign));
            const completed = isGmailCampaignSpace
              ? rawCompleted.filter(isGmailFallbackCompletedCampaign)
              : rawCompleted.filter((campaign) => !isGmailFallbackCompletedCampaign(campaign));
            const templates = isGmailCampaignSpace
              ? rawTemplates.filter(isGmailFallbackTemplate)
              : rawTemplates.filter((template) => !isGmailFallbackTemplate(template));

            setSmsCampaigns(campaigns);
            setSmsCompletedCampaigns(completed);
            setSmsTemplates(templates);
            setSelectedSmsCampaignId((current) => (current && campaigns.some((campaign: MessagingCampaign) => campaign.id === current) ? current : null));
            setSelectedSmsCompletedCampaignId((current) => (current && completed.some((campaign: MessagingCompletedCampaign) => campaign.id === current) ? current : null));
            setSelectedSmsTemplateId((current) => (current && templates.some((template: MessagingTemplate) => template.id === current) ? current : (templates[0]?.id || "")));
          }
          return;
        } catch (error) {
          console.error("Failed to load SMS data via local route", error);
        }
      }

      let completedRows;
      if (isGmailCampaignSpace) {
        if (gmailCompletedStorageMode === "shared") {
          const sharedRows = await loadRowsByUserOrEmail<MessagingCompletedCampaign>("sms_completed_campaigns", "*", user.id, user.email);
          completedRows = sharedRows.error
            ? sharedRows
            : {
                data: ((sharedRows.data as MessagingCompletedCampaign[] | null) || []).filter(isGmailFallbackCompletedCampaign),
                error: null,
              };
        } else {
          const gmailRows = await loadRowsByUserOrEmail<MessagingCompletedCampaign>(completedCampaignTable, "*", user.id, user.email);

          if (gmailRows.error && isMissingTableError(gmailRows.error.message)) {
            setGmailCompletedStorageMode("shared");
            const sharedRows = await loadRowsByUserOrEmail<MessagingCompletedCampaign>("sms_completed_campaigns", "*", user.id, user.email);
            completedRows = sharedRows.error
              ? sharedRows
              : {
                  data: ((sharedRows.data as MessagingCompletedCampaign[] | null) || []).filter(isGmailFallbackCompletedCampaign),
                  error: null,
                };
          } else {
            setGmailCompletedStorageMode("dedicated");
            completedRows = gmailRows;
          }
        }
      } else {
        const smsRows = await loadRowsByUserOrEmail<MessagingCompletedCampaign>(completedCampaignTable, "*", user.id, user.email);
        completedRows = smsRows.error
          ? smsRows
          : {
              data: ((smsRows.data as MessagingCompletedCampaign[] | null) || []).filter(
                (campaign) => !isGmailFallbackCompletedCampaign(campaign),
              ),
              error: null,
            };
      }

      let campaignRows;
      if (isGmailCampaignSpace) {
        // Email campaigns live in gmail_campaigns, older ones in sms_campaigns (marked gmail): always read both,
        // so a stale "shared" mode remembered in this browser can't hide new campaigns.
        const [gmailRows, sharedRows] = await Promise.all([
          loadRowsByUserOrEmail<MessagingCampaign>(campaignTable, "*", user.id, user.email),
          loadRowsByUserOrEmail<MessagingCampaign>("sms_campaigns", "*", user.id, user.email),
        ]);
        const dedicatedOk = !(gmailRows.error && isMissingTableError(gmailRows.error.message));
        setGmailCampaignStorageMode(dedicatedOk ? "dedicated" : "shared");
        const merged = [
          ...(dedicatedOk ? ((gmailRows.data as MessagingCampaign[] | null) || []) : []),
          ...(((sharedRows.data as MessagingCampaign[] | null) || []).filter(isGmailFallbackCampaign)),
        ];
        campaignRows = dedicatedOk && gmailRows.error
          ? gmailRows
          : { data: merged.filter((c, i) => merged.findIndex((x) => x.id === c.id) === i), error: null };
      } else {
        const smsRows = await loadRowsByUserOrEmail<MessagingCampaign>(campaignTable, "*", user.id, user.email);
        campaignRows = smsRows.error
          ? smsRows
          : {
              data: ((smsRows.data as MessagingCampaign[] | null) || []).filter((campaign) => !isGmailFallbackCampaign(campaign)),
              error: null,
            };
      }

      let templateRows;
      if (isGmailCampaignSpace) {
        if (gmailTemplateStorageMode === "shared") {
          const sharedRows = await loadRowsByUserOrEmail<MessagingTemplate>(
            "sms_templates",
            "id,user_id,user_email,name,category,message,linked_tags,created_at",
            user.id,
            user.email,
          );
          templateRows = sharedRows.error
            ? sharedRows
            : {
                data: ((sharedRows.data as MessagingTemplate[] | null) || []).filter(isGmailFallbackTemplate),
                error: null,
              };
        } else {
          const gmailRows = await loadRowsByUserOrEmail<MessagingTemplate>(
            templateTable,
            "id,user_id,user_email,name,category,message,linked_tags,created_at",
            user.id,
            user.email,
          );

          if (gmailRows.error && isMissingTableError(gmailRows.error.message)) {
            setGmailTemplateStorageMode("shared");
            const sharedRows = await loadRowsByUserOrEmail<MessagingTemplate>(
              "sms_templates",
              "id,user_id,user_email,name,category,message,linked_tags,created_at",
              user.id,
              user.email,
            );
            templateRows = sharedRows.error
              ? sharedRows
              : {
                  data: ((sharedRows.data as MessagingTemplate[] | null) || []).filter(isGmailFallbackTemplate),
                  error: null,
                };
          } else {
            setGmailTemplateStorageMode("dedicated");
            templateRows = gmailRows;
          }
        }
      } else {
        const smsRows = await loadRowsByUserOrEmail<MessagingTemplate>(
          templateTable,
          "id,user_id,user_email,name,category,message,linked_tags,created_at",
          user.id,
          user.email,
        );
        templateRows = smsRows.error
          ? smsRows
          : {
              data: ((smsRows.data as MessagingTemplate[] | null) || []).filter((template) => !isGmailFallbackTemplate(template)),
              error: null,
            };
      }

      if (!cancelled) {
        if (campaignRows.error) {
          console.error(`Failed to load ${messagingLabel} campaigns`, campaignRows.error);
          setSmsCampaigns([]);
        } else {
          const campaigns = ((campaignRows.data as MessagingCampaign[] | null) || []).map((campaign) => ({
            ...campaign,
            extracted_contacts: Array.isArray(campaign.extracted_contacts) ? (campaign.extracted_contacts as Array<Record<string, unknown>>) : [],
          }));
          setSmsCampaigns(campaigns);
          setSelectedSmsCampaignId((current) => (current && campaigns.some((campaign) => campaign.id === current) ? current : null));
        }

        if (completedRows.error) {
          console.error(`Failed to load ${messagingLabel} completed campaigns`, completedRows.error);
          setSmsCompletedCampaigns([]);
        } else {
          const completed = ((completedRows.data as MessagingCompletedCampaign[] | null) || []).map((campaign) => ({
            ...campaign,
            selected_contacts: Array.isArray(campaign.selected_contacts) ? (campaign.selected_contacts as Array<Record<string, unknown>>) : [],
            outcomes: Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [],
          }));
          setSmsCompletedCampaigns(completed);
          setSelectedSmsCompletedCampaignId((current) => (current && completed.some((campaign) => campaign.id === current) ? current : null));
        }

        if (templateRows.error) {
          console.error(`Failed to load ${messagingLabel} templates`, templateRows.error);
          setSmsTemplates([]);
        } else {
          const templates = ((templateRows.data as MessagingTemplate[] | null) || []).map((template) => ({
            ...template,
            linked_tags: Array.isArray(template.linked_tags) ? template.linked_tags : [],
          }));
          setSmsTemplates(templates);
          setSelectedSmsTemplateId((current) => {
            if (current && templates.some((template) => template.id === current)) return current;
            return templates[0]?.id || "";
          });
        }
      }
    };

    void loadSmsData();
    return () => {
      cancelled = true;
    };
  }, [
    user,
    useLocalSmsRoutes,
    campaignTable,
    completedCampaignTable,
    templateTable,
    messagingLabel,
    isGmailCampaignSpace,
    gmailCampaignStorageMode,
    gmailCompletedStorageMode,
    gmailTemplateStorageMode,
  ]);

  React.useEffect(() => {
    let cancelled = false;

    const loadPhoneConfigs = async () => {
      if (!user) {
        if (!cancelled) setPhoneConfigs([]);
        return;
      }

      if (useLocalSmsRoutes) {
        try {
          const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
          const { data, error } = await supabase.functions.invoke("voice-space-data", {
            body: { userId: user.id, userEmail: user.email || "" },
            headers: accessToken
              ? {
                  Authorization: `Bearer ${accessToken}`,
                }
              : undefined,
          });
          if (error) throw error;

          if (!cancelled) {
            setPhoneConfigs(Array.isArray((data as any)?.phoneConfigs) ? (data as any).phoneConfigs : []);
          }
          return;
        } catch (error) {
          console.error("Failed to load phone configs via edge function", error);
        }
      }

      const { data, error } = await supabase
        .from("phone_configs")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to load phone configs", error);
        if (!cancelled) setPhoneConfigs([]);
        return;
      }

      if (!cancelled) setPhoneConfigs((data as PhoneConfig[] | null) || []);
    };

    void loadPhoneConfigs();
    return () => {
      cancelled = true;
    };
  }, [user, useLocalSmsRoutes]);

  React.useEffect(() => {
    setSelectedSmsPhoneConfigId((current) => {
      const next = current && smsPhoneConfigs.some((config) => config.id === current)
        ? current
        : (smsPhoneConfigs[0]?.id || "");
      return next === current ? current : next;
    });
  }, [smsPhoneConfigs]);

  React.useEffect(() => {
    if (!selectedSmsCampaign) {
      setSelectedSmsContactIndexes((current) => (current.length ? [] : current));
      return;
    }

    setSelectedSmsContactIndexes((current) => {
      const fallback = selectedSmsCampaignContacts.map((_, index) => index);
      const next = !current.length
        ? fallback
        : (() => {
            const validIndexes = current.filter((index) => index >= 0 && index < selectedSmsCampaignContacts.length);
            return validIndexes.length ? validIndexes : fallback;
          })();

      if (next.length === current.length && next.every((value, index) => value === current[index])) {
        return current;
      }
      return next;
    });
  }, [selectedSmsCampaign, selectedSmsCampaignContacts]);

  const toggleSmsTemplateTag = (tag: string) => {
    setLinkedTemplateTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  };

  const resetSmsTemplateForm = () => {
    setEditingSmsTemplateId(null);
    setTemplateName("");
    setTemplateCategory("welcome");
    setTemplateMessage("");
    setLinkedTemplateTags([]);
    setGmailTemplateTo(DEFAULT_GMAIL_TEMPLATE.to);
    setGmailTemplateSubject(DEFAULT_GMAIL_TEMPLATE.subject);
    setGmailTemplateBody(DEFAULT_GMAIL_TEMPLATE.body);
  };

  const openEditSmsTemplate = (template: MessagingTemplate) => {
    setEditingSmsTemplateId(template.id);
    setTemplateName(template.name);
    if (isGmailCampaignSpace) {
      const parsed = parseEmailTemplateConfig(template.message);
      setTemplateCategory("email");
      setTemplateMessage(template.message);
      setLinkedTemplateTags([]);
      setGmailTemplateTo(parsed.to);
      setGmailTemplateSubject(parsed.subject);
      setGmailTemplateBody(parsed.body);
    } else {
      setTemplateCategory(template.category);
      setTemplateMessage(template.message);
      setLinkedTemplateTags(Array.isArray(template.linked_tags) ? template.linked_tags : []);
    }
    setTemplateDialogOpen(true);
  };

  const confirmDeleteSmsTemplate = async () => {
    if (!smsTemplateDeleteTarget) return;
    setDeletingSmsTemplate(true);

    const { error } = await supabase
      .from(activeTemplateTable as any)
      .delete()
      .eq("id", smsTemplateDeleteTarget.id);

    setDeletingSmsTemplate(false);

    if (error) {
      toast({
        title: "Failed to delete template",
        description: error.message,
        variant: "destructive",
      });
      return;
    }

    setSmsTemplates((current) => current.filter((template) => template.id !== smsTemplateDeleteTarget.id));
    if (selectedSmsTemplateId === smsTemplateDeleteTarget.id) {
      setSelectedSmsTemplateId("");
    }
    if (editingSmsTemplateId === smsTemplateDeleteTarget.id) {
      resetSmsTemplateForm();
      setTemplateDialogOpen(false);
    }
    toast({ title: "Template deleted" });
    setSmsTemplateDeleteTarget(null);
  };

  const toggleSmsCampaignContact = (index: number) => {
    setSelectedSmsContactIndexes((current) => (
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b)
    ));
  };

  const saveSmsContactEdit = async () => {
    if (!selectedSmsCampaign || editingSmsContactIndex == null) return;

    const contacts = [...selectedSmsCampaignContacts];
    const currentContact = { ...(contacts[editingSmsContactIndex] || {}) };
    Object.entries(editingSmsContactFields).forEach(([key, value]) => {
      const normalized = /phone|mobile|number/i.test(key)
        ? (() => {
            const digits = String(value).replace(/\D/g, "");
            return digits ? `+${digits}` : "";
          })()
        : value.trim();

      currentContact[key] = normalized;
    });

    if (currentContact.metadata && typeof currentContact.metadata === "object" && !Array.isArray(currentContact.metadata)) {
      currentContact.metadata = {
        ...(currentContact.metadata as Record<string, unknown>),
        ...Object.fromEntries(
          Object.entries(editingSmsContactFields).map(([key, value]) => {
            const normalized = /phone|mobile|number/i.test(key)
              ? (() => {
                  const digits = String(value).replace(/\D/g, "");
                  return digits ? `+${digits}` : "";
                })()
              : value.trim();
            return [key, normalized];
          }),
        ),
      };
    }
    contacts[editingSmsContactIndex] = currentContact;

    setSavingSmsContact(true);
    const { error } = await supabase
      .from(activeCampaignTable as any)
      .update({ extracted_contacts: contacts })
      .eq("id", selectedSmsCampaign.id);
    setSavingSmsContact(false);

    if (error) {
      toast({ title: "Failed to update contact", description: error.message, variant: "destructive" });
      return;
    }

    updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({
      ...campaign,
      extracted_contacts: contacts,
    }));
    toast({ title: "Contact updated" });
    setEditingSmsContactIndex(null);
    setEditingSmsContactFields({});
  };

  const handleSmsCampaignTemplateChange = async (campaignId: string, templateId: string) => {
    const nextTemplateId = templateId === "__none__" ? null : templateId;

    const { error } = await supabase
      .from(activeCampaignTable as any)
      .update({ template_id: nextTemplateId })
      .eq("id", campaignId);

    if (error) {
      console.error("Failed to update SMS campaign template", error);
      return;
    }

    updateSmsCampaignInState(campaignId, (campaign) => ({
      ...campaign,
      template_id: nextTemplateId,
    }));
    setSelectedSmsTemplateId(nextTemplateId || "");
  };

  const startSmsCampaign = async () => {
    if (isGmailCampaignSpace) {
      if (!selectedSmsCampaign || !selectedSmsTemplateId || !selectedSmsContactIndexes.length) return;

      const accessToken = session?.access_token || (await supabase.auth.getSession()).data.session?.access_token;
      if (!accessToken) {
        toast({
          title: "Gmail campaign failed",
          description: "You are not authenticated. Please sign in again and retry.",
          variant: "destructive",
        });
        return;
      }

      setStartingSmsCampaign(true);
      let data: any = null;
      let error: { message?: string } | null = null;
      const payload = {
        campaign_id: selectedSmsCampaign.id,
        template_id: selectedSmsTemplateId,
        selected_contact_indexes: [...selectedSmsContactIndexes].sort((a, b) => a - b),
      };

      try {
        const invokeResult = await supabase.functions.invoke("run-gmail-campaign", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: payload,
        });
        data = invokeResult.data;
        error = invokeResult.error ? { message: getErrorMessage(invokeResult.error) } : null;
      } catch (edgeError) {
        error = { message: getErrorMessage(edgeError) };
      }

      setStartingSmsCampaign(false);

      if (error || data?.error) {
        const description = String(data?.error || error?.message || "Failed to start Gmail campaign");
        console.error("Failed to start Gmail campaign", error || data?.error);
        toast({
          title: "Gmail campaign failed",
          description,
          variant: "destructive",
        });
        return;
      }

      const completedCampaignRaw = data?.completed_campaign as MessagingCompletedCampaign | undefined;
      if (completedCampaignRaw) {
        const completedCampaign: MessagingCompletedCampaign = {
          ...completedCampaignRaw,
          selected_contacts: Array.isArray(completedCampaignRaw.selected_contacts)
            ? (completedCampaignRaw.selected_contacts as Array<Record<string, unknown>>)
            : [],
          outcomes: Array.isArray(completedCampaignRaw.outcomes)
            ? (completedCampaignRaw.outcomes as Array<Record<string, unknown>>)
            : [],
        };

        setSmsCompletedCampaigns((current) => [
          completedCampaign,
          ...current.filter((campaign) => campaign.id !== completedCampaign.id),
        ]);
        setSelectedSmsCampaignId(null);
        setSelectedSmsCompletedCampaignId(completedCampaign.id);
        setSmsActiveTab("completed");
      }

      updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({
        ...campaign,
        status: "completed",
        template_id: selectedSmsTemplateId,
      }));
      return;
    }

    if (!selectedSmsCampaign || !selectedSmsTemplateId || !selectedSmsPhoneConfigId || !selectedSmsContactIndexes.length) return;

    const accessToken = session?.access_token || (await supabase.auth.getSession()).data.session?.access_token;
    if (!accessToken) {
      toast({
        title: "SMS campaign failed",
        description: "You are not authenticated. Please sign in again and retry.",
        variant: "destructive",
      });
      return;
    }

    setStartingSmsCampaign(true);
    let data: any = null;
    let error: { message?: string } | null = null;
    const payload = {
      campaign_id: selectedSmsCampaign.id,
      template_id: selectedSmsTemplateId,
      phone_config_id: selectedSmsPhoneConfigId,
      selected_contact_indexes: [...selectedSmsContactIndexes].sort((a, b) => a - b),
    };

    try {
      const invokeResult = await supabase.functions.invoke("run-sms-campaign", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: payload,
      });

      if (invokeResult.error) {
        if (!useLocalSmsRoutes || !isEdgeFunctionUnavailable(invokeResult.error) || !user?.id) {
          error = { message: invokeResult.error.message };
        }
      } else {
        data = invokeResult.data;
      }
    } catch (edgeError) {
      if (!useLocalSmsRoutes || !(edgeError instanceof Error) || !isEdgeFunctionUnavailable(edgeError) || !user?.id) {
        error = { message: edgeError instanceof Error ? edgeError.message : String(edgeError) };
      }
    }

    if (!data && !error && useLocalSmsRoutes && user?.id) {
      try {
        const response = await fetch("/api/local/run-sms-campaign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, userId: user.id, userEmail: user.email }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok) {
          error = { message: String(data?.error || `HTTP ${response.status}`) };
        }
      } catch (localError) {
        error = { message: localError instanceof Error ? localError.message : String(localError) };
      }
    }

    setStartingSmsCampaign(false);

    if (error || data?.error) {
      const description = String(data?.error || error?.message || "Failed to start SMS campaign");
      console.error("Failed to start SMS campaign", error || data?.error);
      toast({
        title: `${messagingLabel} campaign failed`,
        description,
        variant: "destructive",
      });
      return;
    }

    const completedCampaignRaw = data?.completed_campaign as SmsCompletedCampaign | undefined;
    if (completedCampaignRaw) {
      const completedCampaign: MessagingCompletedCampaign = {
        ...completedCampaignRaw,
        selected_contacts: Array.isArray(completedCampaignRaw.selected_contacts)
          ? (completedCampaignRaw.selected_contacts as Array<Record<string, unknown>>)
          : [],
        outcomes: Array.isArray(completedCampaignRaw.outcomes)
          ? (completedCampaignRaw.outcomes as Array<Record<string, unknown>>)
          : [],
      };

      setSmsCompletedCampaigns((current) => [
        completedCampaign,
        ...current.filter((campaign) => campaign.id !== completedCampaign.id),
      ]);
      setSelectedSmsCampaignId(null);
      setSelectedSmsCompletedCampaignId(completedCampaign.id);
      setSmsActiveTab("completed");
    }

    updateSmsCampaignInState(selectedSmsCampaign.id, (campaign) => ({
      ...campaign,
      status: "completed",
      template_id: selectedSmsTemplateId,
    }));
  };

  const createSmsTemplate = async () => {
    if (!user || !user.email) return;
    if (templateName.trim().length < 3) return;
    if (!isGmailCampaignSpace && templateMessage.trim().length < 10) return;

    let data: any = null;
    let error: { message?: string } | null = null;
    const normalizedTemplateMessage = isGmailCampaignSpace
      ? serializeEmailTemplateConfig({
          to: gmailTemplateTo,
          subject: gmailTemplateSubject,
          body: gmailTemplateBody,
        })
      : templateMessage.trim();
    const normalizedCategory = isGmailCampaignSpace
      ? (gmailTemplateStorageMode === "shared" ? GMAIL_TEMPLATE_FALLBACK_CATEGORY : "email")
      : templateCategory;
    const normalizedLinkedTags = isGmailCampaignSpace ? [] : linkedTemplateTags;

    if (useLocalSmsRoutes && !isGmailCampaignSpace) {
      try {
        try {
          const invokeResult = await supabase.functions.invoke("create-sms-template", {
            body: {
              templateId: editingSmsTemplateId,
              name: templateName.trim(),
              category: normalizedCategory,
              message: normalizedTemplateMessage,
              linkedTags: normalizedLinkedTags,
            },
          });

          if (invokeResult.error) {
            if (!isEdgeFunctionUnavailable(invokeResult.error)) {
              throw new Error(getErrorMessage(invokeResult.error) || "Failed to create SMS template");
            }
          } else {
            data = invokeResult.data?.template || null;
          }
        } catch (edgeError) {
          if (!(edgeError instanceof Error) || !isEdgeFunctionUnavailable(edgeError)) {
            throw edgeError;
          }
        }

        if (!data) {
          const response = await fetch("/api/local/sms-campaign-data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "upsert-template",
              userId: user.id,
              userEmail: user.email,
              templateId: editingSmsTemplateId,
              name: templateName.trim(),
              category: normalizedCategory,
              message: normalizedTemplateMessage,
              linkedTags: normalizedLinkedTags,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            error = { message: String(payload?.error || `HTTP ${response.status}`) };
          } else {
            data = payload?.template || null;
          }
        }
      } catch (localError) {
        error = { message: localError instanceof Error ? localError.message : String(localError) };
      }
    } else {
      const payload = {
        user_id: user.id,
        user_email: user.email,
        name: templateName.trim(),
        category: normalizedCategory,
        message: normalizedTemplateMessage,
        linked_tags: normalizedLinkedTags,
      };

      const runTemplateMutation = async (tableName: string) => {
        const query = editingSmsTemplateId
          ? supabase
              .from(tableName as any)
              .update(payload)
              .eq("id", editingSmsTemplateId)
              .eq("user_id", user.id)
          : supabase.from(tableName as any).insert(payload);

        return query
          .select("id,user_id,user_email,name,category,message,linked_tags,created_at")
          .single();
      };

      const initialResult = await runTemplateMutation(activeTemplateTable);
      data = initialResult.data;
      error = initialResult.error ? { message: initialResult.error.message } : null;

      if (
        isGmailCampaignSpace &&
        gmailTemplateStorageMode === "dedicated" &&
        error?.message &&
        isMissingTableError(error.message)
      ) {
        setGmailTemplateStorageMode("shared");
        const fallbackPayload = { ...payload, category: GMAIL_TEMPLATE_FALLBACK_CATEGORY };
        const runFallbackMutation = async () => {
          const query = editingSmsTemplateId
            ? supabase
                .from("sms_templates" as any)
                .update(fallbackPayload)
                .eq("id", editingSmsTemplateId)
                .eq("user_id", user.id)
            : supabase.from("sms_templates" as any).insert(fallbackPayload);

          return query
            .select("id,user_id,user_email,name,category,message,linked_tags,created_at")
            .single();
        };

        const fallbackResult = await runFallbackMutation();
        data = fallbackResult.data;
        error = fallbackResult.error ? { message: fallbackResult.error.message } : null;
      }
    }

    if (error || !data) {
      console.error(`Failed to ${editingSmsTemplateId ? "update" : "create"} SMS template`, error);
      toast({
        title: editingSmsTemplateId ? "Failed to update template" : "Failed to create template",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
      return;
    }

    const nextTemplate: MessagingTemplate = {
      ...data,
      linked_tags: Array.isArray(data.linked_tags) ? (data.linked_tags as string[]) : [],
    };

    setSmsTemplates((current) => {
      if (editingSmsTemplateId) {
        return current.map((template) => (template.id === nextTemplate.id ? nextTemplate : template));
      }
      return [nextTemplate, ...current];
    });
    setSelectedSmsTemplateId(nextTemplate.id);
    setTemplateDialogOpen(false);
    resetSmsTemplateForm();
    toast({ title: editingSmsTemplateId ? "Template updated" : "Template created" });
  };

  const renderVoiceTabContent = (tab: string) => {
    switch (tab) {
      case "campaigns":
        return <CampaignsTab />;
      case "outcomes":
        return <OutcomesTab />;
      case "retry-csv":
        return <RetryCSVTab />;
      case "data-cleaning":
      default:
        return <DataCleaningTab />;
    }
  };

  const renderSmsTemplateDialog = () => (
    <Dialog open={templateDialogOpen} onOpenChange={(open) => {
      setTemplateDialogOpen(open);
      if (!open) resetSmsTemplateForm();
    }}>
      <DialogTrigger asChild>
        <Button className="gap-2"><Plus className="h-4 w-4" /> New Template</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="border-b pb-4 pr-8">
          <DialogTitle className="text-2xl font-semibold tracking-tight">{editingSmsTemplateId ? "Edit Template" : "Create New Template"}</DialogTitle>
          <DialogDescription className="sr-only">
            Create or edit an SMS template with message content, category, and linked tags.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <div className="space-y-2">
            <Label htmlFor="sms-template-name">Template Name <span className="text-destructive">*</span></Label>
            <Input
              id="sms-template-name"
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder={isGmailCampaignSpace ? "e.g., Intro Follow Up" : "e.g., VIP Exclusive Offer"}
            />
            <p className="text-sm text-muted-foreground">Minimum 3 characters required</p>
          </div>

          {isGmailCampaignSpace ? (
            <div className="space-y-6 rounded-2xl border border-border/60 bg-card p-6">
              <div className="space-y-2">
                <h3 className="text-2xl font-semibold tracking-tight">Email</h3>
                <p className="text-sm text-muted-foreground">
                  Configure the To, Subject, and Body used for Gmail campaign templates.
                </p>
                <p className="text-sm text-muted-foreground">
                  Use placeholders like {"<<name>>"}, {"<<email>>"}, or any uploaded custom column such as {"<<company>>"}.
                  Custom fields can be written directly inside {"<< >>"}.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="gmail-template-to">TO</Label>
                <Input
                  id="gmail-template-to"
                  value={gmailTemplateTo}
                  onChange={(event) => setGmailTemplateTo(event.target.value)}
                  placeholder="<<email>>"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="gmail-template-subject">SUBJECT</Label>
                <Input
                  id="gmail-template-subject"
                  value={gmailTemplateSubject}
                  onChange={(event) => setGmailTemplateSubject(event.target.value)}
                  placeholder="Thanks for chatting! / Notes & Next Steps"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="gmail-template-body">BODY</Label>
                <Textarea
                  id="gmail-template-body"
                  value={gmailTemplateBody}
                  onChange={(event) => setGmailTemplateBody(event.target.value)}
                  className="min-h-[280px] bg-background"
                  placeholder="Write your email body here. Use << >> for placeholders."
                />
              </div>

              <div className="space-y-3">
                <div>
                  <h4 className="text-sm font-semibold uppercase tracking-[0.08em] text-muted-foreground">Detected Placeholders</h4>
                </div>
                <div className="flex flex-wrap gap-2">
                  {gmailDetectedPlaceholders.length ? gmailDetectedPlaceholders.map((placeholder) => (
                    <span key={placeholder} className="rounded-full bg-muted px-3 py-1 text-sm font-medium text-foreground">
                      {placeholder}
                    </span>
                  )) : (
                    <span className="text-sm text-muted-foreground">
                      No placeholders detected yet. Add any custom field inside {"<< >>"}.
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Placeholder matching is case-insensitive and supports names with spaces or underscores.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Category <span className="text-destructive">*</span></Label>
                <Select value={templateCategory} onValueChange={setTemplateCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="welcome">Welcome</SelectItem>
                    <SelectItem value="promotional">Promotional</SelectItem>
                    <SelectItem value="reactivation">Reactivation</SelectItem>
                    <SelectItem value="retention">Retention</SelectItem>
                    <SelectItem value="reminder">Reminder</SelectItem>
                    <SelectItem value="follow-up">Follow Up</SelectItem>
                    <SelectItem value="seasonal">Seasonal</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
                <div className="space-y-2">
                  <Label htmlFor="sms-template-message">Message</Label>
                  <Textarea
                    id="sms-template-message"
                    value={templateMessage}
                    onChange={(event) => setTemplateMessage(event.target.value)}
                    placeholder="Enter your message template here... Use <<Name>> or <<Email>> for personalization"
                    className="min-h-[140px] bg-background"
                  />
                  <p className="text-sm text-muted-foreground">Minimum 10 characters required</p>
                  <p className="text-sm font-medium text-muted-foreground">{smsLength} characters ({smsSegments} SMS{smsSegments > 1 ? "s" : ""}) &nbsp; (GSM - 160 chars per SMS)</p>
                  <p className="text-sm text-muted-foreground">Use placeholders like {"<<Name>>"}, {"<<Phone>>"}, {"<<Email>>"}, or any custom field wrapped in {"<< >>"}. When the campaign runs, matching customer details can be inserted into those placeholders.</p>
                  <p className="text-sm text-emerald-700">Your default SMS signature from Settings will be automatically added to the end of messages that use this template, and it counts toward the 160-character per-SMS limit. Personalization tags expand with real customer data, so aim to keep your base template text near 140 characters to reduce multi-part SMS.</p>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <h3 className="text-xl font-semibold tracking-tight">Linked Tags (Optional)</h3>
                  <p className="text-sm text-muted-foreground">Select tags from your Tags page to link with this template</p>
                </div>
                <div className="space-y-3 rounded-2xl border border-border/60 bg-background p-5">
                  {smsTemplateTags.map((tag) => (
                    <label key={tag} className="flex items-center gap-4 rounded-xl border border-border/60 px-5 py-4">
                      <Checkbox checked={linkedTemplateTags.includes(tag)} onCheckedChange={() => toggleSmsTemplateTag(tag)} />
                      <span className="text-lg font-medium">{tag}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <Separator />

          <div className="flex items-center justify-end gap-3">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="min-w-[170px]"
              disabled={!user || !user.email || templateName.trim().length < 3 || (!isGmailCampaignSpace && templateMessage.trim().length < 10)}
              onClick={createSmsTemplate}
            >
              {editingSmsTemplateId ? "Save Changes" : "Create Template"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  const renderSmsTabContent = (tab: string) => {
    if (tab === "template") {
      return (
        <div className="space-y-5">
          <div className="flex items-center justify-end">
            {renderSmsTemplateDialog()}
          </div>
          {!smsTemplates.length ? (
            <div className="rounded-2xl border border-dashed border-border bg-card p-10">
              <div className="max-w-2xl space-y-2">
                <h2 className="text-xl font-semibold tracking-tight">{isGmailCampaignSpace ? "Gmail Template" : "SMS Template"}</h2>
                <p className="text-sm text-muted-foreground">
                  {isGmailCampaignSpace
                    ? "Create reusable Gmail templates with To, Subject, Body, and custom placeholders written inside << >>."
                    : "Create reusable SMS templates with categories, personalization tags, and linked tags."}
                </p>
              </div>
            </div>
          ) : null}
          <div className="grid gap-5 overflow-visible px-2 py-2 md:grid-cols-2 xl:grid-cols-3">
            {smsTemplates.length ? smsTemplates.map((template) => (
              <div
                key={template.id}
                role="button"
                tabIndex={0}
                onClick={() => openEditSmsTemplate(template)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openEditSmsTemplate(template);
                  }
                }}
                className="cursor-pointer rounded-2xl border border-border/60 bg-card p-5 shadow-sm transition-[border-color,box-shadow,background-color] hover:border-primary/30 hover:shadow-md"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold">{template.name}</h3>
                      {isGmailCampaignSpace ? (
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {parseEmailTemplateConfig(template.message).subject}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize text-muted-foreground">
                        {isGmailCampaignSpace ? "Email" : template.category}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for ${template.name}`} onClick={(event) => event.stopPropagation()}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                          <DropdownMenuItem onClick={() => openEditSmsTemplate(template)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setSmsTemplateDeleteTarget({ id: template.id, name: template.name })}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {!isGmailCampaignSpace && template.linked_tags.length ? (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {template.linked_tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground">{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            )) : (
              <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-sm text-muted-foreground md:col-span-2">
                {`No ${messagingLabel} templates yet. Create one and it will appear here.`}
              </div>
            )}
          </div>
        </div>
      );
    }

    const labels: Record<string, string> = {
      "data-extract": `${messagingLabel} Data Extract`,
      campaigns: `${messagingLabel} Campaigns`,
      completed: `${messagingLabel} Completed`,
    };

    if (tab === "data-extract") {
        return (
          <DataCleaningTab
            saveMode={isGmailCampaignSpace ? "gmail" : "sms"}
            saveCardTitle={`Save to ${messagingLabel} Campaign`}
            saveCardDescription={`Save selected contacts after AI analysis. Use the ${isGmailCampaignSpace ? "Campaign Name" : "Template Name"} field to keep this ${messagingLabel} data set organized for campaigns.`}
            nameLabel={isGmailCampaignSpace ? "Campaign Name *" : "Template Name *"}
            namePlaceholder={isGmailCampaignSpace ? "e.g. Gmail Follow Up Campaign" : "e.g. Festival Promo Extract"}
            gmailCampaignStorageMode={gmailCampaignStorageMode}
            onGmailCampaignStorageModeChange={setGmailCampaignStorageMode}
            onSmsCampaignSaved={(campaign) => {
              const normalizedCampaign = {
                ...campaign,
                extracted_contacts: Array.isArray(campaign.extracted_contacts) ? (campaign.extracted_contacts as Array<Record<string, unknown>>) : [],
              };
              if (isGmailCampaignSpace && isGmailFallbackCampaign(normalizedCampaign as MessagingCampaign)) {
                setGmailCampaignStorageMode("shared");
              }
              setSmsCampaigns((current) => [
                normalizedCampaign,
                ...current.filter((item) => item.id !== campaign.id),
              ]);
            }}
          />
        );
      }

    if (tab === "campaigns") {
      return (
        <div className="space-y-5">
          <AnimatePresence mode="wait" initial={false}>
            {selectedSmsCampaign ? (
              <motion.div
                key={`sms-campaign-detail-${selectedSmsCampaign.id}`}
                initial={{ y: 16, scale: 0.985 }}
                animate={{ y: 0, scale: 1 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="space-y-6"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Back to campaigns" onClick={() => setSelectedSmsCampaignId(null)}>
                      <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div>
                      <h2 className="text-2xl font-bold">{selectedSmsCampaign.name}</h2>
                      <p className="text-muted-foreground flex items-center gap-1 text-sm">
                        <FileText className="h-3.5 w-3.5" /> {`${messagingLabel} campaign`}
                      </p>
                    </div>
                  </div>
                  <Badge className="text-sm px-3 py-1 capitalize">{selectedSmsCampaign.status}</Badge>
                </div>

                <div className="grid gap-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>Total Contacts</CardDescription>
                      <CardTitle className="flex items-center gap-2 text-3xl">
                        <Users className="h-6 w-6 text-primary" />
                        {selectedSmsCampaignContacts.length}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                </div>


                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Campaign Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">Template:</span>
                          <span className="font-medium">{selectedSmsCampaignTemplate?.name || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">{isGmailCampaignSpace ? "Sender Email:" : "Sender Number:"}</span>
                          <span className="font-medium">
                            {isGmailCampaignSpace
                              ? ((selectedSmsCompletedCampaign as any)?.sender_email_address || user?.email || "—")
                              : (selectedSmsPhoneConfig?.phone_number || "—")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">Selected Scope:</span>
                          <span className="font-medium">{selectedSmsContactIndexes.length} contacts</span>
                        </div>
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">Created:</span>
                          <span className="font-medium">{selectedSmsCampaign.created_at ? new Date(selectedSmsCampaign.created_at).toLocaleString() : "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">Status:</span>
                          <span className="font-medium capitalize">{selectedSmsCampaign.status || "draft"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-32 text-muted-foreground">Saved Under:</span>
                          <span className="font-medium">{selectedSmsCampaign.user_email || user?.email || "—"}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <CardTitle className="text-base flex items-center gap-2">
                          <Users className="h-4 w-4" /> Contacts ({selectedSmsCampaignContacts.length})
                        </CardTitle>
                        <CardDescription>{selectedSmsContactIndexes.length} of {selectedSmsCampaignContacts.length} mobile numbers selected</CardDescription>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => setCustomSmsContactFieldDialogOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Column
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {selectedSmsCampaignContacts.length === 0 ? (
                      <p className="py-4 text-center text-sm text-muted-foreground">No contacts available for this campaign.</p>
                    ) : (
                      <ScrollArea className="max-h-[420px]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-12">
                                <Checkbox
                                  checked={selectedSmsContactIndexes.length === selectedSmsCampaignContacts.length && selectedSmsCampaignContacts.length > 0}
                                  onCheckedChange={(checked) => setSelectedSmsContactIndexes(checked ? selectedSmsCampaignContacts.map((_, index) => index) : [])}
                                  aria-label="Select all contacts"
                                />
                              </TableHead>
                              <TableHead className="w-12">#</TableHead>
                              {smsContactColumns.map((column) => (
                                <TableHead key={column}>
                                  <span className="group inline-flex items-center gap-1">
                                    {column.replace(/_/g, " ")}
                                    <button
                                      type="button"
                                      onClick={() => void deleteSmsContactColumn(column)}
                                      aria-label={`Delete ${column.replace(/_/g, " ")} column`}
                                      className="rounded p-0.5 text-muted-foreground opacity-60 hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus-visible:opacity-100"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </span>
                                </TableHead>
                              ))}
                              <TableHead className="w-16">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {selectedSmsCampaignContacts.map((contact, index) => (
                              <TableRow key={`${selectedSmsCampaign.id}-${index}`}>
                                <TableCell>
                                  <Checkbox
                                    checked={selectedSmsContactIndexes.includes(index)}
                                    onCheckedChange={() => toggleSmsCampaignContact(index)}
                                    aria-label={`Select contact ${index + 1}`}
                                  />
                                </TableCell>
                                <TableCell className="text-muted-foreground text-xs">{index + 1}</TableCell>
                                {smsContactColumns.map((column) => {
                                  const value = contact[column];
                                  const isPhoneField = /phone|mobile|number/i.test(column);
                                  return (
                                    <TableCell key={column} className={isPhoneField ? "font-mono text-xs" : column.toLowerCase().includes("name") ? "font-medium" : ""}>
                                      {isPhoneField ? formatSmsPhoneDisplay(value) : typeof value === "string" && value.trim() ? value : value != null ? String(value) : "—"}
                                    </TableCell>
                                  );
                                })}
                                <TableCell>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for contact ${index + 1}`}>
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem onClick={() => openSmsContactEditor(contact, index)}>
                                        <Pencil className="mr-2 h-4 w-4" />
                                        Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={() => void deleteSmsContact(index)}
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" />
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

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Play className="h-4 w-4" /> Start Campaign
                    </CardTitle>
                    <CardDescription>
                      {isGmailCampaignSpace
                        ? "Gmail sending will use the saved template and selected recipients once the Gmail send workflow is enabled."
                        : `Send the selected template to ${selectedSmsContactIndexes.length} selected mobile numbers.`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className={cn("grid gap-4", isGmailCampaignSpace ? "md:grid-cols-1" : "md:grid-cols-2")}>
                      <div className="space-y-2">
                        <Label>Template *</Label>
                        <Select value={selectedSmsTemplateId} onValueChange={setSelectedSmsTemplateId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select template" />
                          </SelectTrigger>
                          <SelectContent>
                            {smsTemplates.map((template) => (
                              <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {!isGmailCampaignSpace ? (
                      <div className="space-y-2">
                        <Label>Connected Mobile Numbers</Label>
                        <Select value={selectedSmsPhoneConfigId} onValueChange={setSelectedSmsPhoneConfigId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select connected number" />
                          </SelectTrigger>
                          <SelectContent>
                            {smsPhoneConfigs.map((config) => (
                              <SelectItem key={config.id} value={config.id}>{config.phone_number}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!smsPhoneConfigs.length ? (
                          <p className="text-sm text-destructive">
                            No active Telnyx SMS sender is configured in Phone Integration.
                          </p>
                        ) : null}
                      </div>
                      ) : null}
                    </div>
                    <Button
                      onClick={() => void startSmsCampaign()}
                      disabled={
                        startingSmsCampaign ||
                        !selectedSmsTemplateId ||
                        (!isGmailCampaignSpace && !selectedSmsPhoneConfigId) ||
                        !selectedSmsContactIndexes.length
                      }
                    >
                      {startingSmsCampaign ? "Starting..." : "Start Campaign"}
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <Button type="button" onClick={() => setSmsCampaignDialogOpen(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      {`New ${messagingLabel} Campaign`}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                  {[
                    { value: "all", label: "All" },
                    { value: "draft", label: "Draft" },
                    { value: "active", label: "Active" },
                    { value: "paused", label: "Paused" },
                    { value: "completed", label: "Completed" },
                  ].map((option) => {
                    const isActive = smsCampaignStatusFilter === option.value;
                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant={isActive ? "default" : "outline"}
                        className={cn("h-9 rounded-xl px-4 text-sm", !isActive && "border-border/80 bg-background text-foreground hover:bg-muted/40")}
                        onClick={() => setSmsCampaignStatusFilter(option.value as typeof smsCampaignStatusFilter)}
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredSmsCampaignCards.length ? filteredSmsCampaignCards.map((campaign) => {
                    const status = String(campaign.status || "draft").toLowerCase();
                    return (
                      <Card
                        key={campaign.id}
                        className={cn(
                          "relative min-h-[112px] cursor-pointer border-border/60 transition-shadow hover:shadow-md",
                          selectedSmsCampaignId === campaign.id && "border-primary/40 bg-primary/5"
                        )}
                        onClick={() => openSmsCampaign(campaign)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${campaign.name}`}
                        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openSmsCampaign(campaign); } }}
                      >
                        <CardHeader className="pb-6">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <CardTitle className="text-base">{campaign.name}</CardTitle>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge className={SMS_CAMPAIGN_STATUS_COLORS[status] || SMS_CAMPAIGN_STATUS_COLORS.draft}>{campaign.status}</Badge>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`More actions for ${campaign.name}`} onClick={(event) => event.stopPropagation()}>
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                                  <DropdownMenuItem onClick={() => openSmsCampaign(campaign)}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setSmsCampaignDeleteTarget({ id: campaign.id, name: campaign.name })}>
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        </CardHeader>
                      </Card>
                    );
                  }) : (
                <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
                  {`No ${messagingLabel} campaigns match the selected status.`}
                </div>
              )}
            </div>
              </div>
            )}
          </AnimatePresence>
        </div>
      );
    }

    if (tab === "completed") {
      return (
        <div className="space-y-5">
          {selectedSmsCompletedCampaign ? (
            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Back to campaigns" onClick={() => setSelectedSmsCompletedCampaignId(null)}>
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <div>
                    <h2 className="text-2xl font-bold">{selectedSmsCompletedCampaign.name}</h2>
                    <p className="text-muted-foreground flex items-center gap-1 text-sm">
                      <FileText className="h-3.5 w-3.5" /> {`${messagingLabel} campaign outcome`}
                    </p>
                  </div>
                </div>
                <Badge className="text-sm px-3 py-1 capitalize">{selectedSmsCompletedCampaign.status}</Badge>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Card className="border-border/60 shadow-sm">
                  <CardContent className="p-5">
                    <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Total Contacts</p>
                    <p className="mt-3 text-4xl font-semibold leading-none">{selectedSmsCompletedCampaign.total_contacts}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-sm">
                  <CardContent className="p-5">
                    <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Messages Sent</p>
                    <p className="mt-3 text-4xl font-semibold leading-none">{selectedSmsCompletedCampaign.sent_count}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-sm">
                  <CardContent className="p-5">
                    <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Pending</p>
                    <p className="mt-3 text-4xl font-semibold leading-none">{Math.max(Number(selectedSmsCompletedCampaign.total_contacts || 0) - Number(selectedSmsCompletedCampaign.sent_count || 0) - Number(selectedSmsCompletedCampaign.failed_count || 0), 0)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-sm">
                  <CardContent className="p-5">
                    <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Failed</p>
                    <p className="mt-3 text-4xl font-semibold leading-none">{selectedSmsCompletedCampaign.failed_count}</p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Outcome</CardTitle>
                  <CardDescription>Per-recipient results for this completed SMS campaign.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selectedSmsCompletedCampaignOutcomes.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">No outcomes were recorded for this campaign.</p>
                  ) : (
                    <>
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div className="relative flex-1">
                          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            className="pl-9"
                            placeholder={isGmailCampaignSpace ? "Search by name, email..." : "Search by name, phone..."}
                            aria-label="Search outcomes"
                            value={smsCompletedOutcomeSearchTerm}
                            onChange={(e) => setSmsCompletedOutcomeSearchTerm(e.target.value)}
                          />
                        </div>
                        <Select value={smsCompletedOutcomeFilter} onValueChange={setSmsCompletedOutcomeFilter}>
                          <SelectTrigger className="w-full md:w-[180px]">
                            <SelectValue placeholder="All Results" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ALL">All Results</SelectItem>
                            <SelectItem value="sent">Sent</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {filteredSmsCompletedCampaignOutcomes.length === 0 ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">No outcomes match the current filters.</p>
                      ) : (
                        <ScrollArea className="max-h-[360px]">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-12">#</TableHead>
                                  <TableHead>{isGmailCampaignSpace ? "Recipient" : "Recipient"}</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Message</TableHead>
                                <TableHead>Provider ID</TableHead>
                                <TableHead>Error</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {filteredSmsCompletedCampaignOutcomes.map((outcome, index) => (
                                <TableRow
                                  key={`${selectedSmsCompletedCampaign.id}-outcome-${index}`}
                                  className="cursor-pointer transition-colors hover:bg-muted/40"
                                  onClick={() => setSelectedSmsCompletedOutcomeDetail({ index, outcome })}
                                >
                                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {typeof outcome.recipient_number === "string" && outcome.recipient_number
                                      ? outcome.recipient_number
                                      : typeof outcome.recipient_email === "string" && outcome.recipient_email
                                        ? outcome.recipient_email
                                        : typeof outcome.email === "string" && outcome.email
                                          ? outcome.email
                                          : "—"}
                                  </TableCell>
                                  <TableCell>
                                    <span className={cn(
                                      "rounded-full px-2.5 py-1 text-xs font-medium capitalize",
                                      String(outcome.status || "").toLowerCase() === "failed"
                                        ? "bg-destructive/10 text-destructive"
                                        : "bg-primary/10 text-primary"
                                    )}>
                                      {typeof outcome.status === "string" ? outcome.status : "unknown"}
                                    </span>
                                  </TableCell>
                                  <TableCell className="max-w-[320px] whitespace-normal text-sm">{typeof outcome.rendered_message === "string" && outcome.rendered_message ? outcome.rendered_message : "—"}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground">{typeof outcome.provider_message_id === "string" && outcome.provider_message_id ? outcome.provider_message_id : "—"}</TableCell>
                                  <TableCell className="max-w-[260px] whitespace-normal text-sm text-destructive/80">{typeof outcome.error === "string" && outcome.error ? outcome.error : "—"}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Select value={smsCompletedCampaignFilter} onValueChange={setSmsCompletedCampaignFilter}>
                  <SelectTrigger className="w-[180px] focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0">
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="queued">Queued</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredSmsCompletedCampaignCards.length ? filteredSmsCompletedCampaignCards.map((campaign) => (
                <button
                  key={campaign.id}
                  type="button"
                  onClick={() => openSmsCompletedCampaign(campaign)}
                  className={`rounded-2xl border bg-card p-5 text-left shadow-sm transition-colors ${
                    selectedSmsCompletedCampaignId === campaign.id
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/60 hover:border-primary/30"
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold">{campaign.name}</h3>
                      <div className="flex items-center gap-2">
                        <Badge variant="default" className="px-3 py-0.5 text-xs font-medium capitalize">{campaign.status}</Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`More actions for ${campaign.name}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                            <DropdownMenuItem onClick={() => openSmsCompletedCampaign(campaign)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setSmsCompletedDeleteTarget({ id: campaign.id, name: campaign.name })}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">Sent: {campaign.sent_count}</Badge>
                      <Badge variant="secondary">Failed: {campaign.failed_count}</Badge>
                    </div>
                  </div>
                </button>
              )) : (
                <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
                  {smsCompletedCampaigns.length
                    ? `No completed ${messagingLabel} campaigns match the selected status filter.`
                    : `No completed ${messagingLabel} campaigns yet. Run a campaign and the results will appear here.`}
                </div>
              )}
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-10">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-xl font-semibold tracking-tight">{labels[tab] || "SMS Campaigns"}</h2>
          <p className="text-sm text-muted-foreground">
            {`This section is ready for ${messagingLabel}-specific content. Voice campaign data is hidden here.`}
          </p>
        </div>
      </div>
    );
  };

  const renderChannelTabs = (
    tabs: readonly { value: string; label: string; icon: typeof FileSpreadsheet }[],
    activeTab: string,
    setActiveTab: (value: string) => void,
    renderContent: (tab: string) => React.ReactNode,
  ) => {
    const activeIndex = Math.max(tabs.findIndex((tab) => tab.value === activeTab), 0);
    return (
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className={`relative grid w-full overflow-hidden rounded-xl border border-border/50 bg-muted/60 p-1 ${tabs.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
          <motion.div
            className="absolute inset-y-1 rounded-lg bg-background shadow-sm"
            animate={{
              width: `calc(${100 / tabs.length}% - 6px)`,
              x: `calc(${activeIndex * 100}% + 4px)`,
            }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.85 }}
          />
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="relative z-10 flex items-center gap-2 rounded-lg bg-transparent transition-colors duration-300 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <Icon className="h-4 w-4" /> {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value={activeTab} forceMount className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ y: 14, scale: 0.985 }}
              animate={{ y: 0, scale: 1 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              {renderContent(activeTab)}
            </motion.div>
          </AnimatePresence>
        </TabsContent>
      </Tabs>
    );
  };

  const renderChannelContent = () => {
    if (!isMessagingCampaignSpace) {
      return renderChannelTabs(voiceTabs, voiceActiveTab, setVoiceActiveTab, renderVoiceTabContent);
    }

    return renderChannelTabs(smsTabs, smsActiveTab, setSmsActiveTab, renderSmsTabContent);
  };

  return (
    <DashboardLayout>
      <AlertDialog open={Boolean(smsTemplateDeleteTarget)} onOpenChange={(open) => { if (!open) setSmsTemplateDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SMS template?</AlertDialogTitle>
            <AlertDialogDescription>
              {smsTemplateDeleteTarget ? `This will permanently delete "${smsTemplateDeleteTarget.name}" from SMS templates.` : "This will permanently delete the selected SMS template."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDeleteSmsTemplate()}
              disabled={deletingSmsTemplate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingSmsTemplate ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(smsCampaignDeleteTarget)} onOpenChange={(open) => { if (!open) setSmsCampaignDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SMS campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              {smsCampaignDeleteTarget ? `This will permanently delete "${smsCampaignDeleteTarget.name}" from SMS campaigns.` : "This will permanently delete the selected SMS campaign."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDeleteSmsCampaign()}
              disabled={deletingSmsCampaign}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingSmsCampaign ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={Boolean(smsCompletedDeleteTarget)} onOpenChange={(open) => { if (!open) setSmsCompletedDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete completed SMS campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              {smsCompletedDeleteTarget ? `This will permanently delete "${smsCompletedDeleteTarget.name}" from completed SMS campaigns.` : "This will permanently delete the selected completed SMS campaign."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDeleteSmsCompletedCampaign()}
              disabled={deletingSmsCompletedCampaign}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingSmsCompletedCampaign ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={smsCampaignDialogOpen} onOpenChange={(open) => {
        setSmsCampaignDialogOpen(open);
        if (!open && !creatingSmsCampaign) resetNewSmsCampaignForm();
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-semibold tracking-tight">Create New Campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="sms-campaign-name">Campaign Name *</Label>
              <Input
                id="sms-campaign-name"
                value={newSmsCampaignName}
                onChange={(event) => setNewSmsCampaignName(event.target.value)}
                placeholder="e.g., VIP Follow Up"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">Contacts</h3>
                  <p className="text-sm text-muted-foreground">Add the name and phone number for each recipient.</p>
                </div>
                <Button type="button" variant="outline" onClick={addNewSmsCampaignContact}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Contact
                </Button>
              </div>

              <div className="space-y-3">
                {newSmsCampaignContacts.map((contact, index) => (
                  <div key={index} className="grid gap-3 rounded-xl border border-border/60 p-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
                    <div className="space-y-2">
                      <Label htmlFor={`sms-campaign-contact-name-${index}`}>Name</Label>
                      <Input
                        id={`sms-campaign-contact-name-${index}`}
                        value={contact.name}
                        onChange={(event) => updateNewSmsCampaignContact(index, "name", event.target.value)}
                        placeholder="e.g. John"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`sms-campaign-contact-phone-${index}`}>Phone Number</Label>
                      <Input
                        id={`sms-campaign-contact-phone-${index}`}
                        value={contact.phone}
                        onChange={(event) => updateNewSmsCampaignContact(index, "phone", event.target.value)}
                        placeholder="e.g. +1234567890"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 text-muted-foreground"
                      onClick={() => removeNewSmsCampaignContact(index)}
                      aria-label={`Remove contact ${index + 1}`}
                      disabled={newSmsCampaignContacts.length === 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creatingSmsCampaign}>Cancel</Button>
              </DialogClose>
              <Button type="button" onClick={() => void createSmsCampaign()} disabled={creatingSmsCampaign}>
                {creatingSmsCampaign ? "Saving..." : "Save Campaign"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <div className="space-y-6 animate-rise-in">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{campaignTitle}</h1>
            <p className="mt-1 text-muted-foreground">{campaignDescription}</p>
          </div>
          <ChannelSelect page="campaigns" />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={campaignChannel}
            initial={{ y: 12, scale: 0.985 }}
            animate={{ y: 0, scale: 1 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {renderChannelContent()}
          </motion.div>
        </AnimatePresence>
      </div>
      <Dialog open={selectedSmsCompletedContactDetail !== null} onOpenChange={(open) => {
        if (!open) setSelectedSmsCompletedContactDetail(null);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Contact Details</DialogTitle>
          </DialogHeader>
          {selectedSmsCompletedContactDetail ? (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                Contact #{selectedSmsCompletedContactDetail.index + 1}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {selectedSmsCompletedContactEntries.length ? selectedSmsCompletedContactEntries.map(([key, value]) => {
                  const isPhoneField = /phone|mobile|number/i.test(key);
                  const displayValue = isPhoneField ? formatSmsPhoneDisplay(value) : String(value);
                  return (
                    <div key={key} className="space-y-1 rounded-lg border p-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{key.replace(/_/g, " ")}</p>
                      <p className={isPhoneField ? "font-mono text-sm" : "text-sm font-medium"}>{displayValue}</p>
                    </div>
                  );
                }) : (
                  <p className="text-sm text-muted-foreground">No contact details recorded.</p>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={selectedSmsCompletedOutcomeDetail !== null} onOpenChange={(open) => {
        if (!open) setSelectedSmsCompletedOutcomeDetail(null);
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>SMS Conversation</DialogTitle>
          </DialogHeader>
          {selectedSmsCompletedOutcomeDetail ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
                <span className="font-mono font-medium">{formatSmsPhoneDisplay(selectedSmsCompletedOutcomeDetail.outcome.recipient_number)}</span>
                <Badge variant={String(selectedSmsCompletedOutcomeDetail.outcome.status || '').toLowerCase() === 'failed' ? 'destructive' : 'default'} className="capitalize">
                  {typeof selectedSmsCompletedOutcomeDetail.outcome.status === 'string' ? selectedSmsCompletedOutcomeDetail.outcome.status : 'unknown'}
                </Badge>
                {typeof selectedSmsCompletedOutcomeDetail.outcome.provider_message_id === 'string' && selectedSmsCompletedOutcomeDetail.outcome.provider_message_id ? (
                  <span className="text-xs text-muted-foreground">Provider ID: {selectedSmsCompletedOutcomeDetail.outcome.provider_message_id}</span>
                ) : null}
              </div>

              <div className="space-y-3 rounded-xl border bg-background p-4">
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm text-primary-foreground shadow-sm">
                    <p className="whitespace-pre-wrap break-words">{typeof selectedSmsCompletedOutcomeDetail.outcome.rendered_message === 'string' && selectedSmsCompletedOutcomeDetail.outcome.rendered_message ? selectedSmsCompletedOutcomeDetail.outcome.rendered_message : 'No SMS text recorded.'}</p>
                  </div>
                </div>

                {typeof selectedSmsCompletedOutcomeDetail.outcome.error === 'string' && selectedSmsCompletedOutcomeDetail.outcome.error ? (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive shadow-sm">
                      <p className="font-medium">Delivery error</p>
                      <p className="mt-1 whitespace-pre-wrap break-words">{selectedSmsCompletedOutcomeDetail.outcome.error}</p>
                    </div>
                  </div>
                ) : null}
              </div>

              {selectedSmsCompletedOutcomeEntries.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {selectedSmsCompletedOutcomeEntries
                    .filter(([key]) => !['rendered_message', 'error'].includes(key))
                    .map(([key, value]) => {
                      const isPhoneField = /phone|mobile|number|recipient/i.test(key);
                      const displayValue = isPhoneField ? formatSmsPhoneDisplay(value) : String(value);
                      return (
                        <div key={key} className={cn('space-y-1 rounded-lg border p-3', key === 'provider_message_id' && 'sm:col-span-2')}>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{key.replace(/_/g, ' ')}</p>
                          <p className={cn(isPhoneField ? 'font-mono text-sm' : 'text-sm font-medium', key === 'provider_message_id' && 'break-all')}>{displayValue}</p>
                        </div>
                      );
                    })}
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={editingSmsContactIndex !== null} onOpenChange={(open) => {
        if (!open) {
          setEditingSmsContactIndex(null);
          setEditingSmsContactFields({});
        }
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.keys(editingSmsContactFields).map((key) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`sms-contact-${key}`}>{formatMessagingFieldLabel(key)}</Label>
                  <Input
                    id={`sms-contact-${key}`}
                    value={editingSmsContactFields[key] ?? ""}
                    onChange={(e) => setEditingSmsContactFields((current) => ({ ...current, [key]: e.target.value }))}
                    placeholder={formatMessagingFieldLabel(key)}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => {
                setEditingSmsContactIndex(null);
                setEditingSmsContactFields({});
              }}>
                Cancel
              </Button>
              <Button onClick={saveSmsContactEdit} disabled={savingSmsContact}>
                {savingSmsContact ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={customSmsContactFieldDialogOpen} onOpenChange={setCustomSmsContactFieldDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Column</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="custom-sms-contact-field-name">Column Name</Label>
              <Input
                id="custom-sms-contact-field-name"
                value={customSmsContactFieldName}
                onChange={(event) => setCustomSmsContactFieldName(event.target.value)}
                placeholder="Company"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCustomSmsContactFieldDialogOpen(false);
                  setCustomSmsContactFieldName("");
                }}
              >
                Cancel
              </Button>
              <Button type="button" onClick={() => void addSmsContactColumn()} disabled={addingCustomSmsContactField}>
                {addingCustomSmsContactField ? "Adding..." : "Add Column"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
