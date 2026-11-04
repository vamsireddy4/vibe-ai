import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bot,
  AudioLines,
  Wrench,
  ChevronDown,
  History,
  Inbox,
  LayoutDashboard,
  Link2,
  Menu,
  MessageCircleMore,
  MessageSquare,
  MonitorSmartphone,
  PanelLeft,
  PhoneCall,
  Timer,
  Users,
  X,
  ChevronsUpDown,
  BookOpen,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ProfileDialog from "@/components/ProfileDialog";
import BrandLogo, { BrandMark } from "@/components/BrandLogo";
import { ADMIN_EMAIL } from "@/lib/constants";
import { useLiveMinuteBalance } from "@/hooks/useLiveMinuteBalance";
import { supabase } from "@/integrations/supabase/client";
import {
  ALL_VIBE_SPACES,
  getVibePath,
  getVibeSpaceFromPath,
  normalizeVibeSpaces,
  type VibeSpace,
  isAppPath,
} from "@/lib/vibe-routes";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

type NavGroupDef = { label: string; icon: NavItem["icon"]; items: NavItem[]; space?: VibeSpace };

const voiceTop: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: getVibePath("voice", "unibox"), label: "Front", icon: Inbox },
  { href: getVibePath("voice", "campaigns"), label: "Campaigns", icon: MessageSquare },
  { href: getVibePath("voice", "agents"), label: "Agents", icon: Bot },
  { href: getVibePath("voice", "voices"), label: "Voices", icon: AudioLines },
  { href: getVibePath("voice", "outbound-call"), label: "Outbound Call", icon: PhoneCall },
  { href: getVibePath("voice", "demo-call"), label: "Demo Call", icon: MonitorSmartphone },
];

const voiceBottom: NavItem[] = [
  { href: getVibePath("voice", "custom-tools"), label: "Tools", icon: Wrench },
  { href: getVibePath("voice", "call-logs"), label: "History", icon: History },
  { href: getVibePath("voice", "knowledge-base"), label: "Knowledge Base", icon: BookOpen },
  { href: getVibePath("voice", "webhooks"), label: "Webhooks", icon: Webhook },
  { href: getVibePath("voice", "crm-integrations"), label: "CRM Integrations", icon: Link2 },
];

// One sidebar for every channel. Dashboard, Campaigns and History switch channel with a dropdown;
// WhatsApp keeps its own pages (gated by the admin's per-user channel switch via `space`).
const navGroups: NavGroupDef[] = [
  { label: "WhatsApp", icon: MessageCircleMore, space: "whatsapp", items: [
    { href: getVibePath("whatsapp", "chats"), label: "Chats", icon: MessageCircleMore },
    { href: getVibePath("whatsapp", "audiences"), label: "Audiences", icon: Users },
  ] },
];


