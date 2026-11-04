import { useEffect, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "react-router-dom";
import { GMAIL_LOGO, GOOGLE_SHEETS_LOGO } from "@/lib/brand-logos";
import { getClerkToken } from "@/integrations/supabase/client";

/** Calls the local Composio route as the signed-in user. */
async function composioApi(body: Record<string, unknown>) {
  const token = await getClerkToken();
  const res = await fetch("/api/local/composio", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const HUBSPOT_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" fill="#ff7a59"/>
      <circle cx="5" cy="5" r="2.1" fill="#ff7a59"/>
      <circle cx="19" cy="8" r="2.1" fill="#ff7a59"/>
      <circle cx="7" cy="19" r="2.1" fill="#ff7a59"/>
      <path d="M9.4 9.4 6.8 6.8M14.8 10.4l2.6-1.7M10.8 14.6l-2.3 2.7M12 5.8V8" stroke="#ff7a59" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `);

const SALESFORCE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 44" fill="none">
      <path d="M20 34c-5.5 0-10-4.1-10-9.2 0-4.7 3.7-8.5 8.5-9.1C20.1 11 24.8 8 30.2 8c6 0 11.1 3.8 12.7 9.1.8-.3 1.7-.4 2.6-.4 4.7 0 8.5 3.7 8.5 8.3S50.2 33 45.5 33H20Z" fill="#00A1E0"/>
    </svg>
  `);

const ZOHO_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="6" y="10" width="24" height="20" rx="3" fill="#E42527"/>
      <rect x="34" y="10" width="24" height="20" rx="3" fill="#F89B1C"/>
      <rect x="6" y="34" width="24" height="20" rx="3" fill="#2EAF4A"/>
      <rect x="34" y="34" width="24" height="20" rx="3" fill="#226DB4"/>
      <path d="M14 24h8l-8-8h8M40 24h10l-10-10h10M12 48h12l-12-12h12M40 48h10l-10-10h10" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `);

const EXCEL_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M22 10h20l12 12v32a6 6 0 0 1-6 6H22V10Z" fill="#217346"/>
      <path d="M42 10v14h14" fill="#4FA16C"/>
      <rect x="10" y="18" width="24" height="28" rx="4" fill="#185C37"/>
      <path d="m17 39 4.5-7-4.2-7h4.5l2.2 4.4 2.5-4.4H31l-4.3 6.8 4.5 7.2h-4.6L24 34.3 21.3 39H17Z" fill="white"/>
    </svg>
  `);

const PIPEDRIVE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="10" y="10" width="44" height="44" rx="12" fill="#1D7AFC"/>
      <path d="M22 20h12c7.7 0 14 6.3 14 14s-6.3 14-14 14h-5v-9h5a5 5 0 1 0 0-10H22V20Z" fill="white"/>
      <rect x="22" y="20" width="7" height="28" rx="3.5" fill="#DDEBFF"/>
    </svg>
  `);

const ACTIVECAMPAIGN_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="8" y="8" width="48" height="48" rx="14" fill="#356AE6"/>
      <path d="M22 20h20l-9 10 11 14H34l-7-9-5 5v-9l10-11Z" fill="white"/>
      <path d="M22 44h10l-5-6-5 6Z" fill="#BFD1FF"/>
    </svg>
  `);

const AIRTABLE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M31 10 12 18.5c-2.2 1-2.2 4.2 0 5.1L31 32l19-8.4c2.2-1 2.2-4.2 0-5.1L31 10Z" fill="#FCB400"/>
      <path d="M35 35.8v17.8c0 1.7 1.8 2.8 3.3 2L53 48.2a4 4 0 0 0 2-3.5V27.5c0-1.5-1.5-2.5-2.9-1.9L35 35.8Z" fill="#18BFFF"/>
      <path d="M28.8 37 12.9 30.3C10.2 29.1 7 31.1 7 34v10.1c0 1.6.9 3.1 2.3 3.8l16 8.7c1.7.9 3.7-.3 3.7-2.2V37h-.2Z" fill="#F82B60"/>
    </svg>
  `);

const ZENDESK_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M12 20c0-4.4 3.6-8 8-8h24L12 44V20Z" fill="#03363D"/>
      <path d="M52 44c0 4.4-3.6 8-8 8H20l32-32v24Z" fill="#17494D"/>
      <circle cx="20" cy="50" r="6" fill="#03363D"/>
    </svg>
  `);

