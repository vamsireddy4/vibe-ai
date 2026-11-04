import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, Navigate } from "react-router-dom";
import { Bot, CalendarCheck, PhoneIncoming, Check, FileText, Globe, Hand, Loader2, Mail, MessageCircleMore, MessageSquare, Mic, MicOff, Menu, MousePointer2, Pause, PhoneCall, PhoneForwarded, PhoneOff, Play, Sparkles, TriangleAlert, User, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import HeroTitle from "@/components/HeroTitle";
import BrandLogo from "@/components/BrandLogo";
import { GMAIL_LOGO, GOHIGHLEVEL_LOGO, GOOGLE_SHEETS_LOGO, TWILIO_LOGO, WHATSAPP_LOGO } from "@/lib/brand-logos";
import telnyxLogo from "@/assets/telnyx-logo.png";
import googleCalendarLogo from "@/assets/google-calendar-logo.svg";
import calcomLogo from "@/assets/calcom-logo.png";

const CHANNELS = [
  { icon: PhoneCall, name: "Voice", body: "Answers inbound calls on your number and makes outbound calls, one at a time or a whole list." },
  { icon: MessageSquare, name: "SMS", body: "Sends templated texts to a contact list and keeps every reply in one thread." },
  { icon: MessageCircleMore, name: "WhatsApp", body: "Connects to the WhatsApp Business API for chats, audiences and template campaigns." },
  { icon: Mail, name: "Email", body: "Sends follow-ups from Gmail using your template, filled in with each contact's details." },
];

// Logo PNGs are cropped to the logo itself (src/assets), so they fill the icon box as-is.
const TOOLS: { name: string; logo: string; zoom?: number; dy?: number }[] = [
  { name: "Twilio", logo: TWILIO_LOGO },
  { name: "Telnyx", logo: telnyxLogo },
  { name: "Google Calendar", logo: googleCalendarLogo },
  { name: "Cal.com", logo: calcomLogo },
  { name: "GoHighLevel", logo: GOHIGHLEVEL_LOGO },
  { name: "Google Sheets", logo: GOOGLE_SHEETS_LOGO },
  { name: "Gmail", logo: GMAIL_LOGO },
  { name: "WhatsApp Business", logo: WHATSAPP_LOGO },
];

const STEPS = [
  { title: "Describe the agent", body: "Pick your industry and a role like Appointment Scheduler or Quote Assistant, or describe it in a sentence. Vibe AI writes the prompt." },
  { title: "Teach it your business", body: "Upload PDFs, Word docs or text, or point it at your website. The agent answers from what you give it." },
  { title: "Connect your number and calendar", body: "Bring a Twilio or Telnyx number. Link Google Calendar, Cal.com or GoHighLevel so it can book meetings during your business hours." },
  { title: "Go live", body: "Take inbound calls, place an outbound call, or upload a CSV and run a campaign. Try it first with a demo call in your browser." },
];

const FEATURES = [
  { tag: "Campaigns", title: "Campaigns from a spreadsheet", body: "Upload a CSV and the right columns are detected for you. Set the delay between calls and run up to three rounds for people who didn't pick up." },
  { tag: "Outcomes", title: "Every outcome, sorted", body: "Each call is marked Answered, Voicemail, No answer or Failed, and anything unusual is flagged for review. Send results to Google Sheets, Docs or Gmail." },
  { tag: "History", title: "Recordings, transcripts and summaries", body: "Open any call to hear it, read what was said, or skim the summary. Texts, WhatsApp messages and emails sit in the same history." },
  { tag: "Front", title: "One inbox for every channel", body: "Front shows a contact's calls, texts, WhatsApp chats and emails together, and you can reply from there." },
  { tag: "Handoff", title: "Hands off to a person", body: "Add a list of numbers to forward calls to. If the first one is busy, the agent tries the next." },
  { tag: "Integrations", title: "Fits into your stack", body: "Webhooks fire when a call starts, ends or is billed. Custom tools let the agent call your own APIs mid-conversation." },
];

// Small pictures of each feature, in FEATURES order (decorative; the text below says it all).
// One outline per card that slides between rows (shared layoutId), and the row it lands on zooms in a little.
const FeatureCardId = createContext(0);
const SLIDE = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const;
function FeatureRow({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  const card = useContext(FeatureCardId);
  return (
    <motion.div animate={{ scale: strong ? 1.03 : 1 }} transition={SLIDE} className="relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]">
      {strong && <motion.span layoutId={`feature-sel-${card}`} transition={SLIDE} aria-hidden className="absolute inset-0 rounded-lg border border-foreground bg-card shadow-md" />}
      <span className="relative flex flex-1 items-center gap-2.5">{children}</span>
    </motion.div>
  );
}
// The one highlighted row in each list (kept still so the page stays calm).
const FEATURE_ROW = [0, 2, 0, 2, 1, 1];

function FeatureVisual({ i }: { i: number }) {
  return <FeatureCardId.Provider value={i}>{FEATURE_VISUALS[i](FEATURE_ROW[i])}</FeatureCardId.Provider>;
}

// Campaigns card: the AI cursor ticks each detected column, then selects two messy cells and retypes them.
// Phase → [cursor x%, y%] inside the picture; columns: Name, Phone, City; "name"/"city" are Priya's two messy cells.
const CLEAN_PHASES = [700, 600, 600, 700, 700, 1100, 700, 1000, 2200];
const CLEAN_CURSOR: [number, number][] = [[50, 92], [20, 25], [54, 25], [88, 25], [20, 44], [20, 44], [88, 44], [88, 44], [57, 85]]; // measured cell centres

function CampaignCleaner() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const still = reducedMotion();
  const p = usePhases(CLEAN_PHASES, on); // reduced motion: usePhases holds the finished frame
  const ticked = (col: number) => p >= col + 1;
  const editing = p === 4 || p === 5 ? "name" : p === 6 || p === 7 ? "city" : null;
  const cell = (key: "name" | "city", before: string, after: string, typeAt: number) => (
    <span className={`block truncate rounded-md px-2 py-1 transition-shadow duration-200 ${editing === key ? "bg-card shadow-[0_0_0_1.5px_hsl(var(--foreground))]" : ""}`}>
      {p >= typeAt ? <span key={key} className={still ? "" : "landing-type inline-block"} style={{ animationDuration: "0.7s" }}>{after}</span>
        : <span className="text-muted-foreground">{before}</span>}
    </span>
  );
  const [cx, cy] = CLEAN_CURSOR[p];
  return (
    <div ref={ref} className="relative h-full space-y-3 text-[13px]">
      <p className="flex items-center gap-2 font-medium"><FileText className="size-4" /> leads.csv <span className="text-muted-foreground">· 240 rows</span></p>
      <div className="grid grid-cols-3 gap-1.5">
        {["Name", "Phone", "City"].map((c, i) => (
          <span key={c} className={`flex items-center justify-between rounded-md px-2 py-1.5 transition-colors duration-200 ${ticked(i) ? "bg-secondary" : "bg-secondary/40 text-muted-foreground"}`}>
            {c}{ticked(i) && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SLIDE} className="flex"><Check className="size-3.5" /></motion.span>}
          </span>
        ))}
        {cell("name", "priya s.", "Priya S.", 5)}
        <span className="block truncate px-2 py-1 text-muted-foreground">+1 415…</span>
        {cell("city", "austin", "Austin", 7)}
        <span className="block truncate px-2 py-1 text-muted-foreground">Ravi K.</span>
        <span className="block truncate px-2 py-1 text-muted-foreground">+1 512…</span>
        <span className="block truncate px-2 py-1 text-muted-foreground">Dallas</span>
      </div>
      <p className="flex items-center justify-between rounded-lg border border-border px-2.5 py-2">
        <span>{p >= 8 ? "2 cells fixed · ready to call" : "Checking columns…"}</span>
        <span className="text-muted-foreground">Round 1 of 3</span>
      </p>
      {!still && (
        <MousePointer2 aria-hidden className="pointer-events-none absolute !mt-0 size-4 fill-foreground text-background drop-shadow transition-all duration-500 ease-out"
          style={{ left: `${cx}%`, top: `${cy}%` }} />
      )}
    </div>
  );
}

