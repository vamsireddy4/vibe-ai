import { useEffect, useMemo, useState, Fragment } from "react";
import { format } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, Mail, Search, User } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { matchesSearch } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type GmailCompletedCampaign = Database["public"]["Tables"]["gmail_completed_campaigns"]["Row"];
type SharedCompletedCampaign = Database["public"]["Tables"]["sms_completed_campaigns"]["Row"];
type GmailHistoryCampaign = GmailCompletedCampaign | SharedCompletedCampaign;
const GMAIL_CHANNEL_MARKER = "__magicteams_channel";

type GmailHistoryRow = {
  id: string;
  campaignName: string;
  templateName: string;
  senderEmail: string;
  recipientEmail: string;
  status: string;
  message: string;
  providerMessageId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

function isGmailFallbackCompletedCampaign(campaign: GmailHistoryCampaign) {
  const contacts = Array.isArray(campaign.selected_contacts) ? (campaign.selected_contacts as Array<Record<string, unknown>>) : [];
  const outcomes = Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [];

  return contacts.some((contact) => {
    const metadata = contact?.metadata;
    return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)[GMAIL_CHANNEL_MARKER] === "gmail";
  }) || outcomes.some((outcome) => outcome?.[GMAIL_CHANNEL_MARKER] === "gmail");
}

function normalizeOutcomeRows(campaigns: GmailHistoryCampaign[]): GmailHistoryRow[] {
  return campaigns
    .flatMap((campaign) => {
      const outcomes = Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [];
      return outcomes.map((outcome, index) => ({
        id: `${campaign.id}-${index}`,
        campaignName: campaign.name,
        templateName: campaign.template_name,
        senderEmail: String((campaign as { sender_email_address?: string; sender_phone_number?: string }).sender_email_address || (campaign as { sender_phone_number?: string }).sender_phone_number || "—"),
        recipientEmail: String(outcome.recipient_email || outcome.email || outcome.to || "—"),
        status: String(outcome.status || campaign.status || "unknown"),
        message: String(outcome.rendered_message || outcome.rendered_body || ""),
        providerMessageId: outcome.provider_message_id ? String(outcome.provider_message_id) : null,
        error: outcome.error ? String(outcome.error) : null,
        startedAt: campaign.started_at,
        completedAt: campaign.completed_at,
      }));
    })
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function GmailHistory({ embedded = false, search, status }: { embedded?: boolean; search?: string; status?: string }) {
  const Shell = embedded ? Fragment : DashboardLayout;
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState<GmailHistoryCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRow, setSelectedRow] = useState<GmailHistoryRow | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!user) return;

    const fetchHistory = async () => {
      const { data, error } = await supabase
        .from("gmail_completed_campaigns")
        .select("*")
        .eq("user_id", user.id)
        .order("started_at", { ascending: false });

      if (error) {
        const isMissingTableError =
          error.message.includes("gmail_completed_campaigns") &&
          (error.message.includes("schema cache") || error.message.includes("Could not find the table"));

        if (isMissingTableError) {
          const { data: fallbackData, error: fallbackError } = await supabase
            .from("sms_completed_campaigns")
            .select("*")
            .eq("user_id", user.id)
            .order("started_at", { ascending: false });

          if (fallbackError) {
            setCampaigns([]);
            setLoading(false);
            return;
          }

          setCampaigns(((fallbackData as SharedCompletedCampaign[]) || []).filter(isGmailFallbackCompletedCampaign));
          setLoading(false);
          return;
        }

        toast.error("Failed to load Gmail history", { description: error.message });
        setLoading(false);
        return;
      }

      setCampaigns((data as GmailCompletedCampaign[]) || []);
      setLoading(false);
    };

    void fetchHistory();

    const channel = supabase
      .channel("gmail-history-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "gmail_completed_campaigns" }, () => {
        void fetchHistory();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const rows = useMemo(() => normalizeOutcomeRows(campaigns), [campaigns]);
  const filteredRows = useMemo(() => {
    const term = search ?? searchTerm;
    const wanted = status ?? statusFilter;
    return rows.filter((row) =>
      (wanted === "all" || row.status.toLowerCase() === wanted) &&
      matchesSearch(term, [row.campaignName, row.templateName, row.recipientEmail, row.senderEmail, row.message, row.error]),
    );
  }, [rows, search, searchTerm, status, statusFilter]);

  const formatDate = (value: string) => format(new Date(value), "d MMM yyyy");
  const formatTime = (value: string) => format(new Date(value), "H:mm");
  const statusVariant = (status: string) => (status.toLowerCase() === "failed" ? "destructive" : "default");

  return (
    <Shell>
      <div className="flex h-full flex-col animate-rise-in">
        {!embedded && (
        <div className="mb-6 shrink-0">
          <h1 className="text-3xl font-bold tracking-tight">Gmail History</h1>
          <p className="mt-1 text-muted-foreground">View all email campaign sends and delivery history.</p>
        </div>
        )}

        {search === undefined && (
        <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search by campaign, recipient, or subject"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full md:w-[180px]">
              <SelectValue placeholder="All Results" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Results</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key="gmail-history"
            initial={{ y: 10 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : filteredRows.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-20">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                    <Mail className="h-7 w-7 text-primary" />
                  </div>
                  <h3 className="mb-1 text-lg font-semibold">No email history yet</h3>
                  <p className="max-w-md text-center text-sm text-muted-foreground">
                    Gmail send history will appear here once email campaigns are connected and messages start running.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredRows.map((row) => (
                  <Card
                    key={row.id}
                    className="cursor-pointer transition-colors hover:border-primary/40"
                    onClick={() => setSelectedRow(row)}
                  >
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                        <Mail className="h-4 w-4 text-primary" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{row.campaignName}</p>
                          <Badge variant={statusVariant(row.status) as any} className="shrink-0 text-[10px] capitalize">
                            {row.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {row.recipientEmail}
                          </span>
                          <span>·</span>
                          <span>{row.templateName}</span>
                        </div>
                      </div>

                      <div className="shrink-0 text-right">
                        <p className="text-sm font-medium">{formatTime(row.startedAt)}</p>
                        <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>{formatDate(row.startedAt)}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <Dialog open={!!selectedRow} onOpenChange={() => setSelectedRow(null)}>
          <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Gmail Details</DialogTitle>
              <DialogDescription className="sr-only">
                View Gmail campaign metadata, recipient details, provider id, message body, and failure information.
              </DialogDescription>
            </DialogHeader>
            {selectedRow ? (
              <div className="space-y-5">
                <div className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Recipient</p>
                    <p className="font-mono font-medium">{selectedRow.recipientEmail}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Status</p>
                    <Badge variant={statusVariant(selectedRow.status) as any} className="capitalize">
                      {selectedRow.status}
                    </Badge>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Campaign</p>
                    <p className="font-medium">{selectedRow.campaignName}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Template</p>
                    <p className="font-medium">{selectedRow.templateName}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Sender</p>
                    <p className="font-mono text-xs">{selectedRow.senderEmail || "—"}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Provider Message ID</p>
                    <p className="font-mono text-xs">{selectedRow.providerMessageId || "—"}</p>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs text-muted-foreground">Message</p>
                  <div className="rounded-lg border bg-muted/20 p-4 text-sm whitespace-pre-wrap">
                    {selectedRow.message || "—"}
                  </div>
                </div>

                {selectedRow.error ? (
                  <div>
                    <p className="mb-2 text-xs text-muted-foreground">Error</p>
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                      {selectedRow.error}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}