const INTERCOM_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="10" y="10" width="44" height="44" rx="16" fill="#1F8DED"/>
      <rect x="18" y="18" width="5" height="20" rx="2.5" fill="white"/>
      <rect x="27" y="16" width="5" height="24" rx="2.5" fill="white"/>
      <rect x="36" y="18" width="5" height="20" rx="2.5" fill="white"/>
      <rect x="45" y="22" width="5" height="12" rx="2.5" fill="white"/>
      <path d="M22 44c2.6 3.3 6.1 5 10 5s7.4-1.7 10-5" stroke="white" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `);

const SUPABASE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M38.6 8c2.2 0 3.5 2.5 2.3 4.4L25.3 35.1a4 4 0 0 1-3.4 1.9H12.5c-2.2 0-3.5-2.5-2.3-4.4L25.8 9.9A4 4 0 0 1 29.2 8h9.4Z" fill="#3ECF8E"/>
      <path d="M25.4 27c-2.2 0-3.5 2.5-2.3 4.4l10.7 18.7c1.4 2.4 4.8 2.5 6.2.1l14-22.8c1.2-1.9-.2-4.4-2.4-4.4H25.4Z" fill="#1C1C1C"/>
    </svg>
  `);

const SLACK_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="26" y="8" width="12" height="20" rx="6" fill="#36C5F0"/>
      <rect x="36" y="26" width="20" height="12" rx="6" fill="#36C5F0"/>
      <rect x="36" y="36" width="12" height="20" rx="6" fill="#2EB67D"/>
      <rect x="26" y="36" width="20" height="12" rx="6" fill="#2EB67D"/>
      <rect x="8" y="26" width="20" height="12" rx="6" fill="#E01E5A"/>
      <rect x="16" y="8" width="12" height="20" rx="6" fill="#E01E5A"/>
      <rect x="8" y="36" width="20" height="12" rx="6" fill="#ECB22E"/>
      <rect x="16" y="36" width="12" height="20" rx="6" fill="#ECB22E"/>
    </svg>
  `);

const NOTION_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <rect x="10" y="10" width="44" height="44" rx="8" fill="white" stroke="#111827" stroke-width="4"/>
      <path d="M22 22h8l12 18V22h4v20h-8L26 24v18h-4V22Z" fill="#111827"/>
    </svg>
  `);

const OUTLOOK_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M24 14h24a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H24V14Z" fill="#0A64D6"/>
      <path d="M24 22h30v20H24l10-10-10-10Z" fill="#1975F0"/>
      <rect x="10" y="18" width="22" height="28" rx="4" fill="#084B9A"/>
      <path d="M21 26c-4.4 0-8 3.6-8 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8Zm0 4.2c2.1 0 3.8 1.7 3.8 3.8s-1.7 3.8-3.8 3.8-3.8-1.7-3.8-3.8 1.7-3.8 3.8-3.8Z" fill="white"/>
    </svg>
  `);

const GOOGLE_DOCS_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M18 8h20l12 12v36H18a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6Z" fill="#4285F4"/>
      <path d="M38 8v14h14" fill="#AECBFA"/>
      <path d="M23 28h18M23 36h18M23 44h14" stroke="white" stroke-width="4" stroke-linecap="round"/>
    </svg>
  `);

