import { connectedWorkspaceApps } from "@/lib/connected-apps";
import * as React from "react";
import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { getClerkToken, supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { summarizeCallTranscript } from "@/lib/analysis";
import { Plus, Search, Loader2, ArrowLeft, MapPin, Calendar, Clock, Sparkles, Download, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { getErrorMessage } from "@/lib/edge-functions";
import { invokeAuthedFunction, isLocalDevHost } from "@/lib/local-functions";
import { useNavigate } from "react-router-dom";
import { getVibePath } from "@/lib/vibe-routes";
import type { Tables } from "@/integrations/supabase/types";

interface Outcome {
  id: string; campaign_id: string; phone_number: string; parent_name: string | null;
  child_names: string | null; venue_name: string | null; outcome: string;
  transcript: string | null; summary: string | null; attempt_number: number;
  call_timestamp: string; contact_id: string | null;
}

interface Campaign {
  agent_id: string | null; id: string; venue_name: string; venue_location: string | null; round: number;
  age_range: string | null; times: string | null; start_date: string | null;
  end_date: string | null; booking_target: number | null; status: string;
  notes: string | null; calls_made: number; total_contacts: number; created_at?: string | null;
}

interface CallLog {
  id: string; status: string; duration: number | null; started_at: string;
  ended_at: string | null; recipient_number: string | null; caller_number: string | null;
  direction: string; transcript: any; summary: string | null;
}

interface GoogleSheetFile {
  id: string;
  name: string;
  webViewLink: string;
  modifiedTime: string;
}

type OutcomeActionId = "gmail" | "google_sheets" | "google_docs" | "export";

type Contact = Tables<"contacts">;
const PLACEHOLDER_PATTERN = /<<\s*([^>]+?)\s*>>/g;
type EmailTemplateConfig = {
  to: string;
  subject: string;
  body: string;
};

const DEFAULT_EMAIL_TEMPLATE: EmailTemplateConfig = {
  to: "<<email>>",
  subject: "",
  body: "",
};

const parseEmailTemplateConfig = (value: string | null | undefined): EmailTemplateConfig => {
  if (!value) return DEFAULT_EMAIL_TEMPLATE;

  try {
    const parsed = JSON.parse(value) as Partial<EmailTemplateConfig>;
    return {
      to: typeof parsed.to === "string" && parsed.to.trim() ? parsed.to : DEFAULT_EMAIL_TEMPLATE.to,
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return {
      ...DEFAULT_EMAIL_TEMPLATE,
      body: value,
    };
  }
};

const FIXED_CONTACT_COLUMN_KEYS = new Set([
  "first_name",
  "name",
  "full_name",
  "email",
  "phone_number",
  "phone",
  "phonenumber",
  "s.no",
  "sno",
  "serial_no",
  "serial_number",
  "child_names",
  "venue_name",
  "venue_location",
  "start_date",
  "end_date",
  "times",
  "age_range",
  "language",
]);

const formatDynamicFieldLabel = (key: string) =>
  key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

const normalizeDynamicColumnKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]+/g, "");

const FIXED_CONTACT_COLUMN_NORMALIZED_KEYS = new Set(
  Array.from(FIXED_CONTACT_COLUMN_KEYS).map(normalizeDynamicColumnKey),
);

const getContactMetadata = (contact?: Contact) =>
  contact?.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
    ? contact.metadata as Record<string, unknown>
    : {};

const getContactDisplayName = (contact?: Contact) => {
  if (!contact) return "";
  const metadata = getContactMetadata(contact);
  const directName = String(contact.first_name || "").trim();
  if (directName) return directName;

  const fallbackName =
    String(metadata.name || "").trim() ||
    String(metadata.full_name || "").trim() ||
    String(metadata.first_name || "").trim();
  if (fallbackName) return fallbackName;

  const email = String(metadata.email || "").trim();
  if (email.includes("@")) return email.split("@")[0];

  return String(contact.phone_number || "").trim();
};

const getContactEmail = (contact?: Contact) => String(getContactMetadata(contact).email || "").trim();

const extractFunctionErrorMessage = async (error: unknown) => {
  const fallback = getErrorMessage(error) || "Could not load your Google Sheets files.";
  if (!error || typeof error !== "object" || !("context" in error)) {
    return fallback;
  }

  const context = (error as { context?: unknown }).context;
  if (!(context instanceof Response)) {
    return fallback;
  }

  try {
    const payload = await context.clone().json().catch(() => null);
    if (payload && typeof payload === "object") {
      const apiMessage =
        ("error" in payload && typeof payload.error === "string" && payload.error) ||
        ("message" in payload && typeof payload.message === "string" && payload.message);
      if (apiMessage) return apiMessage;
    }
  } catch {
    return fallback;
  }

  return fallback;
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-green-100 text-green-800",
  paused: "bg-yellow-100 text-yellow-800",
  completed: "bg-primary text-primary-foreground",
};

const OUTCOME_COLORS: Record<string, string> = {
  ANSWERED: "bg-green-100 text-green-800", DECLINED: "bg-red-100 text-red-800",
  FLAGGED_REVIEW: "bg-yellow-100 text-yellow-800", VOICEMAIL: "bg-blue-100 text-blue-800",
  NO_ANSWER: "bg-muted text-muted-foreground", PENDING: "bg-muted text-muted-foreground",
  "NO ANSWER": "bg-muted text-muted-foreground", FAILED: "bg-red-100 text-red-800",
};

const OUTCOMES = ["ALL", "ANSWERED", "DECLINED", "NO_ANSWER", "PENDING", "VOICEMAIL", "FLAGGED_REVIEW"];

const GOOGLE_SHEETS_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
      <path d="M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5L14.5 2Z" fill="#34A853"/>
      <path d="M14 2v5h5" fill="#A8DAB5"/>
      <path d="M8 10.5h8M8 13.5h8M8 16.5h8M11 8v11" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
    </svg>
  `);

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

const normalizeComparablePhone = (raw: string | null | undefined) =>
  String(raw || "").replace(/\D/g, "");

export default function OutcomesTab() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
  const [filterOutcome, setFilterOutcome] = useState("ALL");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCallLog, setSelectedCallLog] = useState<CallLog | null>(null);
  const [selectedCampaignCallLogs, setSelectedCampaignCallLogs] = useState<CallLog[]>([]);

  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summarizing, setSummarizing] = useState<Record<string, boolean>>({});

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addForm, setAddForm] = useState({ campaign_id: "", phone_number: "", parent_name: "", child_names: "", venue_name: "", outcome: "PENDING", transcript: "", summary: "", attempt_number: "1" });

  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editName, setEditName] = useState("");
  const [updating, setUpdating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletingCampaign, setDeletingCampaign] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [activeActions, setActiveActions] = useState<OutcomeActionId[]>([]);
  const [sheetPickerOpen, setSheetPickerOpen] = useState(false);
  const [sheetTargetMode, setSheetTargetMode] = useState<"new" | "existing">("new");
  const [existingSheets, setExistingSheets] = useState<GoogleSheetFile[]>([]);
  const [loadingExistingSheets, setLoadingExistingSheets] = useState(false);
  const [selectedExistingSheetId, setSelectedExistingSheetId] = useState("");
  const [existingSheetsError, setExistingSheetsError] = useState<string | null>(null);
  const [selectedOutcomeIds, setSelectedOutcomeIds] = useState<string[]>([]);
  const [syncingSheet, setSyncingSheet] = useState(false);
  const [creatingDocs, setCreatingDocs] = useState(false);
  const [selectedAgentBodyTemplate, setSelectedAgentBodyTemplate] = useState<EmailTemplateConfig>(DEFAULT_EMAIL_TEMPLATE);

  useEffect(() => {
    if (!user) {
      setConnectedProviders([]);
      return;
    }

    let cancelled = false;
    const fetchGoogleConnections = async () => {
      if (isLocalDevHost()) {
        const response = await fetch("/api/local/calendar-integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await getClerkToken()) ?? ""}` },
          body: JSON.stringify({
            action: "load",
            userId: user.id,
            userEmail: user.email || "",
            providers: ["google_sheets", "gmail", "google_docs"],
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!cancelled) {
          const integrations = response.ok && Array.isArray(payload?.integrations) ? payload.integrations : [];
          setConnectedProviders(
            integrations
              .map((entry: { provider?: string | null }) => entry.provider)
              .filter((provider: string | null | undefined): provider is string => typeof provider === "string"),
          );
        }
        return;
      }

      const apps = await connectedWorkspaceApps(user.id); // older Google sign-in + Gmail connected in CRM Integrations
      if (!cancelled) setConnectedProviders(apps.map((entry) => entry.provider).filter((p) => ["gmail", "google_sheets", "google_docs"].includes(p)));
    };

    void fetchGoogleConnections();

    const channel = supabase
      .channel("google-sheets-integration-status")
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_integrations" }, () => {
        void fetchGoogleConnections();
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);

  useEffect(() => {
    const nextDefaultActions: OutcomeActionId[] = [];
    if (connectedProviders.includes("gmail")) nextDefaultActions.push("gmail");
    if (connectedProviders.includes("google_sheets")) nextDefaultActions.push("google_sheets");
    nextDefaultActions.push("export");

    setActiveActions((current) => {
      const validCurrent = current.filter((action) =>
        action === "export" ||
        (action === "gmail" && connectedProviders.includes("gmail")) ||
        (action === "google_sheets" && connectedProviders.includes("google_sheets")) ||
        (action === "google_docs" && connectedProviders.includes("google_docs")),
      );

      if (validCurrent.length > 0) return validCurrent;
      return nextDefaultActions;
    });
  }, [connectedProviders]);

  const gmailConnected = connectedProviders.includes("gmail");
  const googleSheetsConnected = connectedProviders.includes("google_sheets");
  const googleDocsConnected = connectedProviders.includes("google_docs");

  const actionCatalog: Array<{ id: OutcomeActionId; label: string; logo?: string | null }> = [
    ...(gmailConnected ? [{ id: "gmail" as const, label: "Email", logo: GMAIL_LOGO }] : []),
    ...(googleSheetsConnected ? [{ id: "google_sheets" as const, label: "Sheets", logo: GOOGLE_SHEETS_LOGO }] : []),
    ...(googleDocsConnected ? [{ id: "google_docs" as const, label: "Google Docs", logo: GOOGLE_DOCS_LOGO }] : []),
    { id: "export" as const, label: "Export", logo: null },
  ];

  const addOutcomeAction = (actionId: OutcomeActionId) => {
    setActiveActions((current) => (current.includes(actionId) ? current : [...current, actionId]));
  };

  const removeOutcomeAction = (actionId: OutcomeActionId) => {
    setActiveActions((current) => current.filter((item) => item !== actionId));
  };

  useEffect(() => {
    if (!selectedCampaign?.agent_id) {
      setSelectedAgentBodyTemplate(DEFAULT_EMAIL_TEMPLATE);
      return;
    }

    let cancelled = false;
    const loadAgentTemplate = async () => {
      if (isLocalDevHost() && user) {
        const payload = await invokeAuthedFunction<any>("agent-crm-data", {
            action: "load",
            agentId: selectedCampaign.agent_id,
            userId: user.id,
            userEmail: user.email || "",
        });
        if (!cancelled) {
          const agent = payload?.agent && typeof payload.agent === "object" ? payload.agent : null;
          setSelectedAgentBodyTemplate(
            parseEmailTemplateConfig(typeof agent?.gmail_body_template === "string" ? agent.gmail_body_template : ""),
          );
        }
        return;
      }

      const { data } = await supabase
        .from("agents")
        .select("gmail_body_template")
        .eq("id", selectedCampaign.agent_id)
        .maybeSingle();

      if (!cancelled) {
        setSelectedAgentBodyTemplate(
          parseEmailTemplateConfig(typeof data?.gmail_body_template === "string" ? data.gmail_body_template : ""),
        );
      }
    };

    void loadAgentTemplate();

    return () => {
      cancelled = true;
    };
  }, [selectedCampaign?.agent_id, user]);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedCampaign) return;

    const savedConfig = window.localStorage.getItem(`campaign-sheet-target:${selectedCampaign.id}`);
    if (!savedConfig) {
      setSheetTargetMode("new");
      setSelectedExistingSheetId("");
      return;
    }

    try {
      const parsed = JSON.parse(savedConfig) as { mode?: "new" | "existing"; url?: string; id?: string };
      setSheetTargetMode(parsed.mode === "existing" ? "existing" : "new");
      setSelectedExistingSheetId(parsed.id || "");
    } catch {
      setSheetTargetMode("new");
      setSelectedExistingSheetId("");
    }
  }, [selectedCampaign]);

  useEffect(() => {
    if (!sheetPickerOpen || sheetTargetMode !== "existing" || !googleSheetsConnected) return;

    let cancelled = false;
    const loadExistingSheets = async () => {
      setLoadingExistingSheets(true);
      setExistingSheetsError(null);
      try {
        let data: { files?: GoogleSheetFile[] } | null = null;

        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Please sign in again and retry.");
        }

        const result = await supabase.functions.invoke("list-google-sheets", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (result.error) throw result.error;
        data = result.data;

        const files = (((data?.files as GoogleSheetFile[] | undefined) || []).filter((file) => file.webViewLink));
        if (cancelled) return;

        setExistingSheets(files);
        setSelectedExistingSheetId((current) => current || files[0]?.id || "");
      } catch (error: any) {
        if (cancelled) return;
        const message = await extractFunctionErrorMessage(error);
        setExistingSheetsError(message);
        toast({
          title: "Could not load Google Sheets",
          description: message,
          variant: "destructive",
        });
        setExistingSheets([]);
      } finally {
        if (!cancelled) setLoadingExistingSheets(false);
      }
    };

    void loadExistingSheets();

    return () => {
      cancelled = true;
    };
  }, [googleSheetsConnected, sheetPickerOpen, sheetTargetMode, toast]);

  const fetchData = useCallback(async () => {
    if (!user) return;
    if (isLocalDevHost()) {
      const payload = await invokeAuthedFunction<any>("voice-campaign-data", {
        userId: user.id,
        userEmail: user.email || "",
      });

      const nextOutcomes = (Array.isArray(payload?.callOutcomes) ? payload.callOutcomes : []) as Outcome[];
      const nextCampaigns = (Array.isArray(payload?.campaigns) ? payload.campaigns : []) as Campaign[];
      const logs = (Array.isArray(payload?.callLogs) ? payload.callLogs : []) as CallLog[];
      const nextContacts = Array.isArray(payload?.contacts) ? payload.contacts : [];

      setOutcomes(nextOutcomes);
      setCampaigns(nextCampaigns);
      setCallLogs(logs);
      setContacts(nextContacts);

      const savedSummaries: Record<string, string> = {};
      for (const log of logs) {
        if (log.summary) savedSummaries[log.id] = log.summary;
      }
      setSummaries((prev) => ({ ...savedSummaries, ...prev }));
      setLoading(false);
      return;
    }

    const [outcomesRes, campaignsRes, callLogsRes, contactsRes] = await Promise.all([
      supabase.from("call_outcomes").select("*").order("call_timestamp", { ascending: false }),
      supabase.from("campaigns").select("id, agent_id, venue_name, venue_location, round, age_range, times, start_date, end_date, booking_target, status, notes, calls_made, total_contacts, created_at").order("created_at", { ascending: false }),
      supabase.from("call_logs").select("*").order("started_at", { ascending: false }),
      supabase.from("contacts").select("*"),
    ]);
    setOutcomes((outcomesRes.data as Outcome[]) || []);
    setCampaigns((campaignsRes.data as Campaign[]) || []);
    const logs = (callLogsRes.data as CallLog[]) || [];
    setCallLogs(logs);
    setContacts(contactsRes.data || []);
    // Load persisted summaries from call_logs
    const savedSummaries: Record<string, string> = {};
    for (const log of logs) {
      if (log.summary) savedSummaries[log.id] = log.summary;
    }
    setSummaries((prev) => ({ ...savedSummaries, ...prev }));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchData();
    const channel = supabase
      .channel('outcomes-call-logs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_logs' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_outcomes' }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchData]);

  useEffect(() => {
    if (!selectedCampaign) {
      setSelectedCampaignCallLogs([]);
      return;
    }

    const campContacts = contacts.filter((c) => c.campaign_id === selectedCampaign.id);
    const campPhoneDigits = new Set(campContacts.map((c) => normalizeComparablePhone(c.phone_number)));
    // Calls to this campaign's contacts made since the campaign was created (earlier calls to the same number aren't part of it).
    const campaignCreatedAt = new Date(selectedCampaign.created_at || 0).getTime();
    const matchedLogs = callLogs.filter(
      (cl) => cl.recipient_number && campPhoneDigits.has(normalizeComparablePhone(cl.recipient_number)) && new Date(cl.started_at).getTime() >= campaignCreatedAt,
    );

    setSelectedCampaignCallLogs(matchedLogs);
  }, [selectedCampaign, callLogs, contacts]);

  const handleAddOutcome = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const { error } = await supabase.from("call_outcomes").insert({
      user_id: user.id, campaign_id: addForm.campaign_id, phone_number: addForm.phone_number,
      parent_name: addForm.parent_name || null, child_names: addForm.child_names || null,
      venue_name: addForm.venue_name || null, outcome: addForm.outcome, transcript: addForm.transcript || null,
      summary: addForm.summary || null, attempt_number: parseInt(addForm.attempt_number) || 1,
    });
    if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); }
    else {
      toast({ title: "Outcome added" });
      if (addForm.outcome === "ANSWERED" || addForm.outcome === "DECLINED") {
        await supabase.from("do_not_call").insert({ user_id: user.id, phone_number: addForm.phone_number, reason: addForm.outcome, parent_name: addForm.parent_name || null, venue_name: addForm.venue_name || null });
      }
      setAddDialogOpen(false);
      setAddForm({ campaign_id: "", phone_number: "", parent_name: "", child_names: "", venue_name: "", outcome: "PENDING", transcript: "", summary: "", attempt_number: "1" });
    }
  };

  const handleUpdateCampaignName = async () => {
    if (!editingCampaign || !editName.trim() || !user) return;
    setUpdating(true);
    try {
      const { error } = await supabase
        .from("campaigns")
        .update({ venue_name: editName.trim() })
        .eq("id", editingCampaign.id);

      if (error) throw error;
      
      toast({ title: "Campaign updated" });
      setEditingCampaign(null);
      await fetchData();
    } catch (err: any) {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    } finally {
      setUpdating(false);
    }
  };

  const handleDeleteCampaign = (id: string, name: string) => {
    setDeleteTarget({ id, name });
  };

  const confirmDeleteCampaign = async () => {
    if (!deleteTarget) return;
    setDeletingCampaign(true);
    try {
      const { error } = await supabase.from("campaigns").delete().eq("id", deleteTarget.id);
      if (error) throw error;

      toast({ title: "Campaign deleted" });
      if (selectedCampaign?.id === deleteTarget.id) setSelectedCampaign(null);
      setDeleteTarget(null);
      await fetchData();
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally {
      setDeletingCampaign(false);
    }
  };

  const openSheetPicker = () => {
    if (!googleSheetsConnected) {
      toast({
        title: "Connect Google Sheets first",
        description: "Google Sheets is not connected yet. Opening CRM Integrations now.",
      });
      navigate(getVibePath("voice", "crm-integrations"));
      return;
    }

    setSheetPickerOpen(true);
  };

  const handleOpenInSheets = async (
    campaignName: string,
    logs: CallLog[],
    getContactForLog: (cl: CallLog) => { campaign_id: string; phone_number: string; first_name: string; child_names: string | null } | undefined,
    attemptMap: Record<string, number>,
  ) => {
    if (!selectedCampaign) return;

    const pendingSheetTab = window.open("", "_blank");
    if (pendingSheetTab) {
      pendingSheetTab.document.title = "Opening Google Sheets...";
      pendingSheetTab.document.body.innerHTML =
        '<div style="font-family: sans-serif; padding: 24px;">Preparing your Google Sheet...</div>';
    }

    if (sheetTargetMode === "existing") {
      const selectedSheet = existingSheets.find((sheet) => sheet.id === selectedExistingSheetId);
      if (!selectedSheet) {
        toast({
          title: "Select a Google Sheet",
          description: "Choose one of your existing Google Sheets before opening it.",
          variant: "destructive",
        });
        return;
      }
    }

    const rowsToSync = (selectedOutcomeIds.length > 0
      ? logs.filter((log) => selectedOutcomeIds.includes(log.id))
      : logs
    ).map((cl) => {
      const contact = getContactForLog(cl);
      const result = getCallResult(cl);
      const transcriptText = formatTranscript(cl.transcript) || "";
      const summary = summaries[cl.id] || "";
      const attempt = attemptMap[cl.id] || 1;

      return [
        new Date(cl.started_at).toLocaleString(),
        contact?.first_name || "",
        cl.recipient_number || "",
        contact?.child_names || "",
        attempt > 1 ? `Retry #${attempt}` : "1st",
        result,
        formatDuration(cl.duration),
        transcriptText,
        summary,
      ];
    });

    if (!rowsToSync.length) {
      toast({
        title: "No outcomes to sync",
        description: "There are no campaign rows available for Google Sheets.",
        variant: "destructive",
      });
      return;
    }

    const selectedSheet = existingSheets.find((sheet) => sheet.id === selectedExistingSheetId);

    setSyncingSheet(true);
    try {
      const payloadRows = [
        ["Time", "Contact", "Phone", "Children", "Attempt", "Result", "Duration", "Transcript", "AI Summary"],
        ...rowsToSync,
      ];

      let data: any = null;
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;

      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        throw new Error("Your session expired. Please sign in again and retry.");
      }

      const result = await supabase.functions.invoke("sync-google-sheet", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: {
          mode: sheetTargetMode,
          campaignName,
          sheetId: sheetTargetMode === "existing" ? selectedSheet?.id || "" : "",
          rows: payloadRows,
        },
      });
      if (result.error) throw result.error;
      data = result.data;

      const spreadsheetId = data?.spreadsheetId ? String(data.spreadsheetId) : "";
      const spreadsheetUrl = data?.spreadsheetUrl ? String(data.spreadsheetUrl) : "";
      if (!spreadsheetId || !spreadsheetUrl) {
        throw new Error("Google Sheets sync completed, but no sheet URL was returned.");
      }

      window.localStorage.setItem(
        `campaign-sheet-target:${selectedCampaign.id}`,
        JSON.stringify({
          mode: "existing",
          id: spreadsheetId,
          url: spreadsheetUrl,
        }),
      );

      setSelectedExistingSheetId(spreadsheetId);
      setSheetPickerOpen(false);
      if (pendingSheetTab) {
        pendingSheetTab.location.href = spreadsheetUrl;
      } else {
        window.open(spreadsheetUrl, "_blank", "noopener,noreferrer");
      }
      toast({
        title: "Google Sheet synced",
        description: `${rowsToSync.length} outcome row${rowsToSync.length === 1 ? "" : "s"} written to Google Sheets.`,
      });
    } catch (error: any) {
      pendingSheetTab?.close();
      const message = await extractFunctionErrorMessage(error);
      toast({
        title: "Google Sheets sync failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSyncingSheet(false);
    }
  };


  const handleSummarize = async (callLogId: string) => {
    setSummarizing((prev) => ({ ...prev, [callLogId]: true }));
    try {
      let summaryText = "";
      const callLog = callLogs.find((log) => log.id === callLogId);
      const transcriptText = callLog ? formatTranscript(callLog.transcript) : null;
      if (!callLog || !transcriptText) {
        throw new Error("No transcript available for this call.");
      }

      const matchedContact = contacts.find((contact) => normalizeComparablePhone(contact.phone_number) === normalizeComparablePhone(callLog.recipient_number));
      summaryText = await summarizeCallTranscript({
        transcript: transcriptText,
        direction: callLog.direction,
        durationSeconds: callLog.duration,
        phoneNumber: callLog.direction === "inbound" ? callLog.caller_number : callLog.recipient_number,
        agentName: matchedContact?.first_name || null,
      });

      if (!summaryText) {
        summaryText = "No summary generated.";
      }
      setSummaries((prev) => ({ ...prev, [callLogId]: summaryText }));
      // Persist to database
      await supabase.from("call_logs").update({ summary: summaryText } as any).eq("id", callLogId);
      toast({ title: "Summary generated & saved" });
    } catch (err: any) {
      toast({ title: "Summary failed", description: err.message, variant: "destructive" });
    } finally {
      setSummarizing((prev) => ({ ...prev, [callLogId]: false }));
    }
  };

  const getOutcomesForCampaign = (campaignId: string) => outcomes.filter((o) => o.campaign_id === campaignId);
  const getOutcomeCounts = (campOutcomes: Outcome[]) =>
    campOutcomes.reduce((acc, o) => { acc[o.outcome] = (acc[o.outcome] || 0) + 1; return acc; }, {} as Record<string, number>);

  const CALL_STATUS_COLORS: Record<string, string> = {
    completed: "bg-green-100 text-green-800",
    "no-answer": "bg-muted text-muted-foreground",
    busy: "bg-yellow-100 text-yellow-800",
    failed: "bg-red-100 text-red-800",
    canceled: "bg-muted text-muted-foreground",
    initiated: "bg-blue-100 text-blue-800",
    "in-progress": "bg-blue-100 text-blue-800",
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "0s";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const formatTranscript = (transcript: any): string | null => {
    if (!transcript) return null;
    if (Array.isArray(transcript)) {
      return transcript.map((t: any) => `${t.role || "unknown"}: ${t.text || ""}`).join("\n");
    }
    if (typeof transcript === "string") return transcript;
    return JSON.stringify(transcript, null, 2);
  };

  const truncateText = (text: string | null, maxLen: number) => {
    if (!text) return null;
    return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  };

  const getCallResult = (cl: CallLog) => {
    if (cl.status === "completed" && (cl.duration || 0) > 10) return "ANSWERED";
    if (cl.status === "completed" && (cl.duration || 0) <= 10) return "VOICEMAIL";
    if (["no-answer", "canceled", "busy"].includes(cl.status)) return "NO ANSWER";
    if (cl.status === "failed") return "FAILED";
    if (["initiated", "in-progress", "ringing", "queued"].includes(cl.status)) return "PENDING";
    return cl.status.toUpperCase();
  };

  const normalizePlaceholderKey = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s-]+/g, "_");

  const getContactTemplateValues = (contact?: Contact) => {
    const values = new Map<string, string>();
    if (!contact) return values;

    const addValue = (key: string, rawValue: unknown) => {
      if (rawValue == null) return;
      const value = String(rawValue).trim();
      if (!value) return;
      values.set(normalizePlaceholderKey(key), value);
    };

    const metadata = contact.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
      ? contact.metadata as Record<string, unknown>
      : {};

    addValue("name", contact.first_name);
    addValue("first_name", contact.first_name);
    addValue("email", metadata.email);
    addValue("phone", contact.phone_number);
    addValue("phone_number", contact.phone_number);
    addValue("child_names", contact.child_names);
    addValue("venue_name", contact.venue_name);
    addValue("venue_location", contact.venue_location);
    addValue("start_date", contact.start_date);
    addValue("end_date", contact.end_date);
    addValue("times", contact.times);
    addValue("age_range", contact.age_range);
    addValue("language", contact.language);

    Object.entries(metadata).forEach(([key, value]) => {
      addValue(key, value);
    });

    return values;
  };

  const renderTemplateString = (template: string, contact?: Contact) => {
    const values = getContactTemplateValues(contact);
    const missing = new Set<string>();
    const rendered = template.replace(PLACEHOLDER_PATTERN, (_, token: string) => {
      const normalized = normalizePlaceholderKey(token);
      const value = values.get(normalized);
      if (!value) {
        missing.add(token.trim());
        return "";
      }
      return value;
    });
    return { rendered, missing: Array.from(missing) };
  };

  const handleOpenEmail = (logs: CallLog[], getContactForLog: (cl: CallLog) => Contact | undefined) => {
    if (!gmailConnected) {
      toast({
        title: "Connect Gmail first",
        description: "Gmail is not connected yet. Opening CRM Integrations now.",
      });
      navigate(getVibePath("voice", "crm-integrations"));
      return;
    }

    if (
      !selectedCampaign?.agent_id ||
      (!selectedAgentBodyTemplate.to.trim() &&
        !selectedAgentBodyTemplate.subject.trim() &&
        !selectedAgentBodyTemplate.body.trim())
    ) {
      toast({
        title: "Add a body template first",
        description: "Configure the agent email template in the agent Tools tab before opening Gmail.",
        variant: "destructive",
      });
      return;
    }

    const targetLogs = logs.filter((log) => selectedOutcomeIds.includes(log.id));
    if (targetLogs.length === 0) {
      toast({
        title: "Select at least one outcome",
        description: "Choose one or more campaign rows to open Gmail with the resolved body template.",
        variant: "destructive",
      });
      return;
    }

    let openedCount = 0;
    let skippedCount = 0;
    const missingFields = new Set<string>();

    for (const log of targetLogs) {
      const contact = getContactForLog(log);
      const { rendered: renderedTo, missing: missingTo } = renderTemplateString(selectedAgentBodyTemplate.to, contact);
      const { rendered: renderedSubject, missing: missingSubject } = renderTemplateString(selectedAgentBodyTemplate.subject, contact);
      const { rendered: renderedBody, missing: missingBody } = renderTemplateString(selectedAgentBodyTemplate.body, contact);
      const email = renderedTo.trim();

      if (!email) {
        skippedCount += 1;
        continue;
      }

      [...missingTo, ...missingSubject, ...missingBody].forEach((field) => missingFields.add(field));

      const gmailUrl = new URL("https://mail.google.com/mail/");
      gmailUrl.searchParams.set("view", "cm");
      gmailUrl.searchParams.set("fs", "1");
      gmailUrl.searchParams.set("tf", "1");
      gmailUrl.searchParams.set("to", email);
      if (renderedSubject.trim()) {
        gmailUrl.searchParams.set("su", renderedSubject);
      }
      if (renderedBody) {
        gmailUrl.searchParams.set("body", renderedBody);
      }

      const popup = window.open(gmailUrl.toString(), "_blank", "noopener,noreferrer");
      if (popup) openedCount += 1;
    }

    if (openedCount === 0) {
      toast({
        title: "No emails opened",
        description: skippedCount > 0
          ? "The selected rows do not have an email value in the campaign data."
          : "Your browser blocked the Gmail compose window.",
        variant: "destructive",
      });
      return;
    }

    const missingSuffix = missingFields.size > 0
      ? ` Missing placeholders were left blank: ${Array.from(missingFields).join(", ")}.`
      : "";

    toast({
      title: openedCount === 1 ? "Gmail compose opened" : `Opened ${openedCount} Gmail drafts`,
      description: `${skippedCount > 0 ? `${skippedCount} row${skippedCount === 1 ? " was" : "s were"} skipped because email was missing.` : "Template values were filled from campaign data."}${missingSuffix}`,
    });
  };

  const handleOpenGoogleDocs = async (logs: CallLog[], getContactForLog: (cl: CallLog) => Contact | undefined) => {
    if (!googleDocsConnected) {
      toast({
        title: "Connect Google Docs first",
        description: "Google Docs is not connected yet. Opening CRM Integrations now.",
      });
      navigate(getVibePath("voice", "crm-integrations"));
      return;
    }

    const targetLogs = logs.filter((log) => selectedOutcomeIds.includes(log.id));
    if (targetLogs.length !== 1) {
      toast({
        title: "Select one outcome",
        description: "Choose exactly one campaign row to create a Google Doc summary.",
        variant: "destructive",
      });
      return;
    }

    setCreatingDocs(true);
    try {
      const documentUrls: string[] = [];

      for (const log of targetLogs) {
        const contact = getContactForLog(log);
        const result = getCallResult(log);
        const transcriptText = formatTranscript(log.transcript) || "";
        const summary = summaries[log.id] || "";
        const payloadRows = [
          ["Time", "Contact", "Email", "Phone", "Attempt", "Result", "Duration", "Transcript", "AI Summary"],
          [
            new Date(log.started_at).toLocaleString(),
            getContactDisplayName(contact),
            getContactEmail(contact),
            log.recipient_number || "",
            "1st",
            result,
            formatDuration(log.duration),
            transcriptText,
            summary,
          ],
        ];

        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Please sign in again and retry.");
        }

        const response = await supabase.functions.invoke("create-google-doc-summary", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: {
            agentId: selectedCampaign?.agent_id || "",
            campaignName: selectedCampaign?.venue_name || "Campaign",
            contactName: getContactDisplayName(contact) || "Customer",
            contactEmail: getContactEmail(contact),
            phone: log.recipient_number || "",
            result,
            duration: formatDuration(log.duration),
            startedAt: log.started_at,
            summary,
            transcript: transcriptText,
            mode: sheetTargetMode,
            sheetId: sheetTargetMode === "existing" ? selectedExistingSheetId : "",
            rows: googleSheetsConnected ? payloadRows : [],
          },
        });
        if (response.error) throw response.error;
        const data = response.data;

        if (data?.googleDocsUsed === false) {
          throw new Error("Google Docs is disabled for this agent.");
        }

        const url = data?.documentUrl ? String(data.documentUrl) : "";
        if (!url) {
          throw new Error("Google Doc created, but no document URL was returned.");
        }
        documentUrls.push(url);
      }

      let openedCount = 0;
      for (const url of documentUrls) {
        const popup = window.open(url, "_blank", "noopener,noreferrer");
        if (popup) openedCount += 1;
      }

      toast({
        title: openedCount === 1 ? "Google Doc opened" : `Created ${documentUrls.length} Google Docs`,
        description:
          openedCount === 0
            ? "The documents were created, but your browser blocked the new tabs."
            : "Call summaries were generated and opened in Google Docs.",
      });
    } catch (error: any) {
      const message = await extractFunctionErrorMessage(error);
      toast({
        title: "Google Docs creation failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setCreatingDocs(false);
    }
  };

  // ─── Campaign Detail View ───
  if (selectedCampaign) {
    const campContacts = contacts.filter((c) => c.campaign_id === selectedCampaign.id);
    const campCallLogs = selectedCampaignCallLogs;
    const dynamicContactColumns = Array.from(
      campContacts.reduce((columnMap, contact) => {
        const metadataKeys = contact.metadata && typeof contact.metadata === "object" && !Array.isArray(contact.metadata)
          ? Object.keys(contact.metadata as Record<string, unknown>)
          : [];

        const baseKeys = Object.keys(contact).filter((key) =>
          ![
            "id",
            "campaign_id",
            "user_id",
            "created_at",
            "updated_at",
            "metadata",
          ].includes(key),
        );

        [...baseKeys, ...metadataKeys].forEach((key) => {
          const normalizedKey = normalizeDynamicColumnKey(key);
          if (!normalizedKey || FIXED_CONTACT_COLUMN_NORMALIZED_KEYS.has(normalizedKey)) {
            return;
          }
          if (!columnMap.has(normalizedKey)) {
            columnMap.set(normalizedKey, key);
          }
        });

        return columnMap;
      }, new Map<string, string>()),
    ).map(([, key]) => ({
      key,
      label: formatDynamicFieldLabel(key),
    }));

    // Attempt numbers
    const attemptMap: Record<string, number> = {};
    const phoneCallCounts: Record<string, number> = {};
    const sortedLogs = [...campCallLogs].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    for (const cl of sortedLogs) {
      const phone = cl.recipient_number || "";
      phoneCallCounts[phone] = (phoneCallCounts[phone] || 0) + 1;
      attemptMap[cl.id] = phoneCallCounts[phone];
    }

    // Filter out retry calls (attempt > 1) — those belong in the Retry CSV tab
    const firstAttemptLogs = campCallLogs.filter((cl) => (attemptMap[cl.id] || 1) === 1);

    // Compute outcome counts from first-attempt call_logs only
    const liveOutcomeCounts: Record<string, number> = {};
    for (const cl of firstAttemptLogs) {
      const result = getCallResult(cl);
      liveOutcomeCounts[result] = (liveOutcomeCounts[result] || 0) + 1;
    }

    // Filter
    const filteredLogs = firstAttemptLogs.filter((cl) => {
      if (filterOutcome !== "ALL") {
        const result = getCallResult(cl);
        const filterMap: Record<string, string[]> = {
          ANSWERED: ["ANSWERED"],
          VOICEMAIL: ["VOICEMAIL"],
          NO_ANSWER: ["NO ANSWER"],
          DECLINED: ["FAILED", "DECLINED"],
          PENDING: ["PENDING"],
          FLAGGED_REVIEW: ["FLAGGED_REVIEW"],
        };
        if (filterMap[filterOutcome] && !filterMap[filterOutcome].includes(result)) return false;
      }
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const contact = campContacts.find((c) => c.phone_number === cl.recipient_number);
        const email = getContactEmail(contact).toLowerCase();
        return (cl.recipient_number || "").toLowerCase().includes(term) ||
          getContactDisplayName(contact).toLowerCase().includes(term) ||
          email.includes(term) ||
          (contact?.child_names || "").toLowerCase().includes(term);
      }
      return true;
    });

    const getContactForLog = (cl: CallLog) =>
      campContacts.find((c) => normalizeComparablePhone(c.phone_number) === normalizeComparablePhone(cl.recipient_number));

    const visibleLogIds = filteredLogs.slice(0, 100).map((cl) => cl.id);
    const allVisibleSelected = visibleLogIds.length > 0 && visibleLogIds.every((id) => selectedOutcomeIds.includes(id));
    const someVisibleSelected = visibleLogIds.some((id) => selectedOutcomeIds.includes(id));

    const toggleSelectAllVisible = (checked: boolean) => {
      setSelectedOutcomeIds((current) => {
        if (checked) {
          return Array.from(new Set([...current, ...visibleLogIds]));
        }
        return current.filter((id) => !visibleLogIds.includes(id));
      });
    };

    const toggleSelectOne = (logId: string, checked: boolean) => {
      setSelectedOutcomeIds((current) => {
        if (checked) {
          return current.includes(logId) ? current : [...current, logId];
        }
        return current.filter((id) => id !== logId);
      });
    };

    // Export to CSV
    const handleExportCSV = () => {
      const headers = [
        "Time",
        "Contact",
        "Email",
        "Phone",
        "Children",
        "Attempt",
        "Result",
        "Duration (s)",
        "Transcript",
        "AI Summary",
        ...dynamicContactColumns.map((column) => column.label),
      ];
      const rows = firstAttemptLogs.map((cl) => {
        const contact = getContactForLog(cl);
        const result = getCallResult(cl);
        const transcriptText = formatTranscript(cl.transcript) || "";
        const summary = summaries[cl.id] || "";
        const attempt = attemptMap[cl.id] || 1;
        const metadata = getContactMetadata(contact);
        return [
          new Date(cl.started_at).toLocaleString(),
          getContactDisplayName(contact),
          getContactEmail(contact),
          cl.recipient_number || "",
          contact?.child_names || "",
          attempt > 1 ? `Retry #${attempt}` : "1st",
          result,
          cl.duration || 0,
          `"${transcriptText.replace(/"/g, '""')}"`,
          `"${summary.replace(/"/g, '""')}"`,
          ...dynamicContactColumns.map((column) => {
            const rawValue = (contact as Record<string, unknown> | undefined)?.[column.key] ?? metadata[column.key];
            const safeValue = rawValue == null ? "" : String(rawValue);
            return `"${safeValue.replace(/"/g, '""')}"`;
          }),
        ].join(",");
      });

      const csvContent = [headers.join(","), ...rows].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedCampaign.venue_name}_outcomes.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast({ title: "Exported to CSV" });
    };

    return (
      <div className="space-y-6">
        {/* Back + Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => { setSelectedCampaign(null); setFilterOutcome("ALL"); setSearchTerm(""); }}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold">{selectedCampaign.venue_name}</h2>
              <Badge className={STATUS_COLORS[selectedCampaign.status] || ""} variant="secondary">{String(selectedCampaign.status || "").charAt(0).toUpperCase() + String(selectedCampaign.status || "").slice(1)}</Badge>
            </div>
            {selectedCampaign.venue_location && (
              <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1"><MapPin className="h-3 w-3" /> {selectedCampaign.venue_location}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeActions.map((actionId) => (
              <div key={actionId} className="flex items-center">
                {(() => {
                  const actionMeta = actionCatalog.find((action) => action.id === actionId);

                  if (actionId === "gmail") {
                    return (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => handleOpenEmail(filteredLogs, getContactForLog)}>
                        <img src={GMAIL_LOGO} alt="Gmail" className="h-4 w-4 object-contain" />
                        Open Email
                      </Button>
                    );
                  }

                  if (actionId === "google_sheets") {
                    return (
                      <Button variant="outline" size="sm" className="gap-1" onClick={openSheetPicker}>
                        <img src={GOOGLE_SHEETS_LOGO} alt="Google Sheets" className="h-4 w-4 object-contain" />
                        Open in Sheets
                      </Button>
                    );
                  }

                  if (actionId === "google_docs") {
                    return (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => void handleOpenGoogleDocs(filteredLogs, getContactForLog)} disabled={creatingDocs}>
                        <img src={GOOGLE_DOCS_LOGO} alt="Google Docs" className="h-4 w-4 object-contain" />
                        {creatingDocs ? "Creating..." : "Google Docs"}
                      </Button>
                    );
                  }

                  return (
                    <Button variant="outline" size="sm" className="gap-1" onClick={handleExportCSV}>
                      <Download className="h-4 w-4" /> {actionMeta?.label || "Export"}
                    </Button>
                  );
                })()}
                {actionId !== "export" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-1 h-7 w-7"
                    onClick={() => removeOutcomeAction(actionId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon">
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actionCatalog.filter((action) => !activeActions.includes(action.id)).length === 0 ? (
                  <DropdownMenuItem disabled>No more actions</DropdownMenuItem>
                ) : (
                  actionCatalog
                    .filter((action) => !activeActions.includes(action.id))
                    .map((action) => (
                      <DropdownMenuItem key={action.id} onClick={() => addOutcomeAction(action.id)}>
                        {action.logo ? <img src={action.logo} alt={action.label} className="mr-2 h-4 w-4 object-contain" /> : null}
                        {action.label}
                      </DropdownMenuItem>
                    ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Outcome Summary Cards — computed from live call_logs */}
        <div className="grid gap-3 grid-cols-3">
          {[
            { key: "ANSWERED", label: "ANSWERED" },
            { key: "FAILED", label: "DECLINED" },
            { key: "NO ANSWER", label: "NO ANSWER" },
            { key: "PENDING", label: "PENDING" },
            { key: "VOICEMAIL", label: "VOICEMAIL" },
            { key: "FLAGGED_REVIEW", label: "FLAGGED REVIEW" },
          ].map(({ key, label }) => (
            <Card
              key={key}
              className={`cursor-pointer border transition-shadow hover:shadow-sm ${
                filterOutcome === key ? "border-primary shadow-sm" : ""
              }`}
              onClick={() => setFilterOutcome(filterOutcome === key ? "ALL" : key)}
            >
              <CardContent className="flex min-h-[108px] flex-col items-start gap-4 px-5 py-4">
                <p className="text-sm text-muted-foreground md:text-base">{label}</p>
                <div className="text-4xl font-semibold leading-none text-foreground">
                  {liveOutcomeCounts[key] || 0}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Search & Filter */}
        <div className="flex gap-3 flex-wrap items-end">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search by name, phone..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          {selectedOutcomeIds.length > 0 && (
            <div className="text-sm text-muted-foreground">{selectedOutcomeIds.length} selected for actions</div>
          )}
          <Select value={filterOutcome} onValueChange={setFilterOutcome}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Results" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Results</SelectItem>
              <SelectItem value="ANSWERED">Answered</SelectItem>
              <SelectItem value="VOICEMAIL">Voicemail</SelectItem>
              <SelectItem value="NO ANSWER">No Answer</SelectItem>
              <SelectItem value="DECLINED">Failed</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Call Results Table */}
        <Card>
          <CardContent className="p-0">
            {filteredLogs.length === 0 ? <div className="p-8 text-center text-muted-foreground">No call results for this campaign.</div> : (
              <div className="overflow-x-auto">
                <Table className="min-w-[1200px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[52px]">
                        <Checkbox
                          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                          onCheckedChange={(checked) => toggleSelectAllVisible(checked === true)}
                          aria-label="Select all outcomes"
                        />
                      </TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Attempt</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Transcript</TableHead>
                      <TableHead>AI Summary</TableHead>
                      {dynamicContactColumns.map((column) => (
                        <TableHead key={column.key}>{column.label}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLogs.slice(0, 100).map((cl) => {
                      const contact = getContactForLog(cl);
                      const result = getCallResult(cl);
                      const transcriptText = formatTranscript(cl.transcript);
                      const attempt = attemptMap[cl.id] || 1;
                      const summary = summaries[cl.id];
                      const isSummarizing = summarizing[cl.id];
                      const isSelected = selectedOutcomeIds.includes(cl.id);
                      const metadata = getContactMetadata(contact);

                      return (
                        <TableRow key={cl.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedCallLog(cl)}>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(checked) => toggleSelectOne(cl.id, checked === true)}
                              aria-label={`Select outcome for ${contact?.first_name || cl.recipient_number || cl.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-xs">{new Date(cl.started_at).toLocaleString()}</TableCell>
                          <TableCell className="text-sm font-medium">{getContactDisplayName(contact) || "—"}</TableCell>
                          <TableCell className="text-sm">{getContactEmail(contact) || "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{cl.recipient_number || "—"}</TableCell>
                          <TableCell>
                            {attempt > 1 ? (
                              <Badge variant="outline" className="text-xs">Retry #{attempt}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">1st</span>
                            )}
                          </TableCell>
                          <TableCell><Badge className={OUTCOME_COLORS[result] || "bg-muted text-muted-foreground"} variant="secondary">{result}</Badge></TableCell>
                          <TableCell className="text-sm whitespace-nowrap"><Clock className="h-3 w-3 text-muted-foreground inline mr-1" />{formatDuration(cl.duration)}</TableCell>
                          <TableCell className="max-w-[150px]">
                            {transcriptText ? (
                              <span className="text-xs text-muted-foreground line-clamp-2">{truncateText(transcriptText, 80)}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[180px]" onClick={(e) => e.stopPropagation()}>
                            {summary ? (
                              <button
                                className="text-xs text-muted-foreground line-clamp-2 text-left hover:text-foreground transition-colors cursor-pointer"
                                onClick={() => setSelectedCallLog(cl)}
                              >
                                {truncateText(summary, 100)}
                              </button>
                            ) : transcriptText ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs gap-1"
                                disabled={isSummarizing}
                                onClick={() => handleSummarize(cl.id)}
                              >
                                {isSummarizing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                {isSummarizing ? "Generating..." : "Generate"}
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          {dynamicContactColumns.map((column) => {
                            const rawValue = (contact as Record<string, unknown> | undefined)?.[column.key] ?? metadata[column.key];
                            const value = rawValue == null || rawValue === "" ? "—" : String(rawValue);
                            return (
                              <TableCell key={column.key} className="min-w-[160px] text-sm">
                                {value}
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                {filteredLogs.length > 100 && <p className="text-xs text-muted-foreground p-3">Showing 100 of {filteredLogs.length}</p>}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Call Detail Dialog */}
        <Dialog open={!!selectedCallLog} onOpenChange={(open) => !open && setSelectedCallLog(null)}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Call Detail</DialogTitle></DialogHeader>
            {selectedCallLog && (() => {
              const contact = getContactForLog(selectedCallLog);
              const transcriptText = formatTranscript(selectedCallLog.transcript);
              const summary = summaries[selectedCallLog.id];
              const attempt = attemptMap[selectedCallLog.id] || 1;
              return (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-muted-foreground">Contact:</span> {getContactDisplayName(contact) || "—"}</div>
                    <div><span className="text-muted-foreground">Email:</span> {getContactEmail(contact) || "—"}</div>
                    <div><span className="text-muted-foreground">Phone:</span> {selectedCallLog.recipient_number || "—"}</div>
                    <div><span className="text-muted-foreground">Children:</span> {contact?.child_names || "—"}</div>
                    <div><span className="text-muted-foreground">Status:</span> <Badge className={CALL_STATUS_COLORS[selectedCallLog.status]}>{selectedCallLog.status}</Badge></div>
                    <div><span className="text-muted-foreground">Result:</span> <Badge className={OUTCOME_COLORS[getCallResult(selectedCallLog)] || ""}>{getCallResult(selectedCallLog)}</Badge></div>
                    <div><span className="text-muted-foreground">Duration:</span> {formatDuration(selectedCallLog.duration)}</div>
                    <div><span className="text-muted-foreground">Started:</span> {new Date(selectedCallLog.started_at).toLocaleString()}</div>
                    {selectedCallLog.ended_at && <div><span className="text-muted-foreground">Ended:</span> {new Date(selectedCallLog.ended_at).toLocaleString()}</div>}
                    <div><span className="text-muted-foreground">Attempt:</span> {attempt > 1 ? `Retry #${attempt}` : "1st"}</div>
                    {selectedCallLog.caller_number && <div><span className="text-muted-foreground">From:</span> {selectedCallLog.caller_number}</div>}
                  </div>
                  {summary && (
                    <div>
                      <p className="text-sm font-medium mb-1">AI Summary</p>
                      <p className="text-sm text-muted-foreground bg-muted p-3 rounded-lg whitespace-pre-wrap">{summary}</p>
                    </div>
                  )}
                  {!summary && transcriptText && (
                    <Button variant="outline" size="sm" className="gap-1" disabled={summarizing[selectedCallLog.id]} onClick={() => handleSummarize(selectedCallLog.id)}>
                      {summarizing[selectedCallLog.id] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                      {summarizing[selectedCallLog.id] ? "Generating Summary..." : "Generate AI Summary"}
                    </Button>
                  )}
                  {transcriptText && <div><p className="text-sm font-medium mb-1">Transcript</p><pre className="text-xs bg-muted p-3 rounded-lg whitespace-pre-wrap max-h-60 overflow-y-auto">{transcriptText}</pre></div>}
                </div>
              );
            })()}
          </DialogContent>
        </Dialog>

        <Dialog open={sheetPickerOpen} onOpenChange={setSheetPickerOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Open In Google Sheets</DialogTitle>
              <DialogDescription>
                Choose whether this campaign should use a new sheet or an existing sheet.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSheetTargetMode("new")}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    sheetTargetMode === "new" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                  }`}
                >
                  <div className="font-medium">New sheet</div>
                  <p className="mt-1 text-sm text-muted-foreground">Open a fresh Google Sheet for this campaign.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setSheetTargetMode("existing")}
                  className={`rounded-xl border p-4 text-left transition-colors ${
                    sheetTargetMode === "existing" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                  }`}
                >
                  <div className="font-medium">Existing sheet</div>
                  <p className="mt-1 text-sm text-muted-foreground">Reuse a Google Sheet you already have.</p>
                </button>
              </div>

              {sheetTargetMode === "existing" && (
                <div className="space-y-2">
                  <Label>Choose an existing Google Sheet</Label>
                  <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-border p-2">
                    {loadingExistingSheets ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">Loading your sheets...</div>
                    ) : existingSheetsError ? (
                      <div className="py-2 text-sm text-muted-foreground">{existingSheetsError}</div>
                    ) : existingSheets.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        No Google Sheets found in this account.
                      </div>
                    ) : (
                      existingSheets.map((sheet) => (
                        <button
                          key={sheet.id}
                          type="button"
                          onClick={() => setSelectedExistingSheetId(sheet.id)}
                          className={`flex w-full items-start justify-between rounded-lg border p-3 text-left transition-colors ${
                            selectedExistingSheetId === sheet.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/40"
                          }`}
                        >
                          <div>
                            <div className="font-medium text-foreground">{sheet.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              Updated {new Date(sheet.modifiedTime).toLocaleString()}
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSheetPickerOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleOpenInSheets(selectedCampaign.venue_name, filteredLogs, getContactForLog, attemptMap)}
                disabled={syncingSheet}
              >
                {syncingSheet
                  ? "Syncing..."
                  : sheetTargetMode === "new"
                    ? "Create And Sync"
                    : "Sync To Selected Sheet"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ─── Campaign List View ───
  const deleteDialog = (
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete campaign?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete "{deleteTarget?.name}"? This will also delete all associated contacts and data.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void confirmDeleteCampaign()} disabled={deletingCampaign} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {deletingCampaign ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-end gap-2">
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <Button onClick={() => setAddDialogOpen(true)}><Plus className="h-4 w-4 mr-2" /> Add Outcome</Button>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Add Call Outcome</DialogTitle></DialogHeader>
              <form onSubmit={handleAddOutcome} className="space-y-4">
                <div className="space-y-2"><Label>Campaign</Label><Select value={addForm.campaign_id} onValueChange={(v) => { const camp = campaigns.find((c) => c.id === v); setAddForm({ ...addForm, campaign_id: v, venue_name: camp?.venue_name || "" }); }}><SelectTrigger><SelectValue placeholder="Select campaign" /></SelectTrigger><SelectContent>{campaigns.map((c) => <SelectItem key={c.id} value={c.id}>{c.venue_name}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid gap-4 grid-cols-2">
                  <div className="space-y-2"><Label>Phone Number *</Label><Input value={addForm.phone_number} onChange={(e) => setAddForm({ ...addForm, phone_number: e.target.value })} required /></div>
                  <div className="space-y-2"><Label>Outcome *</Label><Select value={addForm.outcome} onValueChange={(v) => setAddForm({ ...addForm, outcome: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{OUTCOMES.filter((o) => o !== "ALL").map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent></Select></div>
                </div>
                <div className="grid gap-4 grid-cols-2">
                  <div className="space-y-2"><Label>Parent Name</Label><Input value={addForm.parent_name} onChange={(e) => setAddForm({ ...addForm, parent_name: e.target.value })} /></div>
                  <div className="space-y-2"><Label>Child Names</Label><Input value={addForm.child_names} onChange={(e) => setAddForm({ ...addForm, child_names: e.target.value })} /></div>
                </div>
                <div className="space-y-2"><Label>Summary</Label><Textarea value={addForm.summary} onChange={(e) => setAddForm({ ...addForm, summary: e.target.value })} rows={2} /></div>
                <div className="space-y-2"><Label>Transcript</Label><Textarea value={addForm.transcript} onChange={(e) => setAddForm({ ...addForm, transcript: e.target.value })} rows={3} /></div>
                <Button type="submit">Save Outcome</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {loading ? <div className="p-8 text-center text-muted-foreground">Loading...</div>
          : campaigns.length === 0 ? <div className="p-8 text-center text-muted-foreground">No campaigns found.</div>
          : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {campaigns.map((camp) => {
                const campOutcomes = getOutcomesForCampaign(camp.id);
                const counts = getOutcomeCounts(campOutcomes);
                const failedCount = (counts["FAILED"] || 0) + (counts["DECLINED"] || 0);
                return (
                  <Card key={camp.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedCampaign(camp)}>
                    <CardContent className="pt-5 pb-4 space-y-3">
                      <div className="flex items-start justify-between gap-2 text-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-base truncate">{camp.venue_name}</h3>
                            {camp.round > 1 && <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-5">Retry {camp.round}</Badge>}
                          </div>
                          {camp.venue_location && <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><MapPin className="h-3 w-3" /> {camp.venue_location}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge className={STATUS_COLORS[camp.status] || ""} variant="secondary">{String(camp.status || "").charAt(0).toUpperCase() + String(camp.status || "").slice(1)}</Badge>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuItem onClick={() => {
                                setEditingCampaign(camp);
                                setEditName(camp.venue_name);
                              }}>
                                <Pencil className="h-4 w-4 mr-2" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDeleteCampaign(camp.id, camp.venue_name)}>
                                <Trash2 className="h-4 w-4 mr-2" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      <div className="flex gap-2 flex-wrap">
                        <Badge variant="secondary">Sent: {camp.calls_made}</Badge>
                        <Badge variant="secondary">Failed: {failedCount}</Badge>
                      </div>

                      {(camp.age_range || camp.times || camp.start_date) ? (
                        <div className="flex gap-3 border-t pt-1 text-xs text-muted-foreground">
                          {camp.age_range && <span>{camp.age_range}</span>}
                          {camp.times && <span>{camp.times}</span>}
                          {camp.start_date && <span className="flex items-center gap-0.5"><Calendar className="h-3 w-3" />{camp.start_date}</span>}
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

        {/* Edit Dialog */}
        <Dialog open={!!editingCampaign} onOpenChange={(open) => !open && setEditingCampaign(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Campaign</DialogTitle>
              <DialogDescription>Rename your campaign to keep your outreach organized.</DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign Name</Label>
                <Input 
                  id="campaign-name" 
                  value={editName} 
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Enter campaign name..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingCampaign(null)} disabled={updating}>Cancel</Button>
              <Button onClick={handleUpdateCampaignName} disabled={updating || !editName.trim()}>
                {updating ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {deleteDialog}
    </>
  );
}
