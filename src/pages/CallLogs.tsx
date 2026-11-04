import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhoneIncoming, PhoneOutgoing, History, Copy, Check, FileText, Clock, User, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { matchesSearch } from "@/lib/utils";
import { toast } from "sonner";
import type { Json } from "@/integrations/supabase/types";
import { AnimatePresence, motion } from "framer-motion";
import CallRecording from "@/components/CallRecording";
import WhatsAppHistory from "@/components/WhatsAppHistory";
import { summarizeCallTranscript } from "@/lib/analysis";
import SmsHistory from "@/pages/SmsHistory";
import GmailHistory from "@/pages/GmailHistory";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// History page channels (?type=...). Calls are this page's own list; the rest reuse each channel's history.
const HISTORY_TYPES = {
  calls: { label: "Calls", hint: "Inbound, outbound and demo calls with transcripts and recordings.",
    statuses: [["completed", "Completed"], ["no-answer", "No answer"], ["busy", "Busy"], ["failed", "Failed"]] },
  sms: { label: "SMS", hint: "SMS campaign sends and delivery outcomes.",
    statuses: [["sent", "Sent"], ["delivered", "Delivered"], ["failed", "Failed"], ["scheduled", "Scheduled"]] },
  whatsapp: { label: "WhatsApp", hint: "WhatsApp conversations, newest first.", statuses: [["unread", "Unread"]] },
  email: { label: "Email", hint: "Email campaign sends and delivery history.",
    statuses: [["sent", "Sent"], ["failed", "Failed"], ["scheduled", "Scheduled"]] },
} as const;
type HistoryType = keyof typeof HISTORY_TYPES;

interface CallLog {
  id: string;
  direction: string;
  caller_number: string | null;
  recipient_number: string | null;
  status: string;
  duration: number | null;
  started_at: string;
  ended_at: string | null;
  transcript: Json | null;
  summary: string | null;
  ultravox_call_id: string | null;
  twilio_call_sid: string | null;
  agents: { name: string } | null;
}

interface TranscriptMessage {
  role?: string;
  speaker?: string;
  text?: string;
  timestamp?: string | number | null;
}