function isPathActive(pathname: string, href: string) {
  // Dashboard and Campaigns are one page each with a channel dropdown, so every channel's version lights them.
  if (href === getVibePath("voice", "campaigns")) return /^\/[^/]+\/campaigns(\/|$)/.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const content = (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[14.5px] font-normal transition-colors",
        collapsed && "justify-center px-0",
        active && "text-accent-foreground",
        !active && "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {active ? (
        <motion.div
          layoutId={collapsed ? "sidebar-active-pill-collapsed" : "sidebar-active-pill"}
          className="absolute inset-0 rounded-lg bg-accent"
          transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
        />
      ) : null}
      <div className="relative z-10 flex items-center gap-3">
        <item.icon className="h-4 w-4 shrink-0" />
        {!collapsed && item.label}
      </div>
    </button>
  );

  if (!collapsed) return content;

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** A collapsible sidebar section (Agent Configuration, Calling, SMS, ...). */
function NavGroup({ group, open, onToggle, collapsed, pathname, onNavigate }: {
  group: NavGroupDef;
  open: boolean;
  onToggle: () => void;
  collapsed: boolean;
  pathname: string;
  onNavigate: (item: NavItem) => void;
}) {
  const active = group.items.some((item) => isPathActive(pathname, item.href));
  const trigger = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={collapsed ? group.label : undefined}
      className={cn(
        "relative flex w-full items-center rounded-lg px-3 py-2.5 text-[14.5px] font-normal transition-colors",
        collapsed ? "justify-center" : "justify-between",
        active ? "bg-accent/30 text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="flex items-center gap-3">
        <group.icon className="h-4 w-4 shrink-0" />
        {!collapsed && group.label}
      </span>
      {!collapsed && <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />}
    </button>
  );
  return (
    <div>
      {collapsed ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>{group.label}</TooltipContent>
        </Tooltip>
      ) : trigger}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn("space-y-1 overflow-hidden", !collapsed && "pl-4")}
          >
            {group.items.map((item) => (
              <SidebarLink key={item.href} item={item} active={isPathActive(pathname, item.href)} collapsed={collapsed} onClick={() => onNavigate(item)} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // A group the user toggled keeps that choice; otherwise it is open while one of its pages is active.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const location = useLocation();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const profileName = profile?.full_name?.trim() || user?.email?.split("@")[0] || "Account";
  const profileInitial = profileName.charAt(0).toUpperCase();
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileStartOn, setProfileStartOn] = useState<"plans" | null>(null);
  // ?account=plans (old Pricing links): open the account window on the minute packages, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("account") !== "plans") return;
    setProfileStartOn("plans");
    setProfileOpen(true);
    params.delete("account");
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const [isAgency, setIsAgency] = useState(false);
  const dashboardPath = isAgency ? "/agency/dashboard" : "/admin/dashboard";
  const paymentsPath = isAgency ? "/agency/payments" : "/admin/payments";

  useEffect(() => {
    if (!user?.email || isAdmin) {
      setIsAgency(false);
      return;
    }
    const checkAgencyStatus = async () => {
      try {
        const { data, error } = await supabase
          .from("agency_access_grants")
          .select("is_active")
          .eq("email", user.email.toLowerCase().trim())
          .maybeSingle();

        if (!error && data?.is_active) {
          setIsAgency(true);
        } else {
          setIsAgency(false);
        }
      } catch (err) {
        console.error("Failed to verify agency status:", err);
        setIsAgency(false);
      }
    };
    void checkAgencyStatus();
  }, [user, isAdmin]);

  const { liveAvailableSeconds } = useLiveMinuteBalance(user?.id, isAdmin, user?.email);
  const space = useMemo<VibeSpace>(() => getVibeSpaceFromPath(location.pathname), [location.pathname]);
  const enabledSpaces = useMemo(
    () =>
      isAdmin
        ? [...ALL_VIBE_SPACES]
        : normalizeVibeSpaces((user as any)?.user_metadata?.magicteams_enabled_spaces),
    [isAdmin, user],
  );
  const visibleGroups = navGroups.filter((g) => !g.space || enabledSpaces.includes(g.space));
  const isWhatsAppChatsRoute = location.pathname === getVibePath("whatsapp", "chats");
  const isUniboxRoute = location.pathname === getVibePath("voice", "unibox");
  const isFullPage = isWhatsAppChatsRoute || isUniboxRoute;

  useEffect(() => {
  }, [location.pathname]);

  useEffect(() => {
    if (isAdmin || !isAppPath(location.pathname)) return;
    if (enabledSpaces.includes(space)) return;

    const fallbackSpace = enabledSpaces[0];
    if (fallbackSpace) {
      navigate(getVibePath(fallbackSpace, "dashboard"), { replace: true });
    }
  }, [enabledSpaces, isAdmin, location.pathname, navigate, space]);


  const handleNavSwitch = (item: NavItem) => {
    if (isPathActive(location.pathname, item.href)) {
      setSidebarOpen(false);
      return;
    }

    setSidebarOpen(false);
    navigate(item.href);
  };

  const minuteLabel = isAdmin
    ? "Unlimited"
    : liveAvailableSeconds == null
      ? null
      : liveAvailableSeconds >= 60
        ? `${Math.floor(liveAvailableSeconds / 60)} min`
        : `${liveAvailableSeconds}s`;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "console fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-card transition-all duration-200 lg:static lg:translate-x-0",
          collapsed ? "w-16" : "w-64",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {collapsed ? (
          <div className="flex h-16 items-center justify-center px-2">
            {/* Collapsed: the V mark; on hover/focus it turns into the "open sidebar" icon. */}
            <button
              onClick={() => setCollapsed(false)}
              aria-label="Expand sidebar"
              title="Open sidebar"
              className="group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-muted"
            >
              <BrandMark className="h-[18px] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
              <PanelLeft className="absolute h-5 w-5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
            </button>
          </div>
        ) : (
          <div className="flex h-auto flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              {/* Brand Logo & Name */}
              <div className="flex items-center gap-2">
                <BrandMark className="h-[22px]" />
              </div>

              {/* Collapse Button */}
              <div className="flex shrink-0 items-center justify-center">
                <button
                  onClick={() => {
                    setCollapsed(true);
                  }}
                  aria-label="Collapse sidebar"
                  className={cn(
                    "hidden items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex",
                  )}
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
                <button onClick={() => setSidebarOpen(false)} className="lg:hidden" aria-label="Close sidebar">
                  <X className="h-5 w-5 text-muted-foreground" />
                </button>
              </div>
            </div>

          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-2">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={collapsed ? "collapsed" : "expanded"}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-1 pt-2"
            >
              {voiceTop.map((item) => (
                <SidebarLink key={item.href} item={item} active={isPathActive(location.pathname, item.href)} collapsed={collapsed} onClick={() => handleNavSwitch(item)} />
              ))}
              {visibleGroups.map((group) => {
                const open = groupOpen[group.label] ?? group.items.some((item) => isPathActive(location.pathname, item.href));
                return (
                  <NavGroup
                    key={group.label}
                    group={group}
                    open={open}
                    onToggle={() => setGroupOpen((g) => ({ ...g, [group.label]: !open }))}
                    collapsed={collapsed}
                    pathname={location.pathname}
                    onNavigate={handleNavSwitch}
                  />
                );
              })}
              {voiceBottom.map((item) => (
                <SidebarLink key={item.href} item={item} active={isPathActive(location.pathname, item.href)} collapsed={collapsed} onClick={() => handleNavSwitch(item)} />
              ))}
            </motion.div>
          </AnimatePresence>
        </nav>

        <div className="space-y-2 border-t border-border p-2">
          {minuteLabel ? (
            collapsed ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <div className="flex w-full items-center justify-center rounded-lg py-2.5 text-sm text-muted-foreground">
                    <Timer className="h-4 w-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>{minuteLabel} left</TooltipContent>
              </Tooltip>
            ) : (
              <div className="rounded-lg border border-border/80 bg-background px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Timer className="h-4 w-4" />
                  <span>Minutes left</span>
                </div>
                <div className="mt-1 text-lg font-semibold text-foreground">{minuteLabel}</div>
              </div>
            )
          ) : null}

          {/* Profile: opens the account window (profile, voice model, usage, admin, sign out). */}
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            aria-label="Open account settings"
            className={cn(
              "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-muted",
              collapsed && "justify-center",
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-medium text-background" aria-hidden>
              {profileInitial}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{profileName}</span>
                  <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
                </span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </>
            )}
          </button>
          <ProfileDialog
            open={profileOpen}
            onOpenChange={(o) => { setProfileOpen(o); if (!o) setProfileStartOn(null); }}
            startOn={profileStartOn}
            minuteLabel={minuteLabel || null}
            adminLinks={isAdmin || isAgency ? { dashboard: dashboardPath, payments: paymentsPath, label: isAgency ? "Agency" : "Admin" } : null}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center gap-4 border-b border-border bg-card px-6 lg:hidden">
          <button onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <BrandLogo className="h-5" />
          </div>
        </header>
        <div
          className={cn(
            "relative flex-1",
            isFullPage ? "overflow-hidden p-0" : "overflow-auto p-4 sm:p-6 lg:p-8",
          )}
        >
          {/* New page shows at once and settles in with a short rise: no fade, no exit wait. */}
            <motion.div
              key={location.pathname}
              initial={{ y: 14 }}
              animate={{ y: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className={cn(isFullPage ? "h-full" : "min-h-full")}
            >
              {!isAdmin && !enabledSpaces.includes(space) && enabledSpaces.length === 0 ? (
                <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 shadow-sm">
                  <h2 className="text-2xl font-semibold">No Spaces Enabled</h2>
                  <p className="mt-2 text-muted-foreground">
                    Your admin has disabled all spaces for this account. Contact the admin to restore access.
                  </p>
                </div>
              ) : (
                children
              )}
            </motion.div>
        </div>
      </main>
    </div>
  );
}
