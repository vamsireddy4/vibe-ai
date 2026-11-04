import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { lazy as reactLazy, Suspense, type ComponentType } from "react";

/**
 * lazy() that survives deploys: an open tab asks for page files by their old names, which a new deploy
 * removes ("Failed to fetch dynamically imported module"). Reload once to pick up the new files;
 * if it still fails right after that reload, show the error instead of looping.
 */
const RELOAD_KEY = "vibe-chunk-reload-at";
function lazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return reactLazy(() =>
    load().catch((error: unknown) => {
      let last = 0;
      try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch { /* storage blocked */ }
      if (Date.now() - last > 30_000) {
        try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* storage blocked */ }
        window.location.reload();
        return new Promise<{ default: T }>(() => {}); // keep the spinner up while the page reloads
      }
      throw error;
    }),
  );
}

/** Old /magicteams/<space>/<page> links (bookmarks, OAuth callbacks) -> /<space>/<page>, keeping ?query and #hash. */
function LegacyVibeRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${pathname.replace(/^\/magicteams/, "") || "/dashboard"}${search}${hash}`} replace />;
}
import AskVibe from "@/components/AskVibe";
import { AuthProvider } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/ProtectedRoute";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getVibePath } from "@/lib/vibe-routes";
import Auth from "./pages/Auth";
import Landing from "./pages/Landing";
const Agents = lazy(() => import("./pages/Agents"));
const AgentForm = lazy(() => import("./pages/AgentForm"));
const Voices = lazy(() => import("./pages/Voices"));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase"));
const PhoneConfig = lazy(() => import("./pages/PhoneConfig"));
const CallLogs = lazy(() => import("./pages/CallLogs"));
const AllDashboard = lazy(() => import("./pages/AllDashboard"));
const OutboundCall = lazy(() => import("./pages/OutboundCall"));
const DemoCall = lazy(() => import("./pages/DemoCall"));
const Campaigns = lazy(() => import("./pages/Campaigns"));
const Webhooks = lazy(() => import("./pages/Webhooks"));
const CustomTools = lazy(() => import("./pages/CustomTools"));
const Unibox = lazy(() => import("./pages/Unibox"));
const CalendarIntegrations = lazy(() => import("./pages/CalendarIntegrations"));
const CrmIntegrations = lazy(() => import("./pages/CrmIntegrations"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const AgencyPayments = lazy(() => import("./pages/AgencyPayments"));
const Support = lazy(() => import("./pages/Support"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const NotFound = lazy(() => import("./pages/NotFound"));
const WhatsAppChats = lazy(() => import("./pages/WhatsAppChats"));
const WhatsAppAudiences = lazy(() => import("./pages/WhatsAppAudiences"));
const WhatsAppCampaigns = lazy(() => import("./pages/WhatsAppCampaigns"));
const WhatsAppCampaignDetails = lazy(() => import("./pages/WhatsAppCampaignDetails"));
const WhatsAppApi = lazy(() => import("./pages/WhatsAppApi"));
const WhatsAppExternalIntegrations = lazy(() => import("./pages/WhatsAppExternalIntegrations"));
const WhatsAppWeeklyReports = lazy(() => import("./pages/WhatsAppWeeklyReports"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
    },
  },
});

const voiceDashboardPath = "/dashboard"; // All channels: the default landing page
const whatsappDashboardPath = getVibePath("whatsapp", "dashboard");
const gmailDashboardPath = getVibePath("gmail", "dashboard");

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>
            {/* Each page downloads when first opened (keeps the first load small); this shows meanwhile. */}
            <Suspense fallback={<div className="flex h-screen items-center justify-center" role="status" aria-label="Loading page"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" /></div>}>
            <Routes>
              <Route path="/index.html" element={<Navigate to={voiceDashboardPath} replace />} />
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<Navigate to="/login" replace />} />
              {/* "/*": Clerk's own sub-steps (sso-callback, factor-one, continue) live under these paths. */}
              <Route path="/login/*" element={<Auth />} />
              <Route path="/signup/*" element={<Auth />} />
              <Route
                path="/onboarding"
                element={
                  <ProtectedRoute allowIncompleteOnboarding>
                    <Onboarding />
                  </ProtectedRoute>
                }
              />

              <Route path="/dashboard" element={<ProtectedRoute><AllDashboard /></ProtectedRoute>} />
              <Route path="/voice/dashboard" element={<Navigate to="/dashboard" replace />} />
              <Route path="/voice/unibox" element={<ProtectedRoute><Unibox /></ProtectedRoute>} />
              <Route path="/voice/campaigns" element={<ProtectedRoute><Campaigns /></ProtectedRoute>} />
              <Route path="/voice/agents" element={<ProtectedRoute><Agents /></ProtectedRoute>} />
              <Route path="/voice/voices" element={<ProtectedRoute><Voices /></ProtectedRoute>} />
              <Route path="/voice/agents/new" element={<ProtectedRoute><AgentForm /></ProtectedRoute>} />
              <Route path="/voice/agents/:id" element={<ProtectedRoute><AgentForm /></ProtectedRoute>} />
              <Route path="/voice/knowledge-base" element={<ProtectedRoute><KnowledgeBase /></ProtectedRoute>} />
              <Route path="/voice/phone-config" element={<ProtectedRoute><PhoneConfig /></ProtectedRoute>} />
              <Route path="/voice/call-logs" element={<ProtectedRoute><CallLogs /></ProtectedRoute>} />
              <Route path="/voice/outbound-call" element={<ProtectedRoute><OutboundCall /></ProtectedRoute>} />
              <Route path="/voice/demo-call" element={<ProtectedRoute><DemoCall /></ProtectedRoute>} />
              <Route path="/voice/webhooks" element={<ProtectedRoute><Webhooks /></ProtectedRoute>} />
              <Route path="/voice/custom-tools" element={<ProtectedRoute><CustomTools /></ProtectedRoute>} />
              <Route path="/voice/calendar-integrations" element={<ProtectedRoute><CalendarIntegrations /></ProtectedRoute>} />
              <Route path="/voice/crm-integrations" element={<ProtectedRoute><CrmIntegrations /></ProtectedRoute>} />
              <Route path="/voice/pricing" element={<Navigate to={`${getVibePath("voice", "dashboard")}?account=plans`} replace />} />
              <Route path="/voice/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
              <Route path="/voice/settings" element={<Navigate to="/dashboard" replace />} />

              <Route path="/sms/dashboard" element={<Navigate to="/dashboard" replace />} />
              <Route path="/sms/campaigns" element={<ProtectedRoute><Campaigns /></ProtectedRoute>} />
              <Route path="/sms/history" element={<Navigate to={`${getVibePath("voice", "call-logs")}?type=sms`} replace />} />
              <Route path="/sms/phone-config" element={<ProtectedRoute><PhoneConfig /></ProtectedRoute>} />
              <Route path="/sms/crm-integrations" element={<ProtectedRoute><CrmIntegrations /></ProtectedRoute>} />
              <Route path="/sms/pricing" element={<Navigate to={`${getVibePath("sms", "dashboard")}?account=plans`} replace />} />
              <Route path="/sms/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
              <Route path="/sms/settings" element={<Navigate to="/dashboard" replace />} />

              <Route path="/whatsapp/dashboard" element={<Navigate to="/dashboard" replace />} />
              <Route path="/whatsapp/contacts" element={<Navigate to={getVibePath("whatsapp", "audiences")} replace />} /> {/* Contacts page removed: contacts come from Audiences > Import CSV and incoming chats */}
              <Route path="/whatsapp/chats" element={<ProtectedRoute><WhatsAppChats /></ProtectedRoute>} />
              <Route path="/whatsapp/audiences" element={<ProtectedRoute><WhatsAppAudiences /></ProtectedRoute>} />
              <Route path="/whatsapp/campaigns" element={<ProtectedRoute><WhatsAppCampaigns /></ProtectedRoute>} />
              <Route path="/whatsapp/campaigns/:id" element={<ProtectedRoute><WhatsAppCampaignDetails /></ProtectedRoute>} />
              <Route path="/whatsapp/templates" element={<ProtectedRoute><WhatsAppCampaigns /></ProtectedRoute>} />
              <Route path="/whatsapp/whatsapp-api" element={<ProtectedRoute><WhatsAppApi /></ProtectedRoute>} />
              <Route path="/whatsapp/pricing" element={<Navigate to={`${getVibePath("whatsapp", "dashboard")}?account=plans`} replace />} />
              <Route path="/whatsapp/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
              <Route path="/whatsapp/settings" element={<Navigate to="/dashboard" replace />} />
              <Route path="/whatsapp/weekly-reports" element={<ProtectedRoute><WhatsAppWeeklyReports /></ProtectedRoute>} />
              <Route path="/whatsapp/external-integrations" element={<ProtectedRoute><WhatsAppExternalIntegrations /></ProtectedRoute>} />


              <Route path="/gmail/dashboard" element={<Navigate to="/dashboard" replace />} />
              <Route path="/gmail/campaigns" element={<ProtectedRoute><Campaigns /></ProtectedRoute>} />
              <Route path="/gmail/history" element={<Navigate to={`${getVibePath("voice", "call-logs")}?type=email`} replace />} />
              <Route path="/gmail/crm-integrations" element={<ProtectedRoute><CrmIntegrations /></ProtectedRoute>} />
              <Route path="/gmail/pricing" element={<Navigate to={`${getVibePath("gmail", "dashboard")}?account=plans`} replace />} />
              <Route path="/gmail/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
              <Route path="/gmail/settings" element={<Navigate to="/dashboard" replace />} />

              <Route path="/unibox" element={<Navigate to={getVibePath("voice", "unibox")} replace />} />
              <Route path="/campaigns" element={<Navigate to={getVibePath("voice", "campaigns")} replace />} />
              <Route path="/agents" element={<Navigate to={getVibePath("voice", "agents")} replace />} />
              <Route path="/agents/new" element={<Navigate to={getVibePath("voice", "agents/new")} replace />} />
              <Route path="/agents/:id" element={<Navigate to={getVibePath("voice", "agents")} replace />} />
              <Route path="/knowledge-base" element={<Navigate to={getVibePath("voice", "knowledge-base")} replace />} />
              <Route path="/phone-config" element={<Navigate to={getVibePath("voice", "phone-config")} replace />} />
              <Route path="/call-logs" element={<Navigate to={getVibePath("voice", "call-logs")} replace />} />
              <Route path="/sms-history" element={<Navigate to={getVibePath("sms", "history")} replace />} />
              <Route path="/outbound-call" element={<Navigate to={getVibePath("voice", "outbound-call")} replace />} />
              <Route path="/demo-call" element={<Navigate to={getVibePath("voice", "demo-call")} replace />} />
              <Route path="/webhooks" element={<Navigate to={getVibePath("voice", "webhooks")} replace />} />
              <Route path="/custom-tools" element={<Navigate to={getVibePath("voice", "custom-tools")} replace />} />
              <Route path="/calendar-integrations" element={<Navigate to={getVibePath("voice", "calendar-integrations")} replace />} />
              <Route path="/crm-integrations" element={<Navigate to={getVibePath("voice", "crm-integrations")} replace />} />
              <Route path="/pricing" element={<Navigate to={`${getVibePath("voice", "dashboard")}?account=plans`} replace />} />
              <Route path="/support" element={<Navigate to={getVibePath("voice", "support")} replace />} />
              <Route path="/settings" element={<Navigate to="/dashboard" replace />} />
              <Route path="/whatsapp" element={<Navigate to={whatsappDashboardPath} replace />} />
              {/* Training space was removed; old links go to the Voice dashboard. */}
              <Route path="/magicteams/*" element={<LegacyVibeRedirect />} />
              <Route path="/firebrand" element={<Navigate to={getVibePath("voice", "dashboard")} replace />} />
              <Route path="/firebrand/*" element={<Navigate to={getVibePath("voice", "dashboard")} replace />} />
              <Route path="/gmail" element={<Navigate to={gmailDashboardPath} replace />} />

              <Route path="/admin-dashboard" element={<Navigate to="/admin/dashboard" replace />} />
              <Route path="/admin/dashboard" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
              <Route path="/agency/dashboard" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
              <Route path="/admin/payments" element={<ProtectedRoute><AgencyPayments /></ProtectedRoute>} />
              <Route path="/agency/payments" element={<ProtectedRoute><AgencyPayments /></ProtectedRoute>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
            <AskVibe />
            <div className="fixed bottom-[0.002px] right-[0.002px] z-50 pointer-events-none select-none text-[6px] font-medium tracking-tight text-zinc-200/70">
              VRK
            </div>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