export default function CallLogs() {
  const { user } = useAuth();
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [callView, setCallView] = useState<"live" | "demo">("live");
  const [searchParams, setSearchParams] = useSearchParams();
  const typeParam = searchParams.get("type");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all"); // "all" or one of HISTORY_TYPES[type].statuses
  const historyType: HistoryType = typeParam && typeParam in HISTORY_TYPES ? (typeParam as HistoryType) : "calls";
  const [loading, setLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState<string | null>(null); // call id whose summary is being written

  // Calls are saved without a summary; the first time one is opened, Muse writes it and it's stored on the row.
  useEffect(() => {
    const call = selectedCall;
    const lines = Array.isArray(call?.transcript) ? (call!.transcript as unknown as TranscriptMessage[]) : [];
    if (!call || call.summary || lines.length < 2 || summarizing === call.id) return;
    setSummarizing(call.id);
    summarizeCallTranscript({
      transcript: lines.map((m) => `${String(m.role || m.speaker).toLowerCase() === "agent" ? "Agent" : "Caller"}: ${m.text}`).join("\n"),
      direction: call.direction, agentName: call.agents?.name, durationSeconds: call.duration,
      phoneNumber: call.direction === "inbound" ? call.caller_number : call.recipient_number,
    })
      .then(async (summary) => {
        const { error } = await supabase.from("call_logs").update({ summary }).eq("id", call.id);
        if (error) console.warn("summary not saved", error.message);
        const withSummary = (c: CallLog) => (c.id === call.id ? { ...c, summary } : c);
        setCalls((list) => list.map(withSummary));
        setSelectedCall((c) => (c ? withSummary(c) : c));
      })
      .catch((e) => toast.error("Couldn't write the call summary", { description: (e as Error).message }))
      .finally(() => setSummarizing(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCall?.id, selectedCall?.summary]);
  const isLocalDashboard = false; // ponytail: local /api/local + edge-function data path needs undeployed functions; read the DB directly

  const fetchCalls = async () => {
    if (!user) return [] as CallLog[];

    if (isLocalDashboard) {
      const response = await fetch("/api/local/voice-space-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, userEmail: user.email || "" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error("Failed to load call history", { description: payload?.error || "Unknown error" });
        setLoading(false);
        return [] as CallLog[];
      }

      const nextCalls = (Array.isArray(payload?.callLogs) ? payload.callLogs : []) as CallLog[];
      setCalls(nextCalls);
      setSelectedCall((current) => {
        if (!current) return current;
        return nextCalls.find((call) => call.id === current.id) || current;
      });
      setLoading(false);
      return nextCalls;
    }

    const { data, error } = await supabase
      .from("call_logs")
      .select("*, agents(name)")
      .order("started_at", { ascending: false });

    if (error) {
      toast.error("Failed to load call history", { description: error.message });
      setLoading(false);
      return [] as CallLog[];
    }

    const nextCalls = ((data as any) || []) as CallLog[];
    setCalls(nextCalls);
    setSelectedCall((current) => {
      if (!current) return current;
      return nextCalls.find((call) => call.id === current.id) || current;
    });
    setLoading(false);
    return nextCalls;
  };

  useEffect(() => {
    const channel = supabase
      .channel('call-logs-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_logs' }, () => {
        fetchCalls();
      })
      .subscribe();

    void fetchCalls();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, isLocalDashboard]);

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "completed": return "default";
      case "in-progress": return "secondary";
      case "failed": return "destructive";
      default: return "outline" as const;
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getCallId = (call: CallLog) => {
    // "storage:<path>" is where a demo recording lives, not a call id.
    return call.ultravox_call_id || (call.twilio_call_sid?.startsWith("storage:") ? null : call.twilio_call_sid) || call.id;
  };

  const shortId = (id: string) => {
    if (id.length > 12) return id.slice(0, 6) + "…" + id.slice(-4);
    return id;
  };

  // Click a call to expand its details in place; click again to collapse.
  const handleSelectCall = (call: CallLog) => {
    setSelectedCall(call);
  };

  const filteredCalls = calls.filter((call) =>
    (callView === "demo" ? call.direction === "demo" : call.direction !== "demo") &&
    (status === "all" || call.status.toLowerCase() === status) &&
    matchesSearch(search, [call.caller_number, call.recipient_number, call.agents?.name, call.status, call.summary, JSON.stringify(call.transcript ?? "")])
  );

  return (
    <DashboardLayout>
      <div className="flex flex-col h-full animate-rise-in">
        <div className="flex items-center justify-between mb-6 shrink-0">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">History</h1>
            <p className="text-muted-foreground mt-1">{HISTORY_TYPES[historyType].hint}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
          <Select value={historyType} onValueChange={(v) => { setStatus("all"); setSearchParams(v === "calls" ? {} : { type: v }, { replace: true }); }}>
            <SelectTrigger className="h-10 w-40" aria-label="History type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(HISTORY_TYPES).map(([key, t]) => (
                <SelectItem key={key} value={key}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {historyType === "calls" && (
          <div className="inline-flex items-center gap-1.5 rounded-2xl bg-muted/40 p-1">
            <Button
              type="button"
              variant={callView === "live" ? "default" : "ghost"}
              className={
                callView === "live"
                  ? "h-9 rounded-lg px-4 text-sm font-medium transition-all duration-200 ease-out"
                  : "h-9 rounded-lg px-4 text-sm font-medium text-muted-foreground transition-all duration-200 ease-out"
              }
              onClick={() => setCallView("live")}
            >
              Live
            </Button>
            <Button
              type="button"
              variant={callView === "demo" ? "default" : "ghost"}
              className={
                callView === "demo"
                  ? "h-9 rounded-lg px-4 text-sm font-medium transition-all duration-200 ease-out"
                  : "h-9 rounded-lg px-4 text-sm font-medium text-muted-foreground transition-all duration-200 ease-out"
              }
              onClick={() => setCallView("demo")}
            >
              Demo
            </Button>
          </div>
          )}
          </div>
        </div>

        <div className="mb-6 flex shrink-0 flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor="history-search" className="sr-only">Search history</label>
          <Input
            id="history-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${HISTORY_TYPES[historyType].label.toLowerCase()} by name, number or message`}
            className="h-11 pl-9"
          />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-11 w-full sm:w-48" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All results</SelectItem>
              {HISTORY_TYPES[historyType].statuses.map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {historyType === "sms" ? <SmsHistory embedded search={search} status={status} /> : historyType === "whatsapp" ? <WhatsAppHistory search={search} status={status} /> : historyType === "email" ? <GmailHistory embedded search={search} status={status} /> : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={callView}
            initial={{ y: 10 }}
            animate={{ y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-20 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : filteredCalls.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <History className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-semibold mb-1">
                    {search.trim() || status !== "all" ? "No calls match" : `No ${callView === "demo" ? "demo" : "live"} calls yet`}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {search.trim() || status !== "all"
                      ? "Try a different status, name, number or word from the transcript."
                      : callView === "demo"
                      ? "Demo calls will appear here once you start testing agents in the browser."
                      : "Live calls will appear here once your agents start receiving or placing calls."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredCalls.map((call) => (
                  <Card
                    key={call.id}
                    className="transition-colors hover:border-primary/40"
                  >
                    <CardContent
                      className="flex cursor-pointer items-center gap-4 p-4"
                      role="button"
                      tabIndex={0}
                      aria-haspopup="dialog"
                      onClick={() => handleSelectCall(call)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectCall(call); } }}
                    >
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                        call.direction === "inbound" ? "bg-accent" : "bg-primary/10"
                      }`}>
                        {call.direction === "inbound" ? (
                          <PhoneIncoming className="h-4 w-4 text-accent-foreground" />
                        ) : (
                          <PhoneOutgoing className="h-4 w-4 text-primary" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="font-medium text-sm truncate font-mono">
                            {call.direction === "demo"
                              ? "Browser demo call"
                              : `${call.caller_number || "?"} → ${call.recipient_number || "?"}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="capitalize">
                            {call.direction === "demo" ? "Demo" : call.direction}
                          </span>
                          {call.agents?.name && (
                            <>
                              <span>·</span>
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                {call.agents.name}
                              </span>
                            </>
                          )}
                          {call.transcript && (
                            <>
                              <span>·</span>
                              <Badge variant="outline" className="text-[10px] h-4">Transcript</Badge>
                            </>
                          )}
                          <Badge variant={statusColor(call.status) as any} className="h-4 shrink-0 text-[10px]">
                            {call.status}
                          </Badge>
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="font-mono text-sm font-medium">{formatDuration(call.duration)}</p>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                          <Clock className="h-3 w-3" />
                          <span>{formatDate(call.started_at)}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        )}

        <Dialog open={!!selectedCall} onOpenChange={(open) => !open && setSelectedCall(null)}>
          <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
            {selectedCall && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex flex-wrap items-center gap-2 font-mono text-base">
                    {selectedCall.direction === "demo" ? "Browser demo call" : `${selectedCall.caller_number || "?"} → ${selectedCall.recipient_number || "?"}`}
                    <Badge variant={statusColor(selectedCall.status) as any} className="font-sans text-[10px]">{selectedCall.status}</Badge>
                  </DialogTitle>
                  <DialogDescription>
                    {new Date(selectedCall.started_at).toLocaleString()} · {formatDuration(selectedCall.duration)}
                  </DialogDescription>
                </DialogHeader>
                    <div className="space-y-5">
                      {/* Call metadata grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">Call ID</p>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs">{shortId(getCallId(selectedCall))}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); copyToClipboard(getCallId(selectedCall)); }}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {copiedId === getCallId(selectedCall) ? (
                                <Check className="h-3 w-3 text-primary" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">Direction</p>
                          <p className="capitalize font-medium">{selectedCall.direction}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">Duration</p>
                          <p className="font-mono font-medium">{formatDuration(selectedCall.duration)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">Agent</p>
                          <p className="font-medium">{selectedCall.agents?.name || "—"}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">From</p>
                          <p className="font-mono text-xs">{selectedCall.caller_number || (selectedCall.direction === "demo" ? "Browser" : "—")}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">To</p>
                          <p className="font-mono text-xs">{selectedCall.recipient_number || (selectedCall.direction === "demo" ? "Agent" : "—")}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs mb-0.5">Started At</p>
                          <p className="text-xs">{new Date(selectedCall.started_at).toLocaleString()}</p>
                        </div>
                        {selectedCall.ended_at && (
                          <div>
                            <p className="text-muted-foreground text-xs mb-0.5">Ended At</p>
                            <p className="text-xs">{new Date(selectedCall.ended_at).toLocaleString()}</p>
                          </div>
                        )}
                        {selectedCall.twilio_call_sid && !selectedCall.twilio_call_sid.startsWith("storage:") && (
                          <div>
                            <p className="text-muted-foreground text-xs mb-0.5">{selectedCall.twilio_call_sid.startsWith("telnyx:") ? "Telnyx Call ID" : "Twilio SID"}</p>
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs">{shortId(selectedCall.twilio_call_sid)}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); copyToClipboard(selectedCall.twilio_call_sid!); }}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                {copiedId === selectedCall.twilio_call_sid ? (
                                  <Check className="h-3 w-3 text-primary" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Recording: fetched live from the provider, never stored */}
                      <CallRecording call={selectedCall} />

                      {/* Call Summary: written by Muse the first time the call is opened */}
                      {(selectedCall.summary || summarizing === selectedCall.id) && (
                        <div>
                          <p className="text-sm font-medium flex items-center gap-1.5 mb-2">
                            <FileText className="h-4 w-4 text-primary" /> Call Summary
                          </p>
                          <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 text-sm whitespace-pre-wrap">
                            {selectedCall.summary || <span className="text-muted-foreground">Writing the summary…</span>}
                          </div>
                        </div>
                      )}

                      {/* Transcript */}
                      {selectedCall.transcript ? (
                        <div>
                          <p className="text-sm font-medium mb-2">Transcript</p>
                          <div className="rounded-lg bg-muted p-4 text-sm space-y-3 max-h-80 overflow-auto">
                            {Array.isArray(selectedCall.transcript)
                              ? (selectedCall.transcript as TranscriptMessage[]).map((msg, i) => (
                                  <div key={i} className="flex gap-2">
                                    {(() => {
                                      const normalizedSpeaker = String(msg.role || msg.speaker || "system").toLowerCase();
                                      const isAgent = normalizedSpeaker === "agent";
                                      const label =
                                        normalizedSpeaker === "agent"
                                          ? "Agent"
                                          : normalizedSpeaker === "user" || normalizedSpeaker === "caller"
                                            ? "Caller"
                                            : normalizedSpeaker.charAt(0).toUpperCase() + normalizedSpeaker.slice(1);

                                      return (
                                        <Badge
                                          variant={isAgent ? "default" : "secondary"}
                                          className="text-xs shrink-0 h-5 mt-0.5"
                                        >
                                          {label}
                                        </Badge>
                                      );
                                    })()}
                                    <p className="text-sm leading-relaxed">{msg.text}</p>
                                  </div>
                                ))
                              : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(selectedCall.transcript, null, 2)}</pre>
                            }
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed p-6 text-center">
                          <p className="text-sm text-muted-foreground">
                            No transcript available.
                          </p>
                        </div>
                      )}

                    </div>
              </>
            )}
          </DialogContent>
        </Dialog>

      </div>
    </DashboardLayout>
  );
}
