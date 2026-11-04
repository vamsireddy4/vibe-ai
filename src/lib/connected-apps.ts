// Which Google workspace apps an account can use for agent CRM actions and campaign outcome actions.
import { supabase } from "@/integrations/supabase/client";
import { localApi } from "@/lib/local-functions";

export type WorkspaceApp = string;

/** Names for CRM Integrations apps (ids as in COMPOSIO_TOOLKITS). */
export const APP_LABELS: Record<string, string> = {
  gmail: "Email", google_docs: "Google Docs", google_sheets: "Google Sheets", google_calendar: "Google Calendar",
  hubspot: "HubSpot", salesforce: "Salesforce", zoho: "Zoho CRM", excel: "Excel", pipedrive: "Pipedrive",
  activecampaign: "ActiveCampaign", airtable: "Airtable", zendesk: "Zendesk", intercom: "Intercom", supabase: "Supabase",
  slack: "Slack", notion: "Notion", outlook: "Outlook", microsoft_word: "Microsoft Word",
};

/**
 * Apps connected through the older Google sign-in (calendar_integrations rows), plus every app connected in
 * CRM Integrations (Composio). On calls the agent uses Composio apps' actions (services/voice-agent/src/crmTools.ts);
 * Email is a template for "Open Email" in campaign outcomes. Campaign outcome actions only use gmail/docs/sheets.
 */
export async function connectedWorkspaceApps(userId: string): Promise<{ provider: WorkspaceApp; id: string; display_name: string | null }[]> {
  const [{ data }, composio] = await Promise.all([
    supabase.from("calendar_integrations").select("id, provider, display_name").eq("user_id", userId).eq("is_active", true).in("provider", ["gmail", "google_docs", "google_sheets"]),
    localApi<{ connected: Record<string, boolean> }>("/api/local/composio", { action: "status" }).catch(() => ({ connected: {} as Record<string, boolean> })),
  ]);
  const apps = (data ?? []) as { provider: WorkspaceApp; id: string; display_name: string | null }[];
  for (const [id, on] of Object.entries(composio.connected ?? {})) {
    if (on && !apps.some((a) => a.provider === id)) apps.push({ provider: id, id: `composio-${id}`, display_name: APP_LABELS[id] ?? id });
  }
  return apps;
}
