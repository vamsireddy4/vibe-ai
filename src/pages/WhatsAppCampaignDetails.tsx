import * as React from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  FileText,
  LayoutTemplate,
  Megaphone,
  MoreVertical,
  Pencil,
  Phone,
  Plus,
  RefreshCcw,
  Target,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { supportsWhatsappTable } from "@/lib/whatsapp-compat";

type CampaignContactRecord = Record<string, unknown> & {
  id: string;
};

type CampaignDetailRecord = {
  id: string;
  name: string;
  description: string;
  audienceId: string | null;
  templateId: string | null;
  audienceName: string;
  templateName: string;
  status: "draft" | "active" | "completed" | "failed";
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  startedAtLabel: string | null;
  completedAtLabel: string | null;
  createdAtLabel: string | null;
  contacts: CampaignContactRecord[];
};

type CampaignTemplateOption = {
  id: string;
  name: string;
  normalizedName: string;
  body: string;
  category: string;
  language: string;
  status: "approved" | "pending" | "failed";
};

type CampaignAudienceOption = {
  id: string;
  name: string;
};

const WHATSAPP_CAMPAIGN_FUNCTION_NAMES = ["send-campaign-messages", "run-whatsapp-campaign"] as const;
const getLocalCampaignStorageKey = (userId: string) => `whatsapp-local-campaigns:${userId}`;
const shouldUseLocalCampaignBackend = () =>
  typeof window !== "undefined" && /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname);

const getFunctionErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "");

const isFunctionMissingError = (error: unknown) => {
  const message = getFunctionErrorMessage(error).toLowerCase();
  return message.includes("not_found") || message.includes("404") || message.includes("not found");
};

async function invokeWhatsappCampaignFunction(campaignId: string) {
  let lastError: unknown = null;

  for (const functionName of WHATSAPP_CAMPAIGN_FUNCTION_NAMES) {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: { campaign_id: campaignId },
    });

    if (!error && data?.success !== false) {
      return { data, error: null };
    }

    lastError = data?.error || error;
    if (!isFunctionMissingError(error)) {
      return { data, error: error || new Error(String(data?.error || "Failed to start WhatsApp campaign")) };
    }
  }

  return {
    data: null,
    error: lastError instanceof Error ? lastError : new Error(String(lastError || "Failed to start WhatsApp campaign")),
  };
}

const formatDateLabel = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

const normalizeColumnKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

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

const extractTemplateParameters = (value: string) =>
  Array.from(value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g))
    .map((match) => match[1]?.trim())
    .filter(Boolean)
    .filter((token, index, values) => values.indexOf(token) === index);

const buildTemplateStructure = (template: CampaignTemplateOption) => ({
  hasHeader: false,
  headerType: null,
  headerHandleId: null,
  bodyParameters: extractTemplateParameters(template.body),
  category: template.category,
  previewBody: template.body,
});

const mapTemplateStatus = (value: string | null | undefined): "approved" | "pending" | "failed" => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "rejected" || normalized === "failed" || normalized === "paused") return "failed";
  return "pending";
};

const isHiddenMetaSampleTemplate = (name: string, normalizedName?: string | null) => {
  const normalized = String(normalizedName ?? name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  return normalized === "hello_world";
};

const normalizeTemplateResult = async (result: any) => {
  if (!("ok" in result)) {
    return result;
  }

  const payload = await result.json().catch(() => null);
  if (!result.ok) {
    return {
      data: [],
      error: {
        message:
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error?: unknown }).error)
            : "Failed to load WhatsApp templates",
      },
    };
  }

  return {
    data: Array.isArray(payload?.templates) ? payload.templates : [],
    error: null,
  };
};

