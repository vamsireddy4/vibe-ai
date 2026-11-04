import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Mic, MicOff, MonitorSmartphone, PhoneOff, Volume2, VolumeX } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { usePersistentState } from "@/hooks/usePersistentState";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { DemoCallService, type DemoCallStatus, type DemoTranscriptItem } from "@/lib/services/demo-call.service";
import { getErrorMessage } from "@/lib/edge-functions";
import { ADMIN_EMAIL } from "@/lib/constants";
import { useLiveMinuteBalance } from "@/hooks/useLiveMinuteBalance";

const CONNECTED_STATUSES = new Set(["listening", "thinking", "speaking"]);
const statusLabelMap: Record<DemoCallStatus, string> = {
  disconnected: "Disconnected",
  disconnecting: "Disconnecting",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const statusClassMap: Record<DemoCallStatus, string> = {
  disconnected: "bg-muted text-muted-foreground",
  disconnecting: "bg-orange-100 text-orange-700",
  connecting: "bg-primary/10 text-primary",
  listening: "bg-emerald-100 text-emerald-700",
  thinking: "bg-amber-100 text-amber-700",
  speaking: "bg-muted text-foreground",
};

export default function DemoCall() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [agents, setAgents] = useState<Tables<"agents">[]>([]);
  const [form, setForm] = usePersistentState("demo-call-form", { agent_id: "" });
  const [isStarting, setIsStarting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [status, setStatus] = useState<DemoCallStatus>("disconnected");
  const [transcripts, setTranscripts] = useState<DemoTranscriptItem[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
  const serviceRef = useRef<DemoCallService | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const durationSecondsRef = useRef(0);
  const latestDurationRef = useRef(0);
  const transcriptsRef = useRef<DemoTranscriptItem[]>([]);
  const getTrackedDuration = () => {
    const liveDuration =
      startedAtRef.current != null
        ? Math.max(0, Math.round((Date.now() - new Date(startedAtRef.current).getTime()) / 1000))
        : startTimeRef.current != null
          ? Math.max(0, Math.round((Date.now() - startTimeRef.current) / 1000))
          : 0;

    return Math.max(liveDuration, latestDurationRef.current, durationSecondsRef.current);
  };

  const stopDurationTracking = (finalDuration?: number) => {
    const resolvedDuration = finalDuration ?? getTrackedDuration();
    startTimeRef.current = null;
    latestDurationRef.current = resolvedDuration;
    durationSecondsRef.current = resolvedDuration;
    setDurationSeconds(resolvedDuration);
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadAgents = async () => {
      try {
        // Read the agents table directly (RLS limits it to this user); the
        // voice-space-data edge function isn't deployed on this project.
        const { data, error } = await supabase.from("agents").select("*");
        if (error) throw error;
        if (cancelled) return;

        setAgents(
          (data ?? [])
            .filter((agent) => agent.is_active)
            .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
        );
      } catch (error) {
        console.error("Failed to load demo call agents", error);
      }
    };

    void loadAgents();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!startedAt) return;

    // Stop timer if call is no longer active
    if (status === "disconnected" || status === "disconnecting") {
      return;
    }

    const update = () => {
      const nextDuration = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
      latestDurationRef.current = nextDuration;
      durationSecondsRef.current = nextDuration;
      setDurationSeconds(nextDuration);
    };

    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [startedAt, status]);

  useEffect(() => {
    return () => {
      serviceRef.current?.leave().catch(() => undefined);
    };
  }, []);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === form.agent_id) || null,
    [agents, form.agent_id],
  );
  const isAdmin = user?.email === ADMIN_EMAIL;
  const { availableSeconds, liveAvailableSeconds } = useLiveMinuteBalance(user?.id, isAdmin);

  const ensureService = () => {
    if (serviceRef.current) return serviceRef.current;

    serviceRef.current = new DemoCallService({
      onStatusChange: (nextStatus) => {
        setStatus(nextStatus);
        setIsMicMuted(serviceRef.current?.isMicMuted ?? false);
        setIsSpeakerMuted(serviceRef.current?.isSpeakerMuted ?? false);
        if (CONNECTED_STATUSES.has(nextStatus) && !startTimeRef.current && !startedAtRef.current) {
          const now = Date.now();
          const nowIso = new Date(now).toISOString();
          startTimeRef.current = now;
          startedAtRef.current = nowIso;
          setStartedAt(nowIso);
        }

        if (nextStatus === "disconnected" || nextStatus === "disconnecting") {
          const frozenDuration = getTrackedDuration();
          stopDurationTracking(frozenDuration);
        }
      },
      onTranscriptsChange: (items) => {
        transcriptsRef.current = items;
        setTranscripts(items);
      },
      onRuntimeError: (message) => {
        toast({
          title: "Browser mic issue",
          description: message,
          variant: "destructive",
        });
      },
    });

    return serviceRef.current;
  };

  const handleStart = async () => {
    if (!form.agent_id) {
      toast({ title: "Select an agent", description: "Choose an agent before starting the demo call.", variant: "destructive" });
      return;
    }
    if (!isAdmin && (availableSeconds ?? 0) <= 0) {
      toast({ title: "No minutes left", description: "Your free minutes are used up. Add minutes to keep making calls.", variant: "destructive" });
      return;
    }

    setIsStarting(true);
    setTranscripts([]);
    transcriptsRef.current = [];
    latestDurationRef.current = 0;
    durationSecondsRef.current = 0;
    setDurationSeconds(0);
    setStatus("connecting");
    setIsMicMuted(false);
    setIsSpeakerMuted(false);
    startTimeRef.current = null;
    startedAtRef.current = null;
    setStartedAt(null);

    try {
      // The voice agent service checks and deducts minutes and saves the call log.
      const now = Date.now();
      startTimeRef.current = now;
      startedAtRef.current = new Date(now).toISOString();
      setStartedAt(startedAtRef.current);
      await ensureService().join({
        model: selectedAgent?.model || "muse-spark-1.3",
        systemPrompt: (selectedAgent as { system_prompt?: string } | null)?.system_prompt,
        voice: selectedAgent?.voice,
        userId: user?.id, // the voice agent saves the call to Call History (Demo) when it ends
        agentId: selectedAgent?.id,
      });
      toast({ title: "Demo call started", description: "Talking to your Meta agent. Use headphones so it doesn't hear itself." });
    } catch (error) {
      setStatus("disconnected");
      toast({
        title: "Unable to start demo call",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsStarting(false);
    }
  };

  const handleEnd = async () => {
    if (!serviceRef.current) return;
    setIsEnding(true);
    setStatus("disconnecting");
    stopDurationTracking(getTrackedDuration());

    try {
      await serviceRef.current.leave();
    } catch (error) {
      toast({
        title: "Unable to end demo call cleanly",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    } finally {
      setIsEnding(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const currentService = serviceRef.current;
  const isCallActive = status !== "disconnected" && status !== "disconnecting";

  useEffect(() => {
    if (isAdmin || !isCallActive) return;
    if ((liveAvailableSeconds ?? 0) > 0) return;

    toast({
      title: "Minutes exhausted",
      description: "The demo call is ending because your available minutes reached zero.",
      variant: "destructive",
    });
    void handleEnd();
  }, [isAdmin, isCallActive, liveAvailableSeconds]);

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in" data-page="demo-call">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Demo Call</h1>
          <p className="mt-1 text-muted-foreground">Test your AI agent directly in the browser with live audio and transcript.</p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <MonitorSmartphone className="h-5 w-5" />
                  Start Demo Call
                </CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Use your microphone to talk to the selected agent without placing a phone call.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge className={statusClassMap[status]}>{statusLabelMap[status]}</Badge>
                <div className="text-sm text-muted-foreground">Duration {formatDuration(durationSeconds)}</div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-2">
                <Label>Agent</Label>
                <Select
                  value={form.agent_id}
                  onValueChange={(value) => setForm((current) => ({ ...current, agent_id: value }))}
                  disabled={isCallActive || isStarting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
                <div className="text-sm font-medium text-foreground">Selected Agent</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {selectedAgent ? `${selectedAgent.name}${selectedAgent.voice ? ` · ${selectedAgent.voice}` : ""}` : "Choose an agent to start the browser demo call."}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleStart} disabled={isStarting || isEnding || isCallActive || !form.agent_id || (!isAdmin && (availableSeconds ?? 0) <= 0)}>
                {isStarting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting Demo Call...
                  </>
                ) : (
                  <>
                    <Mic className="mr-2 h-4 w-4" />
                    Start Demo Call
                  </>
                )}
              </Button>

              <Button variant="outline" onClick={handleEnd} disabled={!isCallActive || isEnding}>
                {isEnding ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Ending...
                  </>
                ) : (
                  <>
                    <PhoneOff className="mr-2 h-4 w-4" />
                    End Demo Call
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  currentService?.toggleMic();
                  setIsMicMuted(currentService?.isMicMuted ?? false);
                }}
                disabled={!isCallActive}
              >
                {isMicMuted ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                {isMicMuted ? "Unmute Mic" : "Mute Mic"}
              </Button>

              <Button
                variant="outline"
                onClick={() => {
                  currentService?.toggleSpeaker();
                  setIsSpeakerMuted(currentService?.isSpeakerMuted ?? false);
                }}
                disabled={!isCallActive}
              >
                {isSpeakerMuted ? <VolumeX className="mr-2 h-4 w-4" /> : <Volume2 className="mr-2 h-4 w-4" />}
                {isSpeakerMuted ? "Unmute Speaker" : "Mute Speaker"}
              </Button>
            </div>

            <Separator />

            <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground">Session Details</div>
                <div className="mt-4 space-y-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Agent</div>
                    <div className="mt-1 font-medium text-foreground">{selectedAgent?.name || "Not selected"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Started At</div>
                    <div className="mt-1 font-medium text-foreground">
                      {startedAt ? new Date(startedAt).toLocaleString() : "Not started"}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Transcript Items</div>
                    <div className="mt-1 font-medium text-foreground">{transcripts.length}</div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                    Demo calls now use the same minute balance as live calls. If your balance reaches zero, new calls are blocked.
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                  <div className="text-sm font-semibold text-foreground">Live Transcript</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Real-time conversation updates appear here while the demo call is active.
                  </div>
                </div>
                <ScrollArea className="h-[420px] px-4 py-4">
                  {transcripts.length === 0 ? (
                    <div className="flex h-[360px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-6 text-center text-sm text-muted-foreground">
                      Start a demo call to see the transcript stream in real time.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {transcripts.map((item) => (
                        <div
                          key={`${item.ordinal}-${item.speaker}`}
                          className="rounded-xl border border-border bg-background/90 p-3 shadow-sm"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Badge variant={item.speaker === "agent" ? "default" : "secondary"}>
                                {item.speaker === "agent" ? "Agent" : "You"}
                              </Badge>
                              {!item.isFinal && <Badge variant="outline">Live</Badge>}
                            </div>
                            <span className="text-xs text-muted-foreground">#{item.ordinal + 1}</span>
                          </div>
                          <p className="text-sm leading-6 text-foreground">{item.text || "…"}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          </CardContent>
        </Card>

      </div>
    </DashboardLayout>
  );
}