// Front card: Priya's call, text, WhatsApp and email arrive one by one; the outline follows the newest.
const FRONT_ROWS = [
  { icon: PhoneCall, text: "Call · 1:22", at: "10:02" },
  { icon: MessageSquare, text: "SMS: Your viewing is Thu 4:30", at: "10:04" },
  { icon: MessageCircleMore, text: "WhatsApp: Can I bring a friend?", at: "10:31" },
  { icon: Mail, text: "Email: Directions to Elm St", at: "10:40" },
];
const FRONT_PHASES = [900, 1000, 1000, 1100, 2600]; // one row each, then hold on the full inbox

function FrontInbox() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const p = usePhases(FRONT_PHASES, on);
  const shown = reducedMotion() ? FRONT_ROWS.length : Math.min(p + 1, FRONT_ROWS.length);
  return (
    <div ref={ref} className="space-y-1">
      <p className="px-2.5 pb-1 text-[13px] font-medium">Priya Sharma</p>
      {FRONT_ROWS.slice(0, shown).map(({ icon: Icon, text, at }, i) => (
        <div key={text} className={i === shown - 1 && !reducedMotion() ? "landing-line" : ""}>
          <FeatureRow strong={i === shown - 1}>
            <Icon className="size-4" /> {text}
            <span className={`ml-auto text-xs ${i === shown - 1 ? "" : "text-muted-foreground"}`}>{at}</span>
          </FeatureRow>
        </div>
      ))}
    </div>
  );
}

// History card: press play, the recording runs, and the transcript and summary type out.
// Phases: idle (play pulses) → Maya's line → Priya's line → summary → hold.
const HISTORY_PHASES = [1000, 1900, 1500, 1900, 1800];
const HISTORY_PROGRESS = [0, 16, 28, 40, 40]; // % of the recording played
const HISTORY_TIME = ["0:00", "0:13", "0:23", "0:32", "0:32"];

function HistoryPlayer() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const p = usePhases(HISTORY_PHASES, on);
  const still = reducedMotion(); // reduced motion: the finished state; otherwise wait on the first frame
  const playing = p >= 1 && p <= 3;
  const typed = (phase: number, text: string, ms: number) =>
    p > phase || still ? text : p === phase ? <span key={`${phase}-${on}`} className="landing-type-wrap" style={{ animationDuration: `${ms}ms` }}>{text}</span> : <span className="invisible">{text}</span>;
  return (
    <div ref={ref} className="space-y-3 text-[13px]">
      <div className="flex items-center gap-2.5 rounded-lg bg-secondary px-2.5 py-2">
        <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          {p === 0 && on && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-foreground/30" />}
          <motion.span key={playing ? "pause" : "play"} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={SLIDE} className="relative flex">
            {playing ? <Pause className="size-3" /> : <Play className="ml-0.5 size-3" />}
          </motion.span>
        </span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-background">
          <span className="block h-full rounded-full bg-foreground transition-[width] ease-linear"
            style={{ width: `${still ? 40 : HISTORY_PROGRESS[p]}%`, transitionDuration: p === 0 ? "0ms" : `${HISTORY_PHASES[p]}ms` }} />
        </span>
        <span className="w-[72px] shrink-0 text-right tabular-nums text-muted-foreground">{still ? "0:32" : HISTORY_TIME[p]} / 1:22</span>
      </div>
      <p><span className="mr-1.5 rounded-full bg-foreground px-1.5 py-0.5 text-[10px] text-background">Maya</span>{typed(1, "I have Thursday at 4:30 or Friday at 11.", 1500)}</p>
      <p><span className="mr-1.5 rounded-full border border-border px-1.5 py-0.5 text-[10px]">Priya</span>{typed(2, "Thursday at 4:30 is perfect.", 1100)}</p>
      <p className="rounded-lg border border-border px-2.5 py-2">
        <span className="font-medium">Summary:</span> <span className="text-muted-foreground">{typed(3, "Booked a Thursday 4:30 viewing at Elm St.", 1500)}</span>
      </p>
    </div>
  );
}