const MICROSOFT_WORD_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
      <path d="M24 10h20l10 10v34a6 6 0 0 1-6 6H24V10Z" fill="#185ABD"/>
      <path d="M44 10v12h12" fill="#3C7EF3"/>
      <rect x="10" y="18" width="24" height="28" rx="4" fill="#103F91"/>
      <path d="m16 25 3.2 14h.3l2.6-10.3L24.7 39h.3L28.2 25h-3.3l-1.2 7.9L21.7 25h-2.4l-1.9 7.9L16.2 25H16Z" fill="white"/>
    </svg>
  `);

const CRM_PROVIDERS = [
  {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Sync leads, call results, and appointment outcomes into a live spreadsheet in one click.",
    logoUrl: GOOGLE_SHEETS_LOGO,
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Sync contacts, companies, notes, and lifecycle stages in one click.",
    logoUrl: HUBSPOT_LOGO,
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Sync email conversations and lead follow-ups from Gmail into your CRM workflow.",
    logoUrl: GMAIL_LOGO,
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description: "Push leads, activities, and call outcomes directly into Salesforce.",
    logoUrl: SALESFORCE_LOGO,
  },
  {
    id: "zoho",
    name: "Zoho CRM",
    description: "Send contact updates and call summaries into your Zoho workspace.",
    logoUrl: ZOHO_LOGO,
  },
  {
    id: "excel",
    name: "Excel",
    description: "Sync campaign contacts and outcomes into Microsoft Excel workflows.",
    logoUrl: EXCEL_LOGO,
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    description: "Send leads, notes, and call activity into your Pipedrive pipeline.",
    logoUrl: PIPEDRIVE_LOGO,
  },
  {
    id: "activecampaign",
    name: "ActiveCampaign",
    description: "Sync leads, automations, and follow-up activity into ActiveCampaign.",
    logoUrl: ACTIVECAMPAIGN_LOGO,
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Keep campaign leads, call outcomes, and notes synced with Airtable bases.",
    logoUrl: AIRTABLE_LOGO,
  },
  {
    id: "zendesk",
    name: "Zendesk",
    description: "Create and update support records from outbound call outcomes.",
    logoUrl: ZENDESK_LOGO,
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Send lead context and follow-up events into Intercom conversations.",
    logoUrl: INTERCOM_LOGO,
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Sync campaign leads, outcomes, and follow-up activity into your Supabase workspace.",
    logoUrl: SUPABASE_LOGO,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Push campaign alerts, call summaries, and follow-up events into Slack channels.",
    logoUrl: SLACK_LOGO,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Send call outcomes, notes, and campaign updates into Notion pages and databases.",
    logoUrl: NOTION_LOGO,
  },
  {
    id: "outlook",
    name: "Outlook",
    description: "Sync email follow-ups and conversation activity into Microsoft Outlook workflows.",
    logoUrl: OUTLOOK_LOGO,
  },
  {
    id: "google_docs",
    name: "Google Docs",
    description: "Push call notes, summaries, and campaign updates into Google Docs.",
    logoUrl: GOOGLE_DOCS_LOGO,
  },
  {
    id: "microsoft_word",
    name: "Microsoft Word",
    description: "Generate call notes, summaries, and campaign documents in Microsoft Word.",
    logoUrl: MICROSOFT_WORD_LOGO,
  },
] as const;

export default function CrmIntegrations() {
  const { user } = useAuth();
  const { toast } = useToast();
  const location = useLocation();
  const [connectingId, setConnectingId] = useState<string | null>(null);

  // Connections now live in Composio (per user); every app Composio supports can be connected.
  const [composioConnected, setComposioConnected] = useState<Record<string, boolean>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const isConnected = (providerId: string) => Boolean(composioConnected[providerId]);

  useEffect(() => {
    if (!user) return;
    composioApi({ action: "status" })
      .then((d) => setComposioConnected(d.connected ?? {}))
      .catch((e: Error) => console.warn("Composio status failed", e.message));
  }, [user, location.search]); // re-check when Composio sends the user back here

  const testConnection = async (providerName: string, providerId: string) => {
    setTestingId(providerId);
    try {
      const r = await composioApi({ action: "test", app: providerId });
      toast({
        title: r.ok ? `${providerName} works` : `${providerName} test failed`,
        description: r.ok ? `Ran ${r.tool}${r.logId ? ` · log ${r.logId}` : ""}` : r.error,
        variant: r.ok ? undefined : "destructive",
      });
    } catch (e) {
      toast({ title: `${providerName} test failed`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  const handleConnectSingle = async (providerName: string, providerId: string) => {
    // Composio hosts the sign-in and sends the user back to this page.
    setConnectingId(providerId);
    try {
      const { redirectUrl } = await composioApi({ action: "connect", app: providerId, returnTo: `${location.pathname}?composio=${providerId}` });
      window.location.href = redirectUrl;
    } catch (e) {
      toast({ title: `Couldn't connect ${providerName}`, description: (e as Error).message, variant: "destructive" });
      setConnectingId(null);
    }
  };

  // Connected first, then A to Z.
  const sortedProviders = [...CRM_PROVIDERS].sort((a, b) => Number(isConnected(b.id)) - Number(isConnected(a.id)) || a.name.localeCompare(b.name));

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">CRM Integrations</h1>
            <p className="mt-1 text-muted-foreground">
              Connect your CRM stack so every lead, contact, and call outcome stays synced automatically.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>One-Click CRM Setup</CardTitle>
            <CardDescription>
              Choose a CRM below or start the full connection flow with a single click.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sortedProviders.map((provider) => (
              <div
                key={provider.id}
                className="rounded-xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white p-2">
                      <img
                        src={provider.logoUrl}
                        alt={`${provider.name} logo`}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <div>
                      <div className="font-semibold text-foreground">{provider.name}</div>
                      <Badge variant="outline" className="mt-2">
                        {isConnected(provider.id) ? "Connected" : "One click"}
                      </Badge>
                    </div>
                  </div>
                </div>

                <p className="mt-4 text-sm leading-6 text-muted-foreground">{provider.description}</p>

                {isConnected(provider.id) ? (
                  <div className="mt-5 flex gap-2">
                    <Button className="flex-1" variant="outline" disabled>
                      Connected
                    </Button>
                    <Button className="flex-1" onClick={() => void testConnection(provider.name, provider.id)} disabled={testingId === provider.id}>
                      {testingId === provider.id ? "Testing..." : "Test"}
                    </Button>
                  </div>
                ) : (
                  <Button
                    className="mt-5 w-full"
                    onClick={() => void handleConnectSingle(provider.name, provider.id)}
                    disabled={connectingId === provider.id}
                  >
                    {connectingId === provider.id ? "Connecting..." : `Connect ${provider.name}`}
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