const deriveVisibleWhatsappColumns = (contacts: Array<Record<string, unknown>>) => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const blockedKeys = new Set(["metadata", "id", "user_id", "campaign_id", "created_at", "updated_at"]);
  const aliasGroups = new Map<string, string>([
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

      const hasMeaningfulValue = contacts.some((row) => {
        const candidate = row[key];
        if (candidate == null) return false;
        if (typeof candidate === "object") return false;
        if (typeof candidate === "string") return candidate.trim() !== "";
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
  const priority = [
    "name",
    "Name",
    "first_name",
    "first name",
    "email",
    "Email",
    "phone_number",
    "phone number",
    "phone",
    "Phone",
    "mobile",
    "Mobile",
    "number",
  ];

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

export default function WhatsAppCampaignDetails() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { id } = useParams<{ id: string }>();
  const [selectedContactIndexes, setSelectedContactIndexes] = React.useState<number[]>([]);
  const [customContactFieldDialogOpen, setCustomContactFieldDialogOpen] = React.useState(false);
  const [customContactFieldName, setCustomContactFieldName] = React.useState("");
  const [editingContactIndex, setEditingContactIndex] = React.useState<number | null>(null);
  const [editingContactFields, setEditingContactFields] = React.useState<Record<string, string>>({});
  const [mutableContacts, setMutableContacts] = React.useState<CampaignContactRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState("");
  const [selectedAudienceId, setSelectedAudienceId] = React.useState("");
  const [startingCampaign, setStartingCampaign] = React.useState(false);

  const { data: campaign, isLoading, refetch } = useQuery({
    queryKey: ["whatsapp-campaign-detail", user?.id, id],
    enabled: !!user?.id && !!id,
    queryFn: async (): Promise<CampaignDetailRecord | null> => {
      const useWhatsappCampaigns = supportsWhatsappTable("whatsapp_campaigns");
      const useWhatsappAudienceContacts =
        supportsWhatsappTable("whatsapp_audience_contacts") && supportsWhatsappTable("whatsapp_contacts");
      const useLocalCampaignBackend = shouldUseLocalCampaignBackend();

      if (useWhatsappCampaigns) {
        const { data, error } = await (supabase as any)
          .from("whatsapp_campaigns")
          .select(
            "id, name, description, status, audience_id, template_id, started_at, completed_at, created_at, total_contacts, sent_count, failed_count, whatsapp_audiences(name), whatsapp_templates(name)",
          )
          .eq("user_id", user!.id)
          .eq("id", id)
          .maybeSingle();

        if (error) throw error;
        if (data) {
          let contacts: CampaignContactRecord[] = [];
          if (data.audience_id && useWhatsappAudienceContacts) {
            const [linksResult, contactsResult] = await Promise.all([
              (supabase as any)
                .from("whatsapp_audience_contacts")
                .select("contact_id")
                .eq("user_id", user!.id)
                .eq("audience_id", data.audience_id),
              (supabase as any)
                .from("whatsapp_contacts")
                .select("id, name, email, phone_number")
                .eq("user_id", user!.id),
            ]);

            if (linksResult.error) throw linksResult.error;
            if (contactsResult.error) throw contactsResult.error;

            const allowedIds = new Set((linksResult.data ?? []).map((row: any) => row.contact_id));
            contacts = (contactsResult.data ?? [])
              .filter((contact: any) => allowedIds.has(contact.id))
              .map((contact: any) => ({
                id: contact.id,
                name: contact.name?.trim() || contact.phone_number || "—",
                email: contact.email?.trim() || "—",
                phone: contact.phone_number?.trim() || "—",
              }));
          }

          return {
            id: data.id,
            name: data.name,
            description: data.description ?? "",
            audienceId: data.audience_id ?? null,
            templateId: data.template_id ?? null,
            audienceName: data.whatsapp_audiences?.name ?? "No audience",
            templateName: data.whatsapp_templates?.name ?? "No template",
            status: data.status,
            totalContacts: Number(data.total_contacts ?? contacts.length ?? 0),
            sentCount: Number(data.sent_count ?? 0),
            failedCount: Number(data.failed_count ?? 0),
            startedAtLabel: formatDateLabel(data.started_at),
            completedAtLabel: formatDateLabel(data.completed_at),
            createdAtLabel: formatDateLabel(data.created_at),
            contacts,
          };
        }
      }

      if (useLocalCampaignBackend) {
        const [campaignsResponse, audiencesResponse] = await Promise.all([
          fetch(`/api/local/whatsapp-campaigns?userId=${encodeURIComponent(user!.id)}`),
          fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`),
        ]);

        const campaignsPayload = campaignsResponse.ok ? await campaignsResponse.json().catch(() => null) : null;
        const audiencesPayload = audiencesResponse.ok ? await audiencesResponse.json().catch(() => null) : null;
        let rawCampaign = Array.isArray(campaignsPayload?.campaigns)
          ? campaignsPayload.campaigns.find((entry: any) => String(entry.id) === String(id))
          : null;

        if (!rawCampaign) {
          const { data: legacyCampaign } = await (supabase as any)
            .from("audience_campaigns")
            .select("*")
            .eq("user_id", user!.id)
            .eq("id", id)
            .maybeSingle();

          rawCampaign = legacyCampaign ?? null;
        }

        if (!rawCampaign && typeof window !== "undefined") {
          try {
            const stored = window.localStorage.getItem(getLocalCampaignStorageKey(user!.id));
            const parsed = stored ? JSON.parse(stored) : [];
            if (Array.isArray(parsed)) {
              rawCampaign = parsed.find((entry: any) => String(entry?.id) === String(id)) ?? null;
            }
          } catch {
            // Ignore unreadable local cache and continue to not-found state.
          }
        }

        if (!rawCampaign) return null;

        const rawAudience = Array.isArray(audiencesPayload?.audiences)
          ? audiencesPayload.audiences.find((entry: any) => entry.id === rawCampaign.audience_id)
          : null;
        const rawContacts = Array.isArray(audiencesPayload?.contacts) ? audiencesPayload.contacts : [];
        const allowedIds = new Set(Array.isArray(rawAudience?.contactIds) ? rawAudience.contactIds : []);

        return {
          id: rawCampaign.id,
          name: rawCampaign.name,
          description: rawCampaign.description ?? "",
          audienceId: rawCampaign.audience_id ?? null,
          templateId: rawCampaign.template_id ?? null,
          audienceName: rawAudience?.name ?? "No audience",
          templateName: rawCampaign.template_name ?? "No template",
          status: rawCampaign.status ?? "draft",
          totalContacts: Number(rawCampaign.total_contacts ?? allowedIds.size ?? 0),
          sentCount: Number(rawCampaign.sent_count ?? 0),
          failedCount: Number(rawCampaign.failed_count ?? 0),
          startedAtLabel: formatDateLabel(rawCampaign.started_at),
          completedAtLabel: formatDateLabel(rawCampaign.completed_at),
          createdAtLabel: formatDateLabel(rawCampaign.created_at),
          contacts: rawContacts
            .filter((contact: any) => allowedIds.has(contact.id))
            .map((contact: any) => ({
              id: contact.id,
              name: String(contact.name ?? contact.phone ?? "—").trim() || "—",
              email: "—",
              phone: String(contact.phone ?? "—").trim() || "—",
            })),
        };
      }

      const { data, error } = await (supabase as any)
        .from("audience_campaigns")
        .select("*")
        .eq("user_id", user!.id)
        .eq("id", id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      let contacts: CampaignContactRecord[] = [];
      if (data.audience_id) {
        const [linksResult, contactsResult] = await Promise.all([
          (supabase as any)
            .from("audience_segment_contacts")
            .select("contact_id")
            .eq("user_id", user!.id)
            .eq("audience_id", data.audience_id),
          supabase.from("contacts").select("id, first_name, phone_number").eq("user_id", user!.id),
        ]);

        if (!linksResult.error && !contactsResult.error) {
          const allowedIds = new Set((linksResult.data ?? []).map((row: any) => row.contact_id));
          contacts = (contactsResult.data ?? [])
            .filter((contact: any) => allowedIds.has(contact.id))
            .map((contact: any) => ({
              id: contact.id,
              name: contact.first_name?.trim() || contact.phone_number || "—",
              email: "—",
              phone: contact.phone_number?.trim() || "—",
            }));
        }
      }

      return {
        id: data.id,
        name: data.name,
        description: data.description ?? "",
        audienceId: data.audience_id ?? null,
        templateId: data.template_id ?? null,
        audienceName: "Audience",
        templateName: data.template_name ?? "No template",
        status: data.status ?? "draft",
        totalContacts: Number(data.total_contacts ?? contacts.length ?? 0),
        sentCount: Number(data.sent_count ?? 0),
        failedCount: Number(data.failed_count ?? 0),
        startedAtLabel: formatDateLabel(data.started_at),
        completedAtLabel: formatDateLabel(data.completed_at),
        createdAtLabel: formatDateLabel(data.created_at),
        contacts,
      };
    },
  });

  const { data: workspaceOptions } = useQuery({
    queryKey: ["whatsapp-campaign-workspace-options", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<{ templates: CampaignTemplateOption[]; audiences: CampaignAudienceOption[] }> => {
      const useWhatsappTemplates = supportsWhatsappTable("whatsapp_templates");
      const useWhatsappAudiences = supportsWhatsappTable("whatsapp_audiences");
      const useLocalCampaignBackend = shouldUseLocalCampaignBackend();

      const [templatesResult, audiencesResult] = await Promise.all([
        useWhatsappTemplates
          ? (supabase as any).from("whatsapp_templates").select("*").eq("user_id", user!.id).order("created_at", { ascending: false })
          : useLocalCampaignBackend
            ? fetch(
                `/api/local/whatsapp-templates?userId=${encodeURIComponent(user!.id)}&userEmail=${encodeURIComponent(user!.email ?? "")}`,
              )
            : (supabase as any).from("Templates").select("*").eq("user_email", user!.email ?? "").order("created_at", { ascending: false }),
        useWhatsappAudiences
          ? (supabase as any).from("whatsapp_audiences").select("id, name").eq("user_id", user!.id).order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ]);

      const normalizedTemplatesResult =
        !useWhatsappTemplates && useLocalCampaignBackend ? await normalizeTemplateResult(templatesResult) : templatesResult;

      if (normalizedTemplatesResult.error) throw normalizedTemplatesResult.error;
      if (audiencesResult.error) throw audiencesResult.error;

      const templates = (normalizedTemplatesResult.data ?? [])
        .map((template: any) => {
          const name = useWhatsappTemplates ? template.name : template.template_name;
          const normalizedName = useWhatsappTemplates
            ? template.normalized_name
            : String(template.template_name ?? "")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "_")
                .replace(/[^a-z0-9_]/g, "");

          return {
            id: template.id,
            name,
            normalizedName,
            body: useWhatsappTemplates ? template.body : template.body_text ?? template.content ?? "",
            category: String(template.category ?? (useWhatsappTemplates ? "utility" : "UTILITY")).toLowerCase(),
            language: template.language ?? "en_US",
            status: mapTemplateStatus(useWhatsappTemplates ? template.meta_status : template.status),
          };
        })
        .filter((template) => template.status === "approved")
        .filter((template) => !isHiddenMetaSampleTemplate(template.name, template.normalizedName)) as CampaignTemplateOption[];

      let audiences = (audiencesResult.data ?? []).map((audience: any) => ({
        id: audience.id,
        name: audience.name,
      })) as CampaignAudienceOption[];

      if (!useWhatsappAudiences) {
        if (shouldUseLocalCampaignBackend()) {
          const response = await fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`);
          const payload = response.ok ? await response.json().catch(() => null) : null;
          if (Array.isArray(payload?.audiences)) {
            audiences = payload.audiences.map((audience: any) => ({
              id: audience.id,
              name: audience.name,
            }));
          }
        } else {
          const { data, error } = await (supabase as any)
            .from("audience_segments")
            .select("id, name")
            .eq("user_id", user!.id)
            .order("created_at", { ascending: false });

          if (error) throw error;
          audiences = (data ?? []).map((audience: any) => ({
            id: audience.id,
            name: audience.name,
          }));
        }
      }

      return { templates, audiences };
    },
  });

  const { data: selectedAudienceContacts } = useQuery({
    queryKey: ["whatsapp-campaign-audience-contacts", user?.id, selectedAudienceId],
    enabled: !!user?.id && !!selectedAudienceId,
    queryFn: async (): Promise<CampaignContactRecord[]> => {
      const useWhatsappAudienceContacts =
        supportsWhatsappTable("whatsapp_audience_contacts") && supportsWhatsappTable("whatsapp_contacts");

      if (useWhatsappAudienceContacts) {
        const [linksResult, contactsResult] = await Promise.all([
          (supabase as any)
            .from("whatsapp_audience_contacts")
            .select("contact_id")
            .eq("user_id", user!.id)
            .eq("audience_id", selectedAudienceId),
          (supabase as any)
            .from("whatsapp_contacts")
            .select("id, name, email, phone_number")
            .eq("user_id", user!.id),
        ]);

        if (linksResult.error) throw linksResult.error;
        if (contactsResult.error) throw contactsResult.error;

        const allowedIds = new Set((linksResult.data ?? []).map((row: any) => row.contact_id));
        return (contactsResult.data ?? [])
          .filter((contact: any) => allowedIds.has(contact.id))
          .map((contact: any) => ({
            id: contact.id,
            name: contact.name?.trim() || contact.phone_number || "—",
            email: contact.email?.trim() || "—",
            phone: contact.phone_number?.trim() || "—",
          }));
      }

      if (shouldUseLocalCampaignBackend()) {
        const response = await fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`);
        const payload = response.ok ? await response.json().catch(() => null) : null;
        const rawAudience = Array.isArray(payload?.audiences)
          ? payload.audiences.find((entry: any) => entry.id === selectedAudienceId)
          : null;
        const rawContacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
        const allowedIds = new Set(Array.isArray(rawAudience?.contactIds) ? rawAudience.contactIds : []);

        return rawContacts
          .filter((contact: any) => allowedIds.has(contact.id))
          .map((contact: any) => ({
            id: contact.id,
            name: String(contact.name ?? contact.phone ?? "—").trim() || "—",
            email: "—",
            phone: String(contact.phone ?? "—").trim() || "—",
          }));
      }

      const [linksResult, contactsResult] = await Promise.all([
        (supabase as any)
          .from("audience_segment_contacts")
          .select("contact_id")
          .eq("user_id", user!.id)
          .eq("audience_id", selectedAudienceId),
        supabase.from("contacts").select("id, first_name, phone_number").eq("user_id", user!.id),
      ]);

      if (linksResult.error) throw linksResult.error;
      if (contactsResult.error) throw contactsResult.error;

      const allowedIds = new Set((linksResult.data ?? []).map((row: any) => row.contact_id));
      return (contactsResult.data ?? [])
        .filter((contact: any) => allowedIds.has(contact.id))
        .map((contact: any) => ({
          id: contact.id,
          name: contact.first_name?.trim() || contact.phone_number || "—",
          email: "—",
          phone: contact.phone_number?.trim() || "—",
        }));
    },
  });

  const campaignStatusLabel =
    campaign?.status ? campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1) : "Draft";
  const campaignContacts = mutableContacts;
  const contactColumns = React.useMemo(
    () => deriveVisibleWhatsappColumns(campaignContacts),
    [campaignContacts],
  );
  const progressTotal = Math.max(campaign?.totalContacts ?? 0, 1);
  const progressCount = (campaign?.sentCount ?? 0) + (campaign?.failedCount ?? 0);
  const progressValue = Math.min(100, (progressCount / progressTotal) * 100);
  const allContactsSelected = campaignContacts.length > 0 && selectedContactIndexes.length === campaignContacts.length;
  const availableTemplates = workspaceOptions?.templates ?? [];
  const availableAudiences = workspaceOptions?.audiences ?? [];

  React.useEffect(() => {
    const nextContacts = Array.isArray(campaign?.contacts) ? campaign.contacts : [];
    setMutableContacts(nextContacts);
    setSelectedContactIndexes(nextContacts.map((_, index) => index));
  }, [campaign]);

  React.useEffect(() => {
    if (!campaign) return;

    const resolvedTemplateId =
      campaign.templateId ??
      availableTemplates.find((template) => template.name === campaign.templateName || template.normalizedName === campaign.templateName)?.id ??
      "";
    const resolvedAudienceId =
      campaign.audienceId ??
      availableAudiences.find((audience) => audience.name === campaign.audienceName)?.id ??
      "";

    setSelectedTemplateId((current) => current || resolvedTemplateId);
    setSelectedAudienceId((current) => current || resolvedAudienceId);
  }, [availableAudiences, availableTemplates, campaign]);

  React.useEffect(() => {
    if (!selectedAudienceContacts) return;
    setMutableContacts(selectedAudienceContacts);
    setSelectedContactIndexes(selectedAudienceContacts.map((_, index) => index));
  }, [selectedAudienceContacts]);

  const toggleCampaignContact = (index: number) => {
    setSelectedContactIndexes((current) =>
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b),
    );
  };

  const openContactEditor = (contact: Record<string, unknown>, index: number) => {
    const blockedKeys = new Set(["metadata", "id", "user_id", "campaign_id", "created_at", "updated_at"]);
    const initialFields = Object.entries(contact)
      .filter(([key, value]) => !blockedKeys.has(key) && (value == null || typeof value !== "object"))
      .reduce<Record<string, string>>((acc, [key, value]) => {
        acc[key] = value == null ? "" : String(value);
        return acc;
      }, {});

    setEditingContactIndex(index);
    setEditingContactFields(initialFields);
  };

  const saveContactEdit = () => {
    if (editingContactIndex == null) return;

    setMutableContacts((current) =>
      current.map((contact, index) => {
        if (index !== editingContactIndex) return contact;

        const updated = { ...contact };
        Object.entries(editingContactFields).forEach(([key, value]) => {
          updated[key] = /phone|mobile|number/i.test(key) ? value.replace(/[^\d+]/g, "") : value;
        });
        return updated;
      }),
    );

    setEditingContactIndex(null);
    setEditingContactFields({});
    toast({ title: "Contact updated" });
  };

  const deleteContact = (index: number) => {
    setMutableContacts((current) => current.filter((_, contactIndex) => contactIndex !== index));
    setSelectedContactIndexes((current) =>
      current.filter((item) => item !== index).map((item) => (item > index ? item - 1 : item)),
    );
    toast({ title: "Contact deleted" });
  };

  const addContactColumn = () => {
    const rawName = customContactFieldName.trim();
    const fieldKey = normalizeCustomMessagingFieldKey(rawName);

    if (!rawName || !fieldKey) {
      toast({ title: "Invalid column name", description: "Enter a valid column name.", variant: "destructive" });
      return;
    }

    if (contactColumns.some((column) => normalizeColumnKey(column) === normalizeColumnKey(fieldKey))) {
      toast({ title: "Column already exists", description: "Use a different column name.", variant: "destructive" });
      return;
    }

    setMutableContacts((current) => current.map((contact) => ({ ...contact, [fieldKey]: "" })));
    setCustomContactFieldDialogOpen(false);
    setCustomContactFieldName("");
    toast({ title: "Column added" });
  };

  const handleStartCampaign = () => {
    void (async () => {
      if (!user?.id || !campaign) return;

      const selectedTemplate = availableTemplates.find((template) => template.id === selectedTemplateId);
      const selectedAudience = availableAudiences.find((audience) => audience.id === selectedAudienceId);

      if (!selectedTemplate) {
        toast({ title: "Select a template", description: "Choose a template before starting.", variant: "destructive" });
        return;
      }

      if (!selectedAudience) {
        toast({ title: "Select an audience", description: "Choose an audience before starting.", variant: "destructive" });
        return;
      }

      setStartingCampaign(true);
      const useWhatsappCampaigns = supportsWhatsappTable("whatsapp_campaigns");
      const updatePayload = {
        audience_id: selectedAudience.id,
        template_id: selectedTemplate.id,
        template_name: selectedTemplate.normalizedName || selectedTemplate.name,
        template_language: selectedTemplate.language,
        template_structure: buildTemplateStructure(selectedTemplate),
        status: "draft",
      };

      let updateError: string | null = null;

      if (useWhatsappCampaigns) {
        const { error } = await (supabase as any)
          .from("whatsapp_campaigns")
          .update(updatePayload)
          .eq("user_id", user.id)
          .eq("id", campaign.id);

        if (error) updateError = error.message;
      } else if (shouldUseLocalCampaignBackend()) {
        try {
          const response = await fetch("/api/local/whatsapp-campaigns", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user.id,
              campaignId: campaign.id,
              ...updatePayload,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            updateError = String(payload?.error || "Failed to update campaign");
          }
        } catch (error) {
          updateError = error instanceof Error ? error.message : String(error);
        }
      } else {
        const { error } = await (supabase as any)
          .from("audience_campaigns")
          .update(updatePayload)
          .eq("user_id", user.id)
          .eq("id", campaign.id);

        if (error) updateError = error.message;
      }

      if (updateError) {
        setStartingCampaign(false);
        toast({ title: "Unable to update campaign", description: updateError, variant: "destructive" });
        return;
      }

      let startError: string | null = null;

      const { data, error } = await invokeWhatsappCampaignFunction(campaign.id);
      if (error || data?.success === false) {
        startError = String(data?.error || error?.message || "Failed to start WhatsApp campaign");
      }

      setStartingCampaign(false);

      if (startError) {
        toast({
          title: "Unable to start campaign",
          description: startError,
          variant: "destructive",
        });
        return;
      }

      await refetch();
      toast({
        title: "Campaign started",
        description: "WhatsApp API send requests are running in the background. Delivery is tracked separately.",
      });
    })();
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#1f2635]">WhatsApp Campaigns</h1>
          <p className="mt-2 max-w-4xl text-sm text-[#6b7280]">
            Manage WhatsApp templates, extract contacts, run campaigns, and review completed sends.
          </p>
        </div>

        <div className="relative inline-grid h-auto w-full grid-cols-3 items-center justify-center overflow-hidden rounded-[22px] border border-[#f4f4f5] bg-[#fafafa] p-1">
          <Link
            to="/whatsapp/templates"
            className="flex items-center justify-center gap-2 rounded-[18px] px-4 py-1.5 text-[14px] font-medium text-[#6b7280] transition-colors hover:text-[#1f2635]"
          >
            <FileText className="h-4 w-4" />
            Template
          </Link>
          <Link
            to="/whatsapp/campaigns"
            className="flex items-center justify-center gap-2 rounded-[18px] bg-white px-4 py-1.5 text-[14px] font-medium text-[#1f2635] shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-colors"
          >
            <Megaphone className="h-4 w-4" />
            Campaigns
          </Link>
          <Link
            to="/whatsapp/campaigns?tab=completed"
            className="flex items-center justify-center gap-2 rounded-[18px] px-4 py-1.5 text-[14px] font-medium text-[#6b7280] transition-colors hover:text-[#1f2635]"
          >
            <RefreshCcw className="h-4 w-4" />
            Completed
          </Link>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" className="h-9 w-9">
              <Link to="/whatsapp/campaigns">
                <ArrowLeft className="h-5 w-5" />
              </Link>
            </Button>
            <h1 className="text-[24px] font-bold text-[#1f2635]">
              {isLoading ? "Loading campaign..." : campaign?.name ?? "Campaign details"}
            </h1>
          </div>

          {campaign ? (
            <Badge className="px-3 py-1 text-sm capitalize">{campaignStatusLabel}</Badge>
          ) : null}
        </div>

        {!isLoading && !campaign ? (
          <div className="rounded-[28px] border border-[#f4f4f5] bg-white px-8 py-10">
            <p className="text-[15px] text-[#7c7694]">Campaign not found.</p>
          </div>
        ) : null}

        {campaign ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardDescription>Total Contacts</CardDescription>
                  <CardTitle className="flex items-center gap-2 text-3xl">
                    <Users className="h-6 w-6 text-primary" />
                    {campaign.totalContacts}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-3">
                  <CardDescription>Accepted by API</CardDescription>
                  <CardTitle className="flex items-center gap-2 text-3xl">
                    <Megaphone className="h-6 w-6 text-primary" />
                    {campaign.sentCount}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardContent className="pt-6">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">Campaign Progress</span>
                  <span className="font-medium">{progressCount} / {Math.max(campaign.totalContacts, progressCount)}</span>
                </div>
                <Progress value={progressValue} className="h-3" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Campaign Details</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-8 md:grid-cols-2">
                  <div className="space-y-6">
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Audience:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.audienceName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Template:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.templateName || "—"}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Failed:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.failedCount}</span>
                    </div>
                  </div>

                  <div className="space-y-6">
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Created:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.createdAtLabel ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Started:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.startedAtLabel ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[15px]">
                      <span className="w-28 text-muted-foreground">Accepted:</span>
                      <span className="text-[16px] font-medium text-[#1f2635]">{campaign.sentCount}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-6 text-sm text-muted-foreground">
                  Accepted counts reflect Graph API acceptance, not confirmed handset delivery.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Users className="h-4 w-4" /> Contacts
                    </CardTitle>
                    <CardDescription>
                      {selectedContactIndexes.length} of {campaignContacts.length} selected
                    </CardDescription>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setCustomContactFieldDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Custom Field
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {campaignContacts.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">No contacts available for this campaign.</p>
                ) : (
                  <ScrollArea className="max-h-[420px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">
                            <Checkbox
                              checked={allContactsSelected}
                              onCheckedChange={(checked) =>
                                setSelectedContactIndexes(checked ? campaignContacts.map((_, index) => index) : [])
                              }
                              aria-label="Select all contacts"
                            />
                          </TableHead>
                          <TableHead className="w-12">#</TableHead>
                          {contactColumns.map((column) => (
                            <TableHead key={column}>{formatMessagingFieldLabel(column)}</TableHead>
                          ))}
                          <TableHead className="w-16">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {campaignContacts.map((contact, index) => (
                          <TableRow key={contact.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedContactIndexes.includes(index)}
                                onCheckedChange={() => toggleCampaignContact(index)}
                                aria-label={`Select contact ${index + 1}`}
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">{index + 1}</TableCell>
                            {contactColumns.map((column) => {
                              const value = contact[column];
                              const isPhoneField = /phone|mobile|number/i.test(column);

                              return (
                                <TableCell
                                  key={`${contact.id}-${column}`}
                                  className={isPhoneField ? "font-mono text-xs" : column.toLowerCase().includes("name") ? "font-medium" : ""}
                                >
                                  {typeof value === "string" && value.trim()
                                    ? value
                                    : value != null && value !== ""
                                      ? String(value)
                                      : "—"}
                                </TableCell>
                              );
                            })}
                            <TableCell>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8">
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => openContactEditor(contact, index)}>
                                    <Pencil className="mr-2 h-4 w-4" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() => deleteContact(index)}
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
                  <Phone className="h-4 w-4" /> Start Campaign
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Template</div>
                    <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select template" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableTemplates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Audience</div>
                    <Select value={selectedAudienceId} onValueChange={setSelectedAudienceId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select audience" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableAudiences.map((audience) => (
                          <SelectItem key={audience.id} value={audience.id}>
                            {audience.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button onClick={handleStartCampaign} disabled={startingCampaign || !selectedTemplateId || !selectedAudienceId}>
                  {startingCampaign ? "Starting..." : "Start Campaign"}
                </Button>
              </CardContent>
            </Card>
            <Dialog open={customContactFieldDialogOpen} onOpenChange={setCustomContactFieldDialogOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Add Column</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="custom-contact-field-name">Column Name</Label>
                    <Input
                      id="custom-contact-field-name"
                      value={customContactFieldName}
                      onChange={(event) => setCustomContactFieldName(event.target.value)}
                      placeholder="Company"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCustomContactFieldDialogOpen(false);
                      setCustomContactFieldName("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="button" onClick={addContactColumn}>
                    Add Column
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={editingContactIndex != null} onOpenChange={(open) => !open && setEditingContactIndex(null)}>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Edit Contact</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  {Object.entries(editingContactFields).map(([key, value]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`contact-field-${key}`}>{formatMessagingFieldLabel(key)}</Label>
                      <Input
                        id={`contact-field-${key}`}
                        value={value}
                        onChange={(event) =>
                          setEditingContactFields((current) => ({ ...current, [key]: event.target.value }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setEditingContactIndex(null)}>
                    Cancel
                  </Button>
                  <Button type="button" onClick={saveContactEdit}>
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
