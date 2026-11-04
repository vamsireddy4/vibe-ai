import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Pause, Play, Search } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

type Voice = { id: string; name: string; language: string; accent: string; gender: string; sample: string };
type AgentRow = { id: string; name: string; voice: string | null };

// Deepgram has two generations; the same name can exist in both (aura-asteria-en and aura-2-asteria-en).
const generation = (id: string) => (id.startsWith("aura-2-") ? "Aura 2" : "Aura");
const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const languageName = (code: string) => {
  try { return LANGUAGE_NAMES.of(code) ?? code; } catch { return code; }
};

/** Every voice agents can speak with (Deepgram Aura, listed by the voice agent), with samples and "Use for agent". */
export default function Voices() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [gender, setGender] = useState("all");
  const [playing, setPlaying] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/voices`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { voices: Voice[] }) => setVoices(d.voices ?? []))
      .catch((e) => { setLoadError(`Couldn't load the voices (${e.message}). Refresh to try again.`); setVoices([]); });
  }, []);

  useEffect(() => {
    if (!user) return;
    supabase.from("agents").select("id, name, voice").order("created_at", { ascending: false }).then(({ data }) => {
      setAgents((data ?? []) as AgentRow[]);
    });
  }, [user]);

  useEffect(() => () => audio.current?.pause(), []); // stop the sample when leaving the page

  const languages = useMemo(() => [...new Set((voices ?? []).map((v) => v.language).filter(Boolean))].sort((a, b) => languageName(a).localeCompare(languageName(b))), [voices]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (voices ?? []).filter((v) =>
      (language === "all" || v.language === language) &&
      (gender === "all" || v.gender === gender) &&
      (!q || `${v.name} ${v.accent} ${languageName(v.language)} ${v.id}`.toLowerCase().includes(q)));
  }, [voices, search, language, gender]);

  const toggle = (v: Voice) => {
    if (playing === v.id) { audio.current?.pause(); setPlaying(null); return; }
    audio.current?.pause();
    const a = new Audio(v.sample);
    a.onended = () => setPlaying(null);
    a.onerror = () => { setPlaying(null); toast({ title: "Couldn't play this sample", variant: "destructive" }); };
    audio.current = a;
    setPlaying(v.id);
    void a.play().catch(() => setPlaying(null));
  };

  const use = async (v: Voice, agent: AgentRow) => {
    setSaving(v.id);
    const { error } = await supabase.from("agents").update({ voice: v.id } as never).eq("id", agent.id);
    setSaving(null);
    if (error) return toast({ title: "Couldn't change the voice", description: error.message, variant: "destructive" });
    setAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, voice: v.id } : a)));
    toast({ title: `${agent.name} now speaks with ${displayName(v.name)} (${generation(v.id)})`, description: "It's used from the next call." });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Voices</h1>
            <p className="mt-1 text-muted-foreground">Every voice your agents can speak with. Play a sample, then use it for an agent.</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, accent or language" aria-label="Search voices" className="pl-9" />
          </div>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="sm:w-48" aria-label="Language"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              {languages.map((l) => <SelectItem key={l} value={l}>{languageName(l)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={gender} onValueChange={setGender}>
            <SelectTrigger className="sm:w-40" aria-label="Voice type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All voices</SelectItem>
              <SelectItem value="feminine">Female</SelectItem>
              <SelectItem value="masculine">Male</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {voices === null ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading voices" /></div>
        ) : loadError ? (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">{loadError}</CardContent></Card>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{shown.length} of {voices.length} voices</p>
            {shown.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No voices match. Clear the search or filters.</CardContent></Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((v) => {
                  const usedBy = agents.filter((a) => a.voice === v.id);
                  const current = usedBy.length > 0;
                  return (
                    <Card key={v.id} className={current ? "border-primary/50" : undefined}>
                      <CardContent className="flex items-center gap-3 p-4">
                        <Button
                          type="button" variant="outline" size="icon" className="shrink-0 rounded-full"
                          onClick={() => toggle(v)} disabled={!v.sample}
                          aria-label={`${playing === v.id ? "Stop" : "Play"} ${displayName(v.name)} (${generation(v.id)}) sample`}
                        >
                          {playing === v.id ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </Button>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 font-medium">
                            <span className="truncate">{displayName(v.name)}</span>
                            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground">{generation(v.id)}</Badge>
                          </p>
                          <p className="truncate text-sm text-muted-foreground">
                            {languageName(v.language)}{v.accent ? ` · ${v.accent}` : ""}{v.gender ? ` · ${v.gender === "masculine" ? "Male" : "Female"}` : ""}
                          </p>
                        </div>
                        {agents.length > 0 && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button type="button" size="sm" variant={current ? "secondary" : "outline"} className="shrink-0 gap-1" disabled={saving !== null}
                                title={current ? `In use by ${usedBy.map((a) => a.name).join(", ")}` : undefined}
                                aria-label={`Use ${displayName(v.name)} (${generation(v.id)}) for an agent${current ? `, in use by ${usedBy.map((a) => a.name).join(", ")}` : ""}`}>
                                {saving === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : current ? <><Check className="h-3 w-3" /> In use</> : "Use"}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Use for agent</DropdownMenuLabel>
                              {agents.map((a) => (
                                <DropdownMenuItem key={a.id} disabled={a.voice === v.id} onSelect={() => void use(v, a)}>
                                  {a.name}{a.voice === v.id ? " (in use)" : ""}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