const FEATURE_VISUALS: ((sel: number) => React.ReactNode)[] = [
  () => <CampaignCleaner />,
  (sel) => (
    <div className="space-y-1">
      <FeatureRow strong={sel === 0}><Check className="size-4" /> Answered <span className="ml-auto tabular-nums text-muted-foreground">128</span></FeatureRow>
      <FeatureRow strong={sel === 1}><Mic className="size-4" /> Voicemail <span className="ml-auto tabular-nums text-muted-foreground">61</span></FeatureRow>
      <FeatureRow strong={sel === 2}><TriangleAlert className="size-4" /> Failed, needs review <span className="ml-auto tabular-nums">3</span></FeatureRow>
      <FeatureRow strong={sel === 3}><PhoneOff className="size-4" /> No answer <span className="ml-auto tabular-nums text-muted-foreground">28</span></FeatureRow>
      <p className="px-2.5 pt-0.5 text-xs text-muted-foreground">Sent to Google Sheets · 2 min ago</p>
    </div>
  ),
  () => <HistoryPlayer />,
  () => <FrontInbox />,
  (sel) => (
    <div className="space-y-1">
      <p className="px-2.5 pb-1 text-[13px] text-muted-foreground">Caller asked for a person</p>
      <FeatureRow strong={sel === 0}><PhoneOff className="size-4" /> Front desk · +1 415 555 0100 <span className="ml-auto text-xs text-muted-foreground">Busy</span></FeatureRow>
      <FeatureRow strong={sel === 1}><PhoneForwarded className="size-4" /> Sam · +1 415 555 0177 <span className="ml-auto flex items-center gap-1.5 text-xs"><span className="size-1.5 animate-pulse rounded-full bg-success" />Ringing</span></FeatureRow>
      <FeatureRow strong={sel === 2}><User className="size-4" /> Alex · +1 415 555 0189 <span className="ml-auto text-xs text-muted-foreground">Next</span></FeatureRow>
    </div>
  ),
  (sel) => (
    <div className="space-y-1 font-mono text-[12px]">
      <FeatureRow strong={sel === 0}><span className="text-muted-foreground">00:00</span> POST call.started <span className="ml-auto">200</span></FeatureRow>
      <FeatureRow strong={sel === 1}><span className="text-muted-foreground">00:41</span> tool · get_open_slots <Check className="ml-auto size-3.5" /></FeatureRow>
      <FeatureRow strong={sel === 2}><span className="text-muted-foreground">01:22</span> POST call.ended <span className="ml-auto">200</span></FeatureRow>
      <FeatureRow strong={sel === 3}><span className="text-muted-foreground">01:23</span> POST call.billed <span className="ml-auto">200</span></FeatureRow>
    </div>
  ),
];

const PLANS = [
  { name: "Starter", price: "$19", minutes: "190 minutes", note: "For getting started with AI calling." },
  { name: "Pro", price: "$49", minutes: "500 minutes", note: "For power users running regular campaigns.", featured: true },
  { name: "Ultra", price: "$149", minutes: "1,500 minutes", note: "For growing teams." },
  { name: "Enterprise", price: "Custom", minutes: "Custom minutes", note: "Volume pricing and a set rate per minute." },
];


const NAV_LINKS = [["#how", "How it works"], ["#features", "Features"], ["#models", "Models"], ["#pricing", "Pricing"]] as const;

