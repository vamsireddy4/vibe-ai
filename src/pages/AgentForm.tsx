import { useEffect, useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getVibePath } from "@/lib/vibe-routes";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Search, Settings, Wrench, Plus, Trash2, PhoneForwarded } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import AgentCalendarIntegrations from "@/components/agent-tabs/AgentCalendarIntegrations";
import AgentBodyTemplate from "@/components/agent-tabs/AgentBodyTemplate";
import { AnimatePresence, motion } from "framer-motion";
import { usePersistentState } from "@/hooks/usePersistentState";
import { META_MODELS, META_VOICES, DEFAULT_META_MODEL, DEFAULT_META_VOICE } from "@/lib/provider-config";

interface ForwardingNumber {
  id: string;
  phone_number: string;
  label: string | null;
  priority: number;
}


interface VoiceOption {
  voiceId: string;
  name: string;
  description?: string;
  previewUrl?: string;
  languageLabel?: string;
}

const FIRST_SPEAKER_OPTIONS = [
  { value: "FIRST_SPEAKER_AGENT", label: "Agent speaks first (inbound)" },
  { value: "FIRST_SPEAKER_USER", label: "User speaks first (outbound)" },
];

export default function AgentForm() {
  const { id } = useParams();
  const isEditing = !!id;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [phoneConfigs, setPhoneConfigs] = useState<Tables<"phone_configs">[]>([]);
  // Every Deepgram Aura voice, from the voice agent's /voices (it holds the Deepgram key).
  const [metaVoices, setMetaVoices] = useState<VoiceOption[]>([]);
  useEffect(() => {
    fetch(`${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/voices`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { voices: { id: string; name: string; language: string; accent: string; gender: string; sample: string }[] }) =>
        setMetaVoices(d.voices.map((v) => ({
          voiceId: v.id,
          name: v.id,
          description: [v.name, v.accent, v.gender].filter(Boolean).join(" · "),
          languageLabel: v.language ? `(${v.language})` : "",
          previewUrl: v.sample,
        }))),
      )
      .catch(() => setMetaVoices([])); // voice agent down: fall back to the built-in default voice
  }, []);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [forwardingNumbers, setForwardingNumbers] = useState<ForwardingNumber[]>([]);
  const [newFwdLabel, setNewFwdLabel] = useState("");
  const [newFwdNumber, setNewFwdNumber] = useState("");
  const [activeTab, setActiveTab] = usePersistentState(`agent-form-active-tab-${id || "new"}`, "general");
  
  const [form, setForm] = useState({
    name: "",
    system_prompt: "You are a helpful and friendly receptionist. Answer questions about the business, take messages, and help callers with their needs.",
    voice: DEFAULT_META_VOICE,
    temperature: 0.7,
    first_speaker: "FIRST_SPEAKER_AGENT",
    language_hint: "en",
    max_duration: 300,
    is_active: true,
    phone_number_id: null as string | null,
    model: DEFAULT_META_MODEL,
    ai_provider: "meta",
  });

  useEffect(() => {
    if (!user) return;
    supabase.from("phone_configs").select("*").then(({ data }) => setPhoneConfigs((data || []).filter((config:any) => config.channel !== "sms")));
    if (!isEditing) return;

    supabase.from("agents").select("*").eq("id", id).single().then(({ data, error }) => {
      if (error || !data) {
        toast({ title: "Agent not found", description: "This agent may have been deleted.", variant: "destructive" });
        navigate(getVibePath("voice", "agents"));
        return;
      }
      setForm({
        name: data.name, system_prompt: data.system_prompt,
        voice: (data as any).ai_provider === "meta" ? data.voice : DEFAULT_META_VOICE,
        temperature: Number(data.temperature), first_speaker: data.first_speaker,
        language_hint: data.language_hint || "en", max_duration: data.max_duration || 300,
        is_active: data.is_active, phone_number_id: data.phone_number_id,
        model: (data as any).ai_provider === "meta" && (data as any).model ? (data as any).model : DEFAULT_META_MODEL,
        ai_provider: "meta",
      });
    });

    supabase.from("call_forwarding_numbers")
      .select("id, phone_number, label, priority")
      .eq("agent_id", id)
      .order("priority", { ascending: true })
      .then(({ data }) => setForwardingNumbers(data || []));
  }, [user, id, navigate, toast, isEditing]);

  const handleDelete = async () => {
    if (!id || !window.confirm("Are you sure you want to delete this agent? This action cannot be undone.")) return;
    
    setLoading(true);
    try {
      const { error } = await supabase.from("agents").delete().eq("id", id);
      if (error) throw error;

      toast({ title: "Agent deleted" });
      navigate(getVibePath("voice", "agents"));
    } catch (err: any) {
      toast({ title: "Error deleting agent", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  /** Save the typed forwarding number (the + button, and Update Agent so a typed number is never lost). */
  const addForwarding = async (agentId?: string) => {
    const phone = newFwdNumber.replace(/[^\d+]/g, "");
    if (!phone || !agentId || !user) return true;
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      toast({ title: "Check the forwarding number", description: "Use the full number with country code, like +919876543210.", variant: "destructive" });
      return false;
    }
    const priority = forwardingNumbers.length ? Math.max(...forwardingNumbers.map(f => f.priority)) + 1 : 0;
    const { data, error } = await supabase.from("call_forwarding_numbers").insert({
      agent_id: agentId, user_id: user.id, phone_number: phone, label: newFwdLabel.trim() || null, priority,
    }).select("id, phone_number, label, priority").single();
    if (error) {
      toast({ title: "Forwarding number not saved", description: error.message, variant: "destructive" });
      return false;
    }
    setForwardingNumbers(prev => [...prev, data]);
    setNewFwdNumber("");
    setNewFwdLabel("");
    toast({ title: "Forwarding number added" });
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setLoading(true);
    const normalizedForm = { ...form, ai_provider: "meta" };
    if (!META_MODELS.some((m) => m.value === normalizedForm.model)) normalizedForm.model = DEFAULT_META_MODEL;
    if (!/^aura-[\w-]+$/.test(normalizedForm.voice)) normalizedForm.voice = DEFAULT_META_VOICE; // voice agent re-checks against Deepgram's list
    normalizedForm.language_hint = normalizedForm.language_hint || "en";
    const payload = { ...normalizedForm, user_id: user.id };

    let savedAgentId = id;

    if (isEditing) {
      const { error } = await supabase.from("agents").update(payload).eq("id", id);
      if (error) { toast({ title: "Error", description: error.message, variant: "destructive" }); setLoading(false); return; }
    } else {
      const { data: newAgent, error } = await supabase.from("agents").insert(payload).select("id").single();
      if (error || !newAgent) { toast({ title: "Error", description: error?.message || "Failed to create agent", variant: "destructive" }); setLoading(false); return; }
      savedAgentId = newAgent.id;
    }

    if (!(await addForwarding(savedAgentId))) { setLoading(false); return; }

    setLoading(false);
    toast({ title: isEditing ? "Agent updated" : "Agent created" });
    if (!isEditing) navigate(getVibePath("voice", "agents"));
  };


  const allVoices = useMemo<VoiceOption[]>(
    () => metaVoices.length ? metaVoices : META_VOICES.map(v => ({ voiceId: v.value, name: v.value, description: v.label, languageLabel: "" })),
    [metaVoices],
  );

  const filteredVoices = useMemo(() => {
    if (!voiceSearch.trim()) return allVoices;
    const q = voiceSearch.toLowerCase();
    return allVoices.filter(v => v.name.toLowerCase().includes(q) || v.description?.toLowerCase().includes(q) || v.languageLabel?.toLowerCase().includes(q));
  }, [allVoices, voiceSearch]);

  const currentVoiceName = useMemo(() => {
    const found = allVoices.find(v => v.voiceId === form.voice || v.name === form.voice);
    return found ? `${found.name} ${found.languageLabel || ""}` : form.voice;
  }, [allVoices, form.voice]);

  const tabs = [
    { value: "general", label: "General", icon: Settings, disabled: false },
    { value: "tools", label: "Tools", icon: Wrench, disabled: !isEditing },
  ] as const;
  // A tab saved from before (e.g. the removed Knowledge/Webhooks tabs) falls back to General.
  const currentTab = tabs.some((tab) => tab.value === activeTab) ? activeTab : "general";
  const activeIndex = Math.max(tabs.findIndex((tab) => tab.value === currentTab), 0);

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Back to agents" onClick={() => navigate(getVibePath("voice", "agents"))}><ArrowLeft className="h-4 w-4" /></Button>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{isEditing ? form.name || "Edit Agent" : "Create Agent"}</h1>
            <p className="text-muted-foreground mt-1">Configure your AI receptionist.</p>
          </div>
        </div>

        <Tabs value={currentTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="relative grid w-full grid-cols-2 overflow-hidden rounded-xl border border-border/50 bg-muted/60 p-1">
            <motion.div
              className="absolute inset-y-1 rounded-lg bg-background shadow-sm"
              animate={{
                width: "calc(50% - 6px)",
                x: `calc(${activeIndex * 100}% + 4px)`,
                opacity: tabs[activeIndex]?.disabled ? 0 : 1,
              }}
              transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.85 }}
            />
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  disabled={tab.disabled}
                  className="relative z-10 flex items-center gap-2 rounded-lg bg-transparent transition-colors duration-300 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          <AnimatePresence mode="wait" initial={false}>
            {currentTab === "general" && (
              <TabsContent value="general" forceMount className="relative mt-6 overflow-hidden">
                <motion.div
                  key="general"
                  initial={{ y: 14, scale: 0.985 }}
                  animate={{ y: 0, scale: 1 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                >
                  <form onSubmit={handleSubmit} className="space-y-6">
              <Card>
                <CardHeader><CardTitle>Basic Info</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Agent Name</Label>
                    <Input id="name" placeholder="e.g. Front Desk Receptionist" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="prompt">System Prompt</Label>
                      <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setPromptDialogOpen(true)}>
                        Expand ↗
                      </Button>
                    </div>
                    <Textarea id="prompt" placeholder="Describe how your receptionist should behave..." value={form.system_prompt} onChange={e => setForm({ ...form, system_prompt: e.target.value })} rows={6} required className="cursor-pointer" onClick={() => setPromptDialogOpen(true)} readOnly />
                    <p className="text-xs text-muted-foreground">Click to expand and edit the full prompt.</p>
                    <Dialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen}>
                      <DialogContent className="sm:max-w-2xl max-h-[80vh]">
                        <DialogHeader>
                          <DialogTitle>System Prompt</DialogTitle>
                          <DialogDescription className="sr-only">
                            Edit the full system prompt that controls this agent’s behavior.
                          </DialogDescription>
                        </DialogHeader>
                        <Textarea aria-label="System prompt" value={form.system_prompt} onChange={e => setForm({ ...form, system_prompt: e.target.value })} rows={20} className="min-h-[400px] text-sm" />
                      </DialogContent>
                    </Dialog>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5"><Label htmlFor="agent-active">Active</Label><p className="text-xs text-muted-foreground">Enable this agent to receive calls</p></div>
                    <Switch id="agent-active" aria-label="Agent active" checked={form.is_active} onCheckedChange={val => setForm({ ...form, is_active: val })} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>AI Provider & Model</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="agent-model">Model</Label>
                    <Select value={form.model} onValueChange={val => setForm({ ...form, model: val })}>
                      <SelectTrigger id="agent-model"><SelectValue /></SelectTrigger>
                      <SelectContent>{META_MODELS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="agent-voice">Voice</Label>
                    <Select
                      open={voicePickerOpen}
                      onOpenChange={(open) => {
                        setVoicePickerOpen(open);
                        if (!open) setVoiceSearch("");
                      }}
                      value={form.voice}
                      onValueChange={val => setForm({ ...form, voice: val })}
                    >
                      <SelectTrigger id="agent-voice"><SelectValue>{currentVoiceName}</SelectValue></SelectTrigger>
                      <SelectContent className="max-h-72">
                        <div className="sticky top-0 z-10 border-b bg-popover p-2">
                          <div className="relative">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                              className="pl-9"
                              placeholder="Search voices..."
                              aria-label="Search voices"
                              value={voiceSearch}
                              onChange={e => setVoiceSearch(e.target.value)}
                              onKeyDown={e => e.stopPropagation()}
                            />
                          </div>
                        </div>
                        {filteredVoices.length === 0 ? (
                          <div className="p-3 text-sm text-muted-foreground text-center">No voices found</div>
                        ) : filteredVoices.map(v => (
                          <SelectItem key={v.voiceId} value={v.name}>
                            <div className="flex flex-col">
                              <span className="font-medium">{v.name} {v.languageLabel || ""}</span>
                              {v.description && <span className="text-xs text-muted-foreground line-clamp-1">{v.description}</span>}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="agent-first-speaker">First Speaker</Label>
                    <Select value={form.first_speaker} onValueChange={val => setForm({ ...form, first_speaker: val })}>
                      <SelectTrigger id="agent-first-speaker"><SelectValue /></SelectTrigger>
                      <SelectContent>{FIRST_SPEAKER_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Temperature: {form.temperature}</Label>
                    <Slider aria-label="Temperature" value={[form.temperature]} onValueChange={([val]) => setForm({ ...form, temperature: val })} min={0} max={1} step={0.1} />
                    <p className="text-xs text-muted-foreground">Lower = more focused, higher = more creative</p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="agent-language">Language</Label>
                      <Input id="agent-language" value={form.language_hint} onChange={e => setForm({ ...form, language_hint: e.target.value })} placeholder="en" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="agent-max-duration">Max Duration (seconds)</Label>
                      <Input id="agent-max-duration" type="number" value={form.max_duration} onChange={e => setForm({ ...form, max_duration: parseInt(e.target.value) || 300 })} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Phone Number</CardTitle></CardHeader>
                <CardContent>
                  {phoneConfigs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No phone numbers configured yet. <a href={getVibePath("voice", "phone-config")} className="text-primary hover:underline">Add one first</a>.</p>
                  ) : (
                    <Select value={form.phone_number_id || "none"} onValueChange={val => setForm({ ...form, phone_number_id: val === "none" ? null : val })}>
                      <SelectTrigger aria-label="Phone number"><SelectValue placeholder="Select a phone number" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {phoneConfigs.map(pc => <SelectItem key={pc.id} value={pc.id}>{pc.phone_number} {pc.friendly_name ? `(${pc.friendly_name})` : ""}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </CardContent>
              </Card>

              {isEditing && id && user && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <PhoneForwarded className="h-5 w-5" />
                      Call Forwarding
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Add phone numbers the AI agent can transfer calls to. Numbers are tried in order — if the first person is busy or doesn't answer, the call automatically forwards to the next.
                    </p>
                    {forwardingNumbers.length > 0 && (
                      <div className="space-y-2">
                        {forwardingNumbers.map((fwd, index) => (
                          <div key={fwd.id} className="flex items-center gap-3 rounded-md border p-3">
                            <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary text-sm font-bold shrink-0">
                              {index + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{fwd.phone_number}</p>
                              {fwd.label && <p className="text-xs text-muted-foreground">{fwd.label}</p>}
                            </div>
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" aria-label={`Delete forwarding number ${fwd.phone_number}`} onClick={async () => {
                              try {
                                const { error } = await supabase.from("call_forwarding_numbers").delete().eq("id", fwd.id);
                                if (error) throw error;
                                setForwardingNumbers(prev => prev.filter(f => f.id !== fwd.id));
                                toast({ title: "Forwarding number removed" });
                              } catch (error: any) {
                                toast({ title: "Error", description: error?.message || "Failed to remove forwarding number", variant: "destructive" });
                              }
                            }}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input aria-label="Forwarding label" placeholder="Label (e.g. Sales)" value={newFwdLabel} onChange={e => setNewFwdLabel(e.target.value)} className="w-32 shrink-0" />
                      <Input aria-label="Forwarding phone number" placeholder="+1234567890" value={newFwdNumber} onChange={e => setNewFwdNumber(e.target.value)} className="flex-1" />
                      <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label="Add forwarding number" disabled={!newFwdNumber.trim()} onClick={() => void addForwarding(id)}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between gap-3 pt-6 border-t mt-4">
                <div className="flex gap-3">
                  <Button type="submit" disabled={loading}>{loading ? "Saving..." : isEditing ? "Update Agent" : "Create Agent"}</Button>
                  <Button type="button" variant="outline" onClick={() => navigate(getVibePath("voice", "agents"))}>Cancel</Button>
                </div>
                
                {isEditing && (
                  <Button 
                    type="button" 
                    variant="ghost" 
                    className="text-destructive hover:text-destructive hover:bg-destructive/10" 
                    onClick={handleDelete /* returns to Agents, which loads the list fresh (and live) */}
                    disabled={loading}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Agent
                  </Button>
                )}
              </div>
                  </form>
                </motion.div>
              </TabsContent>
            )}


            {isEditing && id && user && currentTab === "tools" && (
              <TabsContent value="tools" forceMount className="relative mt-6 overflow-hidden">
                <motion.div
                  key="tools"
                  initial={{ y: 14, scale: 0.985 }}
                  animate={{ y: 0, scale: 1 }}
                  transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  className="space-y-6"
                >
                  <Card>
                    <CardHeader><CardTitle>Appointment Tools</CardTitle></CardHeader>
                    <CardContent><AgentCalendarIntegrations agentId={id} userId={user.id} /></CardContent>
                  </Card>
                  <AgentBodyTemplate agentId={id} userId={user.id} userEmail={user.email || ""} />
                </motion.div>
              </TabsContent>
            )}

          </AnimatePresence>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
