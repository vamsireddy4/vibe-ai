import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AccountSettings, { TIMEZONES } from "@/components/settings/AccountSettings";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_META_MODEL, META_MODELS } from "@/lib/provider-config";
import PhoneIntegration from "@/components/settings/PhoneIntegration";
import PricingPlans from "@/components/settings/PricingPlans";
import WhatsAppApi from "@/pages/WhatsAppApi";
import WhatsAppExternalIntegrations from "@/pages/WhatsAppExternalIntegrations";
import { SupportContent } from "@/pages/Support";
import CalendarIntegrations from "@/pages/CalendarIntegrations";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getVibePath } from "@/lib/vibe-routes";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  minuteLabel: string | null;
  adminLinks: { dashboard: string; payments: string; label: string } | null;
  /** "plans": open on Usage with the minute packages showing (old Pricing page links land here). */
  startOn?: "plans" | null;
};

type Section = "profile" | "usage" | "phone" | "calendars" | "integrations" | "support" | "admin";

/** One settings row: title + hint on the left, controls on the right. Module level so inputs keep focus. */
const Row = ({ title, hint, children }: { title: string; hint: React.ReactNode; children?: React.ReactNode }) => (
  <div className="flex flex-col gap-3 border-t py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
    <div className="min-w-0">
      <h3 className="text-base text-foreground">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{hint}</p>
    </div>
    {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
  </div>
);

/** Account window opened from the sidebar profile button: two panels, sections on the left. */
export default function ProfileDialog({ open, onOpenChange, minuteLabel, adminLinks, startOn }: Props) {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [section, setSection] = useState<Section>("profile");
  const [showPlans, setShowPlans] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<{ calls: number; agents: number; numbers: number } | null>(null);

  useEffect(() => {
    if (open && startOn === "plans") { setSection("usage"); setShowPlans(true); }
  }, [open, startOn]);

  const displayName = profile?.full_name?.trim() || user?.email?.split("@")[0] || "Account";

  useEffect(() => {
    if (!open || !user) return;
    setName(profile?.full_name ?? "");
    setCompany((profile as any)?.company_name ?? "");
    // Counts only (head: true), scoped to this user by RLS.
    const count = (table: "call_logs" | "agents" | "phone_configs") =>
      supabase.from(table).select("id", { count: "exact", head: true }).then(({ count: c }) => c ?? 0);
    Promise.all([count("call_logs"), count("agents"), count("phone_configs")]).then(([calls, agents, numbers]) =>
      setStats({ calls, agents, numbers }),
    );
  }, [open, user, profile?.full_name]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  const saveName = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ full_name: name.trim() } as never).eq("user_id", user.id);
    setSaving(false);
    if (error) return toast({ title: "Could not save name", description: error.message, variant: "destructive" });
    await refreshProfile();
    toast({ title: "Name saved" });
  };

  /** Save one profile field right away (company, timezone, voice model). */
  const saveField = async (field: "company_name" | "timezone" | "voice_llm_model", value: string, label: string) => {
    if (!user) return;
    const { error } = await supabase.from("profiles").update({ [field]: value } as never).eq("user_id", user.id);
    if (error) return toast({ title: `Could not save ${label}`, description: error.message, variant: "destructive" });
    await refreshProfile();
    toast({ title: `${label[0].toUpperCase()}${label.slice(1)} saved` });
  };
  const savedModel = (profile as any)?.voice_llm_model;
  const voiceModel = META_MODELS.some((m) => m.value === savedModel) ? savedModel : DEFAULT_META_MODEL;

  const copyId = async () => {
    if (!user) return;
    await navigator.clipboard.writeText(user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const sections: { key: Section; label: string }[] = [
    { key: "profile", label: "Profile" },
    { key: "usage", label: "Usage" },
    { key: "phone", label: "Phone numbers" },
    { key: "calendars", label: "Calendars" },
    { key: "integrations", label: "Integrations" },
    { key: "support", label: "Support" },
    ...(adminLinks ? [{ key: "admin" as const, label: adminLinks.label }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-5xl gap-0 overflow-hidden rounded-2xl p-0 sm:rounded-2xl [&>button:last-child]:hidden">
        <DialogDescription className="sr-only">Your account, voice model, usage and sign out.</DialogDescription>

        {/* Left: sections */}
        <nav aria-label="Account sections" className="flex w-44 shrink-0 flex-col border-r bg-muted/40 p-3 sm:w-56">
          <DialogClose
            aria-label="Close"
            className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-background text-foreground transition-colors hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </DialogClose>
          <ul className="space-y-1">
            {sections.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setSection(s.key)}
                  aria-current={section === s.key ? "page" : undefined}
                  className={cn(
                    "relative w-full rounded-lg px-3 py-2 text-left text-[15px] transition-colors duration-200",
                    section === s.key ? "text-background" : "text-foreground hover:bg-muted",
                  )}
                >
                  {/* The black pill slides to the clicked section. */}
                  {section === s.key && (
                    <motion.span
                      layoutId="account-section-pill"
                      className="absolute inset-0 rounded-lg bg-foreground"
                      transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.8 }}
                    />
                  )}
                  <span className="relative">{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => { onOpenChange(false); void signOut(); }}
            className="mt-auto rounded-lg px-3 py-2 text-left text-[15px] text-destructive hover:bg-destructive/10"
          >
            Sign out
          </button>
        </nav>

        {/* Right: content */}
        <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={section}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="min-w-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10"
        >
          {section === "profile" && (
            <>
              <div className="flex items-center gap-5 pb-6">
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-foreground text-2xl font-medium text-background" aria-hidden>
                  {displayName.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate text-2xl font-medium tracking-tight">{displayName}</DialogTitle>
                  {user?.email && <p className="mt-1 truncate text-sm text-success">Signed in as {user.email}</p>}
                </div>
              </div>

              <Row title="Account ID" hint="Your account's ID. Quote it if you ever need help with your account.">
                <code className="max-w-[12rem] truncate rounded-lg bg-muted px-3 py-2 font-mono text-sm">{user?.id}</code>
                <Button variant="outline" onClick={copyId} aria-label="Copy account ID">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
                </Button>
              </Row>

              <Row title="Display name" hint="Shown in the sidebar and on your account.">
                <label htmlFor="profile-name" className="sr-only">Display name</label>
                <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} className="w-48" maxLength={80} />
                <Button onClick={saveName} disabled={saving || !name.trim() || name.trim() === (profile?.full_name ?? "")}>
                  {saving ? "Saving…" : "Save name"}
                </Button>
              </Row>

              <Row title="Company name" hint="Your business name.">
                <label htmlFor="profile-company" className="sr-only">Company name</label>
                <Input id="profile-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Your company" className="w-48" maxLength={120} />
                <Button onClick={() => saveField("company_name", company.trim(), "company name")} disabled={company.trim() === ((profile as any)?.company_name ?? "")}>
                  Save
                </Button>
              </Row>

              <Row title="Timezone" hint="Booking times and business hours follow this timezone.">
                <Select value={(profile as any)?.timezone || "UTC"} onValueChange={(v) => saveField("timezone", v, "timezone")}>
                  <SelectTrigger className="w-64" aria-label="Timezone"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Row>

              <Row title="Voice model" hint="The Meta model your agents talk with on calls. Voices come from Deepgram.">
                <Select value={voiceModel} onValueChange={(v) => saveField("voice_llm_model", v, "voice model")}>
                  <SelectTrigger className="w-64" aria-label="Voice model"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {META_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.value === DEFAULT_META_MODEL ? `${m.value} (default)` : m.value}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>

              <Row
                title="Activity"
                hint={stats ? `${stats.agents} agents, ${stats.numbers} phone numbers and ${stats.calls} calls` : "Loading…"}
              >
                <Button variant="outline" onClick={() => go(getVibePath("voice", "call-logs"))}>See calls</Button>
              </Row>

              <AccountSettings embedded hideProfile />
            </>
          )}

          {section === "usage" && (
            <>
              <DialogTitle className="pb-6 text-2xl font-medium tracking-tight">Usage</DialogTitle>
              <Row title="Minutes left" hint="Calling minutes on your account.">
                <span className="text-lg font-medium">{minuteLabel ?? "—"}</span>
              </Row>
              <Row title="Buy minutes" hint="Top up calling minutes. Minutes never expire.">
                <Button variant={showPlans ? "secondary" : "outline"} onClick={() => setShowPlans((v) => !v)} aria-expanded={showPlans}>
                  {showPlans ? "Hide plans" : "See plans"}
                </Button>
              </Row>
              {showPlans && (
                <div className="border-t pt-6">
                  <PricingPlans embedded />
                </div>
              )}
            </>
          )}

          {section === "phone" && (
            <>
              <DialogTitle className="pb-6 text-2xl font-medium tracking-tight">Phone numbers</DialogTitle>
              <PhoneIntegration embedded />
            </>
          )}

          {section === "calendars" && (
            <>
              <DialogTitle className="pb-2 text-2xl font-medium tracking-tight">Calendars</DialogTitle>
              <p className="pb-6 text-sm text-muted-foreground">Connect your calendars so agents can check availability and book appointments during calls.</p>
              <CalendarIntegrations embedded />
            </>
          )}

          {section === "integrations" && (
            <>
              <DialogTitle className="pb-2 text-2xl font-medium tracking-tight">Integrations</DialogTitle>
              <p className="pb-6 text-sm text-muted-foreground">Connect WhatsApp so your agents can send and answer messages.</p>
              <h3 className="border-t pb-4 pt-6 text-lg font-medium">WhatsApp API</h3>
              <WhatsAppApi embedded />
              <h3 className="mt-10 border-t pb-4 pt-6 text-lg font-medium">WhatsApp auto-replies</h3>
              <WhatsAppExternalIntegrations embedded />
            </>
          )}

          {section === "support" && (
            <>
              <DialogTitle className="pb-6 text-2xl font-medium tracking-tight">Support</DialogTitle>
              <SupportContent />
            </>
          )}

          {section === "admin" && adminLinks && (
            <>
              <DialogTitle className="pb-6 text-2xl font-medium tracking-tight">{adminLinks.label}</DialogTitle>
              <Row title="Dashboard" hint="Users, agencies and platform settings.">
                <Button variant="outline" onClick={() => go(adminLinks.dashboard)}>Open dashboard</Button>
              </Row>
              <Row title="Payments" hint="Payments and payouts.">
                <Button variant="outline" onClick={() => go(adminLinks.payments)}>Open payments</Button>
              </Row>
            </>
          )}
        </motion.div>
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