/** Phones and tablets: a ☰ button that opens the page links, Sign in and Get started. */
function MobileNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="lg:hidden">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="mobile-menu" aria-label={open ? "Close menu" : "Open menu"}
        className="flex size-10 items-center justify-center rounded-lg hover:bg-secondary">
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.nav id="mobile-menu" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}
            className="absolute inset-x-0 top-16 border-b border-border bg-background px-4 pb-5 pt-2 shadow-lg sm:px-6">
            <ul>
              {NAV_LINKS.map(([href, label]) => (
                <li key={href}><a href={href} onClick={() => setOpen(false)} className="block py-3.5 text-base">{label}</a></li>
              ))}
            </ul>
            <div className="mt-4 grid gap-3">
              <Link to="/login" className="rounded-xl border border-border px-4 py-3 text-center font-medium">Sign in</Link>
              <Link to="/signup" className="rounded-xl bg-primary px-4 py-3 text-center font-medium text-primary-foreground">Get started</Link>
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Landing() {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="Vibe AI home"><BrandLogo className="h-6" /></Link>
          <nav className="hidden items-center gap-5 text-sm lg:flex">
            {NAV_LINKS.map(([href, label]) => <a key={href} href={href} className="text-muted-foreground hover:text-foreground">{label}</a>)}
            <Link to="/login" className="rounded-lg px-3 py-2 text-muted-foreground hover:text-foreground">Sign in</Link>
            <Link to="/signup" className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90">Get started</Link>
          </nav>
          <MobileNav />
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-24">
          <div>
            <h1 className="text-[2.4rem] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-5xl lg:text-6xl">
              <span className="sr-only">Every call answered. Every meeting booked.</span>
              <HeroTitle />
            </h1>
            <p className="mt-6 max-w-[54ch] text-lg leading-relaxed text-muted-foreground">
              An AI receptionist that answers your calls, books appointments, and follows up by text, WhatsApp and email.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup" className="rounded-xl bg-primary px-6 py-3.5 font-medium text-primary-foreground hover:bg-primary/90">Create your first agent</Link>
              <a href="#how" className="rounded-xl border border-border bg-card px-6 py-3.5 font-medium hover:bg-accent">See how it works</a>
            </div>
          </div>
          <ResultCard />
        </section>

        {/* Channels */}
        <section aria-label="Channels" className="border-y border-border bg-card">
          <ul className="mx-auto grid max-w-6xl divide-y divide-border px-4 sm:grid-cols-2 sm:divide-y-0 sm:px-6 lg:grid-cols-4 lg:divide-x">
            {CHANNELS.map(({ icon: Icon, name, body }) => (
              <li key={name} className="py-8 sm:px-6 sm:first:pl-0 lg:last:pr-0">
                <p className="flex items-center gap-2 font-medium"><Icon className="size-4" aria-hidden />{name}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <Steps />

        {/* Features: one card per feature, each with a small picture of it on top */}
        <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
          <h2 className="max-w-[22ch] text-4xl font-semibold tracking-[-0.02em]">Everything after the call is handled too</h2>
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <article key={f.title} className="flex flex-col rounded-2xl bg-secondary p-6">
                <div aria-hidden className="h-[220px] overflow-hidden rounded-xl border border-border bg-card p-4"><FeatureVisual i={i} /></div>
                <p className="mt-6 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{f.tag}</p>
                <h3 className="mt-2 text-xl font-semibold tracking-[-0.01em]">{f.title}</h3>
                <p className="mt-2 leading-relaxed text-muted-foreground">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Meta models */}
        <Models />

        {/* Ask Vibe */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-2">
          <div>
            <h2 className="text-4xl font-semibold tracking-[-0.02em]">Not sure where a setting lives? Ask Vibe.</h2>
            <p className="mt-4 max-w-[50ch] text-lg leading-relaxed text-muted-foreground">
              Ask Vibe is the assistant built into the dashboard. Tell it what you want and it opens the right page, fills in the details you gave it, and points at the button. It stops before anything that saves, connects, pays or places a call, and never types your API keys for you.
            </p>
          </div>
          <AskVibeFeed />
        </section>

        {/* Integrations */}
        <section aria-label="Integrations" className="border-y border-border bg-card py-12">
          <h2 className="px-4 text-center text-lg font-medium">Works with the tools you already use</h2>
          {/* Logos only, on one line, scrolling right to left forever (two copies, track moves by half). */}
          <div className="landing-marquee mx-auto mt-8 max-w-6xl overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
            <ul className="landing-marquee-track flex w-max items-center gap-16 px-8">
              {[...TOOLS, ...TOOLS].map((t, i) => {
                const copy = i >= TOOLS.length;
                return (
                  <li key={i} aria-hidden={copy || undefined} title={t.name} className={`flex size-12 shrink-0 items-center justify-center ${copy ? "motion-reduce:hidden" : ""}`}>
                    <img src={t.logo} alt={copy ? "" : t.name} className="size-10 object-contain" style={t.zoom ? { transform: `translateY(${t.dy ?? 0}px) scale(${t.zoom})` } : undefined} loading="lazy" />
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
          <h2 className="text-4xl font-semibold tracking-[-0.02em]">Pay for the minutes you use</h2>
          <p className="mt-3 max-w-[56ch] text-lg text-muted-foreground">Every plan includes all four channels, campaigns, call history and integrations.</p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PLANS.map((p) => (
              <div key={p.name} className={`flex flex-col rounded-2xl border p-6 ${p.featured ? "border-foreground bg-foreground text-background" : "border-border bg-card"}`}>
                <p className="flex items-center justify-between font-medium">
                  {p.name}
                  {p.featured && <span className="rounded-full bg-background px-2.5 py-0.5 text-xs text-foreground">Most popular</span>}
                </p>
                <p className="mt-4 text-4xl font-semibold tracking-tight">{p.price}</p>
                <p className={`mt-1 flex items-center gap-1.5 text-sm ${p.featured ? "text-background/80" : "text-muted-foreground"}`}><Check className="size-4" aria-hidden />{p.minutes}</p>
                <p className={`mt-4 flex-1 text-sm ${p.featured ? "text-background/80" : "text-muted-foreground"}`}>{p.note}</p>
                <Link to={p.name === "Enterprise" ? "/signup?plan=enterprise" : "/signup"}
                  className={`mt-6 rounded-xl px-4 py-2.5 text-center text-sm font-medium ${p.featured ? "bg-background text-foreground hover:bg-background/90" : "border border-border hover:bg-accent"}`}>
                  {p.name === "Enterprise" ? "Talk to us" : `Start with ${p.name}`}
                </Link>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-2xl border border-border bg-card p-6 sm:flex sm:items-center sm:justify-between sm:gap-8">
            <div>
              <p className="font-medium">Running an agency?</p>
              <p className="mt-1 text-muted-foreground">Buy minutes at a wholesale rate, set your own plan prices for clients, and manage every client account from one place.</p>
            </div>
            <Link to="/signup?agency=1" className="mt-4 inline-block shrink-0 rounded-xl border border-border px-4 py-2.5 text-sm font-medium hover:bg-accent sm:mt-0">Ask about agency access</Link>
          </div>
        </section>

        {/* Final CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="rounded-3xl bg-foreground px-6 py-14 text-background sm:px-12">
            <h2 className="max-w-[18ch] text-4xl font-semibold tracking-[-0.02em] sm:text-5xl">Hear your agent before your customers do.</h2>
            <p className="mt-4 max-w-[50ch] text-lg text-background/70">Build an agent, then talk to it from your browser with a demo call. No phone number needed to try it.</p>
            <Link to="/signup" className="mt-8 inline-block rounded-xl bg-background px-6 py-3.5 font-medium text-foreground hover:bg-background/90">Create your first agent</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} Vibe AI</p>
          <p className="flex gap-5"><Link to="/login" className="hover:text-foreground">Sign in</Link><Link to="/signup" className="hover:text-foreground">Create account</Link></p>
        </div>
      </footer>
    </div>
  );
}

// Hero visual, still on purpose: the result of one call. The live call is acted out further down the page.
function ResultCard() {
  return (
    <div className="rounded-3xl border border-border bg-card p-6 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.25)] sm:p-7">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground"><PhoneIncoming className="size-4" /> Call with Priya Sharma · 1:22</span>
        <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-success"><Check className="size-3.5" /> Completed</span>
      </div>
      <div className="mt-5 flex items-center gap-4 rounded-2xl bg-foreground p-5 text-background">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-background/10"><CalendarCheck className="size-6" /></span>
        <div>
          <p className="text-sm text-background/70">Booked by Maya, your AI receptionist</p>
          <p className="mt-0.5 text-2xl font-semibold tracking-[-0.01em]">Viewing · Thu, 4:30 PM</p>
          <p className="text-sm text-background/70">Two-bedroom on Elm Street</p>
        </div>
      </div>
      <figure className="mt-5 rounded-2xl bg-secondary p-4">
        <blockquote className="text-[15px] leading-relaxed">“Is the two-bedroom on Elm Street still available? Thursday at 4:30 works for me.”</blockquote>
        <figcaption className="mt-2 text-sm text-muted-foreground">Priya, on the call</figcaption>
      </figure>
      <ul className="mt-5 space-y-2.5 text-sm">
        {["Answered in 1 ring, any time of day", "Added to Google Calendar", "Confirmation text sent to Priya"].map((t) => (
          <li key={t} className="flex items-center gap-2.5"><span className="flex size-5 items-center justify-center rounded-full bg-secondary"><Check className="size-3" /></span>{t}</li>
        ))}
      </ul>
    </div>
  );
}





const STEP_MS = 3200;
const stepMs = (i: number) => (i === 0 ? DESCRIBE_TOTAL_MS : STEP_MS); // step 1 runs every industry first
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Auto-playing stepper: numbered nodes joined by a line that fills toward the next step,
// and the preview below acts the step out. Starts when scrolled into view; click any step to jump.
function Steps() {
  const ref = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (reducedMotion()) return;
    const io = new IntersectionObserver(([e]) => setPlaying(e.isIntersecting), { threshold: 0.35 });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);

  const running = playing;
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => setActive((a) => (a + 1) % STEPS.length), stepMs(active));
    return () => clearTimeout(t);
  }, [active, running]);

  return (
    <section id="how" ref={ref} className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
      <h2 className="max-w-[20ch] text-4xl font-semibold tracking-[-0.02em]">From a sentence to a live agent in four steps</h2>
      <ol className="mt-14 grid gap-10 lg:grid-cols-4 lg:gap-0">
        {STEPS.map((s, i) => {
          const on = i === active;
          const still = reducedMotion(); // reduced motion: no autoplay, so every step reads as done
          const reached = i <= active || still;
          const last = i === STEPS.length - 1;
          return (
            <li key={s.title} className="relative pl-14 lg:pl-0 lg:pr-8">
              {/* Phone / tablet: a vertical line down to the next step, filling top to bottom while this step plays. */}
              {!last && (
                <span aria-hidden className="absolute -bottom-8 left-5 top-12 w-0.5 -translate-x-1/2 overflow-hidden rounded-full bg-border lg:hidden">
                  <span key={on ? `v-on-${active}` : "v-off"}
                    className={`block h-full w-full bg-foreground ${on && running ? "landing-fill-y" : ""}`}
                    style={{ transform: on && running ? undefined : `scaleY(${i < active || still ? 1 : 0})`, transformOrigin: "top", ["--dur" as string]: `${stepMs(i)}ms` }} />
                </span>
              )}
              <button onClick={() => setActive(i)} aria-current={on ? "step" : undefined} className="group block w-full text-left">
                {/* Numbered node + (desktop) the line to the next one; the line fills while this step plays. */}
                <span className="absolute left-0 top-0 flex items-center lg:static">
                  <span
                    className={`relative flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums transition-colors duration-300 ${
                      reached ? "bg-foreground text-background" : "border border-border bg-card text-muted-foreground group-hover:text-foreground"
                    }`}
                  >
                    {on && !still && <span aria-hidden className="absolute -inset-3 rounded-full bg-foreground/[0.07]" />}
                    <span className="relative">{i + 1}</span>
                  </span>
                  {!last && (
                    <span aria-hidden className="mx-3 hidden h-0.5 flex-1 overflow-hidden rounded-full bg-border lg:block">
                      <span key={on ? `on-${active}` : "off"}
                        className={`block h-full bg-foreground ${on && running ? "landing-fill" : ""}`}
                        style={{ transform: on && running ? undefined : `scaleX(${i < active || still ? 1 : 0})`, transformOrigin: "left", ["--dur" as string]: `${stepMs(i)}ms` }} />
                    </span>
                  )}
                </span>
                <span className="mt-2.5 block text-sm text-muted-foreground lg:mt-5">Step {i + 1}</span>
                <span className={`mt-1 block text-lg font-semibold transition-colors ${on ? "text-foreground" : "text-foreground/80 group-hover:text-foreground"}`}>{s.title}</span>
                <span className="mt-2 block leading-relaxed text-muted-foreground">{s.body}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-12 overflow-hidden rounded-3xl border border-border bg-card p-6 sm:p-10" aria-live="polite">
        <div key={active} className="min-h-[220px]">{PREVIEWS[active]()}</div>
      </div>
    </section>
  );
}

const Row = ({ delay, children }: { delay: number; children: React.ReactNode }) => (
  <div className="landing-line" style={{ animationDelay: `${delay}s` }}>{children}</div>
);
// "Connected": a small green dot with a soft pulse (the word is kept for screen readers).
const LiveDot = () => (
  <span className="flex shrink-0" title="Connected">
    <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden />
    <span className="sr-only">Connected</span>
  </span>
);
const Ok = ({ children = "Connected" }: { children?: React.ReactNode }) => (
  <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-sm font-medium text-success"><Check className="size-3.5" />{children}</span>
);

// Step 1 acted out, one industry at a time: pick it, type what the agent should do, write its prompt;
// a finished industry keeps a tick, then the next one starts. The stepper waits for all of them.
const INDUSTRY_DEMOS = [
  { name: "Real Estate", ask: "Books viewings for my listings and answers price questions",
    prompt: ["You are Maya, the viewing scheduler for Northside Homes.", "Confirm which listing they mean, answer from the listing details, then offer two open times."] },
  { name: "Insurance", ask: "Answers policy questions and books renewal calls",
    prompt: ["You are Sam, the policy assistant for Shield Insurance.", "Answer coverage questions from the policy documents, then book a renewal call with an agent."] },
  { name: "E-commerce", ask: "Tracks orders and handles returns",
    prompt: ["You are Ava, the order helper for Lumen Store.", "Look up the order, give the delivery date, and start a return when the customer asks."] },
  { name: "Education", ask: "Answers admission questions and books campus tours",
    prompt: ["You are Leo, the admissions assistant for Riverside College.", "Answer questions about courses and fees, then book a campus tour."] },
  { name: "Healthcare", ask: "Books patient appointments and answers clinic questions",
    prompt: ["You are Mia, the front desk for Cedar Clinic.", "Confirm the patient's details, answer questions about the clinic, and book the first open slot."] },
];
// ms inside one industry's turn
const DESCRIBE_AT = { pick: 250, type: 400, writing: 1450, line1: 1700, line2: 2050, done: 2700 };
const INDUSTRY_MS = 3000;
const DESCRIBE_TOTAL_MS = INDUSTRY_DEMOS.length * INDUSTRY_MS;

function DescribePreview() {
  const still = reducedMotion();
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (still) return;
    const t0 = performance.now();
    const t = setInterval(() => setMs((performance.now() - t0) % DESCRIBE_TOTAL_MS), 50); // loops back to the first industry
    return () => clearInterval(t);
  }, [still]);
  const idx = still ? 0 : Math.floor(ms / INDUSTRY_MS);
  const t = still ? Infinity : ms - idx * INDUSTRY_MS;
  const demo = INDUSTRY_DEMOS[idx];
  const picked = t >= DESCRIBE_AT.pick;
  const typing = t >= DESCRIBE_AT.type && t < DESCRIBE_AT.writing;
  return (
    <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
      <div className="space-y-4">
        <div>
          <p className="text-sm text-muted-foreground">Industry</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {INDUSTRY_DEMOS.map((d, i) => {
              const current = i === idx;
              const finished = i < idx || (current && t >= DESCRIBE_AT.done);
              return (
                <span key={d.name} className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-all duration-300 ${
                  current && picked ? "scale-105 border-foreground bg-foreground text-background"
                    : finished ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground"}`}>
                  {(finished || (current && picked)) && <Check className="size-3.5" />}{d.name}
                </span>
              );
            })}
          </div>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Describe it</p>
          <p className={`mt-2 min-h-[50px] rounded-xl border bg-background px-4 py-3 transition-colors ${typing ? "border-foreground" : "border-border"}`}>
            {t >= DESCRIBE_AT.type
              ? <Typewriter key={idx} text={demo.ask} ms={900} />
              : <span className="text-muted-foreground/60">What should your agent do?</span>}
          </p>
        </div>
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Sparkles className="size-3.5" /> Generated prompt</p>
        <div className="mt-2 min-h-[132px] space-y-2 rounded-xl bg-secondary p-4 text-sm leading-relaxed">
          {t < DESCRIBE_AT.writing ? (
            <p className="text-muted-foreground/70">Pick an industry and describe the agent; Vibe AI writes the prompt.</p>
          ) : t < DESCRIBE_AT.line1 ? (
            <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Writing your prompt…</p>
          ) : (
            <>
              <p><span key={`${idx}a`} className={still ? "" : "landing-type-wrap"} style={{ animationDuration: "0.5s" }}>{demo.prompt[0]}</span></p>
              {t >= DESCRIBE_AT.line2 && (
                <p className="text-muted-foreground"><span key={`${idx}b`} className={still ? "" : "landing-type-wrap"} style={{ animationDuration: "0.6s" }}>{demo.prompt[1]}</span></p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const PREVIEWS: (() => React.ReactNode)[] = [
  () => <DescribePreview />,
  () => (
    <ul className="divide-y divide-border">
      {[
        { icon: FileText, name: "price-sheet-2026.pdf", meta: "24 pages" },
        { icon: FileText, name: "listings-elm-street.docx", meta: "8 listings" },
        { icon: Globe, name: "northsidehomes.com", meta: "31 pages read" },
      ].map((f, i) => (
        <li key={f.name} className="landing-line flex items-center gap-4 py-4" style={{ animationDelay: `${i * 0.5}s` }}>
          <f.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{f.name}</p>
            <span className="mt-2 block h-1 overflow-hidden rounded-full bg-secondary">
              <span className="landing-grow block h-full rounded-full bg-foreground" style={{ animationDelay: `${i * 0.5 + 0.2}s`, animationDuration: "1.2s" }} />
            </span>
          </div>
          <span className="hidden text-sm text-muted-foreground sm:inline">{f.meta}</span>
          <span className="landing-line" style={{ animationDelay: `${i * 0.5 + 1.4}s` }}><Ok>Learned</Ok></span>
        </li>
      ))}
    </ul>
  ),
  () => (
    <div className="grid gap-4 md:grid-cols-2">
      {[
        { icon: PhoneCall, title: "+1 (415) 555-0142", sub: "Twilio number, answers with Viewing Scheduler" },
        { icon: CalendarCheck, title: "Google Calendar", sub: "Bookable Mon to Fri, 9 AM to 6 PM, 30-minute viewings" },
      ].map((c, i) => (
        <Row key={c.title} delay={i * 0.6}>
          <div className="flex h-full items-start gap-4 rounded-2xl border border-border p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary"><c.icon className="size-5" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{c.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{c.sub}</p>
            </div>
            <span className="landing-line mt-1.5" style={{ animationDelay: `${i * 0.6 + 0.8}s` }}><LiveDot /></span>
          </div>
        </Row>
      ))}
      <Row delay={1.8}>
        <p className="text-sm text-muted-foreground md:col-span-2">Busy line? Calls forward to your team, one number after another.</p>
      </Row>
    </div>
  ),
  () => (
    <div>
      <Row delay={0}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Spring open house</p>
            <p className="text-sm text-muted-foreground">Voice campaign, 240 contacts from leads.csv</p>
          </div>
          <span className="flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-sm font-medium text-success">
            <span className="size-2 animate-pulse rounded-full bg-success" />Running
          </span>
        </div>
      </Row>
      <dl className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[["Answered", 128], ["Voicemail", 61], ["No answer", 28], ["Viewings booked", 23]].map(([label, n], i) => (
          <Row key={label} delay={0.2 + i * 0.15}>
            <div className="rounded-2xl bg-secondary p-4">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums"><Count to={n as number} /></dd>
              <span className="mt-3 block h-1 overflow-hidden rounded-full bg-background">
                <span className="landing-grow block h-full rounded-full bg-foreground" style={{ width: `${((n as number) / 240) * 100 * 1.6}%`, animationDelay: `${0.3 + i * 0.15}s` }} />
              </span>
            </div>
          </Row>
        ))}
      </dl>
    </div>
  ),
];

function Count({ to }: { to: number }) {
  const [n, setN] = useState(reducedMotion() ? to : 0);
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1400);
      setN(Math.round(to * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{n}</>;
}

// "Built on Meta models", acted out with the product itself: a live call (both speakers' audio
// bars + the transcript building up) and Ask Vibe being clicked and doing a task. Icons only, no emoji.

/** Steps through `durations` (ms) while `playing`, looping; returns the current step. */
function usePhases(durations: number[], playing: boolean) {
  const [phase, setPhase] = useState(0);
  useEffect(() => { if (playing) setPhase(0); }, [playing]); // start from the top each time it comes into view
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPhase((p) => (p + 1) % durations.length), durations[phase]);
    return () => clearTimeout(t);
  }, [phase, playing, durations]);
  // Not playing yet: hold the first frame (no jump when it starts). Reduced motion: show the finished state.
  return playing ? phase : reducedMotion() ? durations.length - 1 : 0;
}

/** Plays while the element is on screen (never with reduced motion). */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (reducedMotion()) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { threshold: 0.3 });
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

const AudioBars = ({ active }: { active: boolean }) => (
  <span aria-hidden className="flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
    {Array.from({ length: 28 }, (_, i) => (
      <span key={i} className={`w-[3px] rounded-full bg-foreground transition-opacity ${active ? "landing-wave opacity-100" : "opacity-25"}`}
        style={{ height: active ? `${30 + ((i * 37) % 70)}%` : "18%", animationDelay: `${(i % 7) * 0.09}s` }} />
    ))}
  </span>
);


const CALL_LINES = [
  { who: "Caller", text: "Hi! Can I see the Elm Street flat on Thursday?" },
  { who: "Agent", text: "Yes, Thursday at 4:30 is free. Shall I book it for you?" },
  { who: "Caller", text: "Perfect, please book it." },
  { who: "Agent", text: "Done. You'll get a text with the address and time." },
] as const;
// Phase: 0 ringing, then per line: speaking (odd) and, before each agent line, thinking.
const CALL_PHASES = [1200, 2400, 1300, 2600, 1800, 1300, 2600, 2600];
// phase -> what is happening
const CALL_STATE: { speaking?: "Caller" | "Agent"; thinking?: boolean; lines: number; booked?: boolean }[] = [
  { lines: 0 },
  { speaking: "Caller", lines: 1 },
  { thinking: true, lines: 1 },
  { speaking: "Agent", lines: 2 },
  { speaking: "Caller", lines: 3 },
  { thinking: true, lines: 3, booked: true },
  { speaking: "Agent", lines: 4, booked: true },
  { lines: 4, booked: true },
];

function CallDemo() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const st = CALL_STATE[usePhases(CALL_PHASES, on)];
  const live = st.lines > 0 || !!st.speaking;
  return (
    <div ref={ref} className="grid gap-4 rounded-3xl border border-border bg-card p-5 sm:p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] [&>*]:min-w-0">
      <div className="space-y-4">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 font-medium"><PhoneCall className="size-4" /> {live ? `On call · 0:${String(st.lines * 7 + 3).padStart(2, "0")}` : "Incoming call"}</span>
          <span className="font-mono text-xs text-muted-foreground">+1 415 555 0142</span>
        </div>
        {(["Caller", "Agent"] as const).map((who) => (
          <div key={who} className={`flex items-center gap-3 rounded-2xl border p-3 transition-colors duration-300 ${st.speaking === who ? "border-foreground" : "border-border"}`}>
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${who === "Agent" ? "bg-foreground text-background" : "bg-muted"}`}>
              {who === "Agent" ? <Bot className="size-4" /> : <User className="size-4" />}
            </span>
            <span className="w-20 shrink-0 text-sm">{who === "Agent" ? "Maya (AI)" : "Priya"}</span>
            <AudioBars active={st.speaking === who} />
            {st.speaking === who ? <Mic className="size-4" aria-label="speaking" /> : <MicOff className="size-4 text-muted-foreground" aria-hidden />}
          </div>
        ))}
      </div>

      <div className="flex min-h-[260px] flex-col rounded-2xl bg-muted/50 p-4">
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><FileText className="size-3.5" /> Live transcript</p>
        <div className="mt-3 flex-1 space-y-2.5" aria-live="polite">
          {CALL_LINES.slice(0, st.lines).map((l, i) => (
            <div key={i} className="landing-line flex gap-2.5 text-sm">
              <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${l.who === "Agent" ? "bg-foreground text-background" : "border border-border bg-card"}`}>{l.who}</span>
              <span className="leading-relaxed">{l.text}</span>
            </div>
          ))}
          {st.thinking && (
            <p className="landing-line flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Checking Listings.pdf and your calendar
            </p>
          )}
        </div>
        {st.booked && (
          <p className="landing-line mt-3 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm">
            <CalendarCheck className="size-4" /> Booked: Elm Street viewing, Thu 4:30 PM
          </p>
        )}
      </div>
    </div>
  );
}

/** Types `text` out letter by letter over `ms` (after `delay`), with a blinking caret while typing.
 *  Wraps across lines, unlike the one-line landing-type clip. Reduced motion: the whole text at once. */
function Typewriter({ text, ms, delay = 0 }: { text: string; ms: number; delay?: number }) {
  const [n, setN] = useState(() => (reducedMotion() ? text.length : 0));
  useEffect(() => {
    if (reducedMotion()) return;
    let i = 0;
    let tick: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      tick = setInterval(() => { i += 1; setN(i); if (i >= text.length) clearInterval(tick); }, ms / text.length);
    }, delay);
    return () => { clearTimeout(start); clearInterval(tick); };
  }, [text, ms, delay]);
  if (n === 0 && delay) return <span className="inline-flex gap-0.5 align-middle" aria-hidden>{[0, 1, 2].map((d) => <span key={d} className="size-1 animate-bounce rounded-full bg-current opacity-60" style={{ animationDelay: `${d * 0.12}s` }} />)}</span>;
  return (
    <span>
      {text.slice(0, n)}
      {n < text.length && <span aria-hidden className="ml-px inline-block h-[1em] w-px animate-pulse bg-current align-[-2px]" />}
    </span>
  );
}

// Ask Vibe section: the conversation as cards that rise in from the bottom, newest at the bottom, then it starts over.
const FEED = [
  { you: true, text: "Make an agent that books viewings for my listings" },
  { you: false, text: "Done. I created “Viewing Scheduler” with a prompt for property questions. Want me to connect your calendar next?" },
  { you: true, text: "Yes, connect Google Calendar" },
  { you: false, text: "I opened Calendars and picked Google Calendar. Sign in to Google to finish; I never type passwords for you." },
];
const FEED_MS = 2200;

function AskVibeFeed() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const still = reducedMotion();
  const [count, setCount] = useState(still ? FEED.length : 0);
  useEffect(() => {
    if (!on || still) return;
    setCount(1);
    const t = setInterval(() => setCount((c) => (c >= FEED.length + 1 ? 1 : c + 1)), FEED_MS); // one extra beat on the full chat
    return () => clearInterval(t);
  }, [on, still]);
  const shown = FEED.slice(0, Math.min(count, FEED.length)).map((m, i) => ({ ...m, i })); // oldest first, newest at the bottom
  return (
    <div ref={ref} className="flex h-[380px] flex-col overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm">
      <p className="flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="size-4" /> Ask Vibe</p>
      {/* cards stack from the bottom; older ones are pushed up and out of the box */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden">
        <AnimatePresence initial={false}>
          {shown.map((m) => (
            <motion.div key={m.i} layout
              initial={{ opacity: 0, y: 28, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
              className={`shrink-0 rounded-2xl border p-4 text-[15px] leading-relaxed shadow-sm ${m.you ? "ml-10 border-foreground bg-foreground text-background" : "mr-10 border-border bg-secondary"}`}>
              <p className={`mb-1 flex items-center gap-1.5 text-xs ${m.you ? "text-background/60" : "text-muted-foreground"}`}>
                {m.you ? <User className="size-3.5" /> : <Sparkles className="size-3.5" />}{m.you ? "You" : "Ask Vibe"}
              </p>
              {m.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** SAM 3.1 detection box over one element of the Ask Vibe mock (shown while SAM scans the screen). */
const SamBox = ({ show, score, d }: { show: boolean; score: string; d: number }) =>
  show ? (
    <span aria-hidden className="landing-line pointer-events-none absolute -inset-1 rounded-[10px] border border-dashed border-foreground/40" style={{ animationDelay: `${d}s` }}>
      <span className="absolute -top-2 left-1.5 rounded bg-background px-1 text-[9px] leading-[14px] text-muted-foreground">button · {score}</span>
    </span>
  ) : null;

// Ask Vibe demo: cursor (in % of the mock) per phase, and what the mock shows.
const ASK_PHASES = [1100, 1000, 700, 1700, 1500, 1700, 1400, 1700, 1500, 500, 900, 3200];
// idle → to Ask Vibe → click → (chat) → (reply) → New Agent (SAM) → Name → Prompt → to Create → click → creating → created
const CURSOR = [[46, 40], [90, 88], [90, 88], [90, 88], [90, 88], [92, 12], [45, 25], [55, 43], [26, 62], [25, 63], [25, 63], [62, 74]];
const ASK_TASK = "Set up an agent that books property viewings";

function AskVibeDemo() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const p = usePhases(ASK_PHASES, on);
  const chatOpen = p >= 2 && p <= 5;
  const onForm = p >= 6 && p <= 10;
  const created = p >= 11;
  const [cx, cy] = CURSOR[p];
  return (
    <div ref={ref} className="space-y-4">
      <div aria-hidden className="relative h-[380px] overflow-hidden rounded-3xl border border-border bg-background">
        {/* sidebar */}
        <div className="absolute inset-y-0 left-0 hidden w-36 border-r border-border bg-card p-3 sm:block">
          <p className="text-sm font-semibold">Vibe AI</p>
          {["Dashboard", "Campaigns", "Agents", "History"].map((n, i) => (
            <p key={n} className={`relative mt-2 rounded-md px-2 py-1 text-xs ${n === "Agents" ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
              {n}<SamBox show={p === 5} score={["0.71", "0.68", "0.74", "0.66"][i]} d={i * 0.07} />
            </p>
          ))}
        </div>
        {/* page */}
        <div className="absolute inset-y-0 left-0 right-0 p-5 sm:left-36">
          {!onForm ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-lg font-semibold">Agents</p>
                <span className="relative rounded-lg bg-foreground px-3 py-1.5 text-xs text-background">
                  + New Agent
                  {p === 5 && (
                    <span className="landing-line absolute -inset-1.5 rounded-lg border-2 border-foreground shadow-[0_0_0_4px_hsl(var(--foreground)/0.08)]" style={{ animationDelay: "0.55s" }}>
                      <span className="absolute -bottom-7 right-0 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background">SAM 3.1 found “New Agent”</span>
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-4 space-y-2">
                {created && (
                  <div className="landing-line flex items-center gap-2 rounded-xl border border-foreground bg-card p-3 text-sm shadow-sm">
                    <Bot className="size-4" /> Viewing Booker
                    <span className="ml-auto rounded-full bg-foreground px-2 py-0.5 text-[10px] text-background">New</span>
                    <span className="flex items-center gap-1 text-[11px] text-success"><span className="size-1.5 rounded-full bg-success" />Active</span>
                  </div>
                )}
                {["Front Desk", "Quote Assistant"].map((n, i) => (
                  <div key={n} className="relative flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
                    <Bot className="size-4" /> {n}<SamBox show={p === 5} score={["0.58", "0.55"][i]} d={0.3 + i * 0.07} />
                  </div>
                ))}
              </div>
              {created && (
                <p className="landing-pop absolute bottom-16 left-5 right-5 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs shadow-lg sm:right-auto">
                  <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background"><Check className="size-3" /></span>
                  Agent “Viewing Booker” created
                </p>
              )}
            </>
          ) : (
            <div className="landing-line space-y-3">
              <p className="text-lg font-semibold">Create Agent</p>
              <div>
                <p className="text-[11px] text-muted-foreground">Name</p>
                <p className="mt-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm">
                  <span key={p >= 6 ? "n" : ""} className="landing-type inline-block">Viewing Booker</span>
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Prompt</p>
                <p className="mt-1 h-14 rounded-lg border border-border bg-card px-3 py-1.5 text-xs leading-relaxed text-muted-foreground">
                  {p >= 7 && <span className="landing-line">You book property viewings. Ask for the address, a day and a time…</span>}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-all duration-150 ${
                  p >= 8 ? "bg-foreground text-background ring-4 ring-foreground/15" : "border border-border"} ${p === 9 ? "scale-95" : ""}`}>
                  {p === 10 ? <><Loader2 className="size-3.5 animate-spin" /> Creating…</> : "Create Agent"}
                </span>
                {p === 8 && <span className="landing-line flex items-center gap-1.5 text-xs"><Hand className="size-3.5" /> Your turn: check it and click Create</span>}
              </div>
            </div>
          )}
        </div>

        {/* Ask Vibe chat + launcher, as in the app */}
        {chatOpen && (
          <div className="landing-pop absolute bottom-16 right-4 w-[min(280px,calc(100%-2rem))] rounded-2xl border border-border bg-card p-3 shadow-xl">
            <p className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles className="size-3.5" /> Ask Vibe</p>
            <div className="mt-2 flex justify-end">
              <span className="rounded-xl bg-foreground px-2.5 py-1.5 text-xs text-background">
                {p >= 3 ? <Typewriter text={ASK_TASK} ms={1300} /> : <span className="opacity-50">Ask Vibe…</span>}
              </span>
            </div>
            {p >= 4 && <p className="mt-2 rounded-xl bg-muted px-2.5 py-1.5 text-xs"><Typewriter text="On it. Opening Agents and creating “Viewing Booker”." ms={1100} delay={350} /></p>}
          </div>
        )}
        <span className={`absolute bottom-4 right-4 flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-xs text-background shadow-lg transition-transform duration-150 ${p === 2 ? "scale-90" : ""}`}>
          <Sparkles className="size-3.5" /> Ask Vibe
          <SamBox show={p === 5} score="0.62" d={0.45} />
        </span>

        {/* cursor */}
        <MousePointer2 className="absolute size-5 fill-foreground text-background drop-shadow transition-all duration-700 ease-out"
          style={{ left: `${cx}%`, top: `${cy}%` }} />
      </div>
      <p className="sr-only">Animation: you click Ask Vibe, type a task, and it opens the Agents page, finds the New Agent button and fills in the form. You click Create, and the new agent appears in your Agents list.</p>
    </div>
  );
}

function Models() {
  return (
    <section id="models" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-24 sm:px-6">
      <h2 className="max-w-[22ch] text-4xl font-semibold tracking-[-0.02em]">Built on Meta models</h2>
      <p className="mt-3 max-w-[60ch] text-lg text-muted-foreground">
        Meta models do the listening, thinking and seeing. Watch them work on a real call and in the dashboard.
      </p>
      <div className="mt-12 space-y-14">
        <div>
          <h3 className="flex items-center gap-2 font-medium"><PhoneCall className="size-4" /> On every call</h3>
          <div className="mt-4"><CallDemo /></div>
        </div>
        <div>
          <h3 className="flex items-center gap-2 font-medium"><Sparkles className="size-4" /> In the dashboard, with Ask Vibe</h3>
          <div className="mt-4"><AskVibeDemo /></div>
        </div>
      </div>
      <p className="mt-8 max-w-[70ch] text-sm text-muted-foreground">
        Spoken replies use Deepgram Aura, because Meta doesn't offer a hosted text-to-speech model yet.
      </p>
    </section>
  );
}
