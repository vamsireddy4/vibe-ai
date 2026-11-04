// Shared by the CRM Integrations page and server/composio.ts (no SDK here, so it's safe in the browser).
/** CRM page card id -> Composio toolkit slug (looked up with session.toolkits({ search }), not guessed). */
export const COMPOSIO_TOOLKITS: Record<string, string> = {
  google_sheets: "googlesheets",
  gmail: "gmail",
  google_calendar: "googlecalendar", // Calendar Integrations page
  google_docs: "googledocs",
  hubspot: "hubspot",
  salesforce: "salesforce",
  zoho: "zoho",
  excel: "excel",
  pipedrive: "pipedrive",
  activecampaign: "active_campaign",
  airtable: "airtable",
  zendesk: "zendesk",
  intercom: "intercom",
  supabase: "supabase",
  slack: "slack",
  notion: "notion",
  outlook: "outlook",
  microsoft_word: "microsoft_word",
};
