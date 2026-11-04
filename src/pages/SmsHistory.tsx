import { useEffect, useMemo, useState, Fragment } from "react";
import { format } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Clock, MessageSquare, Send, TriangleAlert, User } from "lucide-react";
import { useLocation } from "react-router-dom";

import DashboardLayout from "@/components/DashboardLayout";
import { matchesSearch } from "@/lib/utils";
import { getVibeSpaceFromPath } from "@/lib/vibe-routes";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type SmsCompletedCampaign = Database["public"]["Tables"]["sms_completed_campaigns"]["Row"];

type SmsHistoryRow = {
  id: string;
  campaignName: string;
  templateName: string;
  senderNumber: string;
  recipientNumber: string;
  status: string;
  message: string;
  providerMessageId: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

function normalizeOutcomeRows(campaigns: SmsCompletedCampaign[]): SmsHistoryRow[] {
  return campaigns
    .flatMap((campaign) => {
      const outcomes = Array.isArray(campaign.outcomes) ? (campaign.outcomes as Array<Record<string, unknown>>) : [];
      return outcomes.map((outcome, index) => ({
        id: `${campaign.id}-${index}`,
        campaignName: campaign.name,
        templateName: campaign.template_name,
        senderNumber: campaign.sender_phone_number,
        recipientNumber: String(outcome.recipient_number || "—"),
        status: String(outcome.status || campaign.status || "unknown"),
        message: String(outcome.rendered_message || ""),
        providerMessageId: outcome.provider_message_id ? String(outcome.provider_message_id) : null,
        error: outcome.error ? String(outcome.error) : null,
        startedAt: campaign.started_at,
        completedAt: campaign.completed_at,
      }));
    })
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function SmsHistory({ embedded = false, search = "", status = "all" }: { embedded?: boolean; search?: string; status?: string }) {
  const Shell = embedded ? Fragment : DashboardLayout;
  const { user } = useAuth();
  const location = useLocation();
  const [campaigns, setCampaigns] = useState<SmsCompletedCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRow, setSelectedRow] = useState<SmsHistoryRow | null>(null);
  const space = getVibeSpaceFromPath(location.pathname);
  const historyLabel = space === "whatsapp" ? "WhatsApp" : "SMS";

  useEffect(() => {
    if (!user) return;

    const fetchHistory = async () => {
      const { data, error } = await supabase
        .from("sms_completed_campaigns")
        .select("*")
        .order("started_at", { ascending: false });

      if (error) {
        toast.error("Failed to load SMS history", { description: error.message });
        setLoading(false);
        return;
      }

      setCampaigns((data as SmsCompletedCampaign[]) || []);
      setLoading(false);
    };

    void fetchHistory();

    const channel = supabase
      .channel("sms-history-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "sms_completed_campaigns" }, () => {
        void fetchHistory();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const allRows = useMemo(() => normalizeOutcomeRows(campaigns), [campaigns]);
  const rows = allRows.filter((r) => (status === "all" || r.status.toLowerCase() === status) && matchesSearch(search, [r.campaignName, r.templateName, r.senderNumber, r.recipientNumber, r.status, r.message, r.error]));

  const formatDate = (value: string) => format(new Date(value), "d MMM yyyy");
  const formatTime = (value: string) => format(new Date(value), "H:mm");
  const isFailed = (status: string) => status.toLowerCase() === "failed";
  const statusVariant = (status: string) => (isFailed(status) ? "destructive" : "default");

  return (
    <Shell>
      <div className="flex h-full flex-col animate-rise-in">
        {!embedded && (
        <div className="mb-6 shrink-0">
          <h1 className="text-3xl font-bold tracking-tight">{historyLabel} History</h1>
          <p className="mt-1 text-muted-foreground">View all {historyLabel} campaign sends and delivery outcomes.</p>
        </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key="sms-history"
            initial={{ y: 10 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <MessageSquare className="mb-4 h-12 w-12 text-muted-foreground" />
                  <h3 className="mb-1 text-lg font-semibold">{allRows.length ? `No ${historyLabel} sends match` : `No ${historyLabel} history yet`}</h3>
                  <p className="text-sm text-muted-foreground">
                    Completed {historyLabel} sends will appear here once campaigns start running.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {rows.map((row) => (
                  <Card
                    key={row.id}
                    className="cursor-pointer transition-colors hover:border-primary/40"
                    onClick={() => setSelectedRow(row)}
                  >
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                        <Send className="h-4 w-4 text-primary" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex items-center gap-2">
                          <p className="truncate font-mono text-sm font-medium">{row.recipientNumber}</p>
                          <Badge variant={statusVariant(row.status) as any} className="shrink-0 text-[10px] capitalize">
                            {row.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {row.campaignName}
                          </span>
                          <span>·</span>
                          <span>{row.templateName}</span>
                          {row.senderNumber ? (
                            <>
                              <span>·</span>
                              <span>{row.senderNumber}</span>
                            </>
                          ) : null}
                          {row.error ? (
                            <>
                              <span>·</span>
                              <Badge variant="outline" className="h-4 text-[10px] text-destructive">
                                Error
                              </Badge>
                            </>
                          ) : null}
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
              <DialogTitle>{historyLabel} Details</DialogTitle>
              <DialogDescription className="sr-only">
                View {historyLabel} campaign metadata, recipient details, provider id, message body, and failure information.
              </DialogDescription>
            </DialogHeader>
            {selectedRow ? (
              <div className="space-y-5">
                <div className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Recipient</p>
                    <p className="font-mono font-medium">{selectedRow.recipientNumber}</p>
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
                    <p className="font-mono text-xs">{selectedRow.senderNumber || "—"}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Provider ID</p>
                    <p className="font-mono text-xs">{selectedRow.providerMessageId || "—"}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Started At</p>
                    <p className="text-xs">{new Date(selectedRow.startedAt).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="mb-0.5 text-xs text-muted-foreground">Completed At</p>
                    <p className="text-xs">{selectedRow.completedAt ? new Date(selectedRow.completedAt).toLocaleString() : "—"}</p>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium">Message</p>
                  <div className="rounded-lg border bg-muted/40 p-4 text-sm whitespace-pre-wrap">
                    {selectedRow.message || "—"}
                  </div>
                </div>

                {selectedRow.error ? (
                  <div>
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-destructive">
                      <TriangleAlert className="h-4 w-4" /> Error
                    </p>
                    <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm whitespace-pre-wrap text-destructive">
                      {selectedRow.error}
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4 text-primary" /> Delivery
                    </p>
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
                      SMS was accepted with status <span className="font-medium capitalize">{selectedRow.status}</span>.
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </Shell>
  );
}
