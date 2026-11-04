/**
 * Custom CRM apps on calls (Agent > Tools > Custom CRM): each app the user added for this agent, connected
 * in CRM Integrations (Composio), gives the call model that app's main actions as tools.
 * Gmail is left out on purpose: its Custom CRM entry is an email template, and the agent never emails people itself.
 */
import { Composio } from "@composio/core";
import { COMPOSIO_TOOLKITS } from "../../../src/lib/composio-toolkits.js";
import type { AgentTools } from "./llm/groqStreamer.js";

const PER_APP = 8;
const NOT_ON_CALLS = new Set(["gmail"]);
// Never on calls: anything that destroys data or changes access/settings (Composio's "important" list for
// Google Calendar was ACL edits and deleting calendars).
const UNSAFE = /(DELETE|REMOVE|CLEAR|TRASH|PURGE|DESTROY|ARCHIVE|ACL|PERMISSION|SHARE|SETTING|BATCH|MOVE|EMPTY|UNSUBSCRIBE|REVOKE|PATCH|UPDATE|WATCH|STOP|IMPORT|COLORS|CALENDAR_LIST)/;
// Most useful first: find/search, then read, then add new records; anything else isn't offered on calls.
const rank = (slug: string) =>
  /(FIND|SEARCH|LOOKUP|FREE_SLOTS|FREE_BUSY|AVAILABILITY)/.test(slug) ? 0
  : /(LIST|_GET|FETCH|_READ)/.test(slug) ? 1
  : /(CREATE|_ADD|APPEND|INSERT|_NEW)/.test(slug) ? 2
  : 3;

/** The app's safe, useful actions for a phone call, at most PER_APP. Exported for the selfcheck. */
export function callSafeTools<T extends { slug: string; isDeprecated?: boolean }>(tools: T[]): T[] {
  return tools
    .filter((t) => t.slug && !t.isDeprecated && !UNSAFE.test(t.slug) && rank(t.slug) < 3)
    .sort((a, b) => rank(a.slug) - rank(b.slug))
    .slice(0, PER_APP);
}

export async function crmTools(userId: string, agentId?: string): Promise<AgentTools | undefined> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!agentId || !apiKey) return;
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const r = await fetch(`${url}/rest/v1/agents?select=custom_crm_providers&id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).catch(() => null);
  const [row] = r?.ok ? ((await r.json()) as { custom_crm_providers: string[] | null }[]) : [];
  const slugs = (row?.custom_crm_providers ?? []).filter((id) => !NOT_ON_CALLS.has(id)).map((id) => COMPOSIO_TOOLKITS[id]).filter(Boolean);
  if (!slugs.length) return;

  const composio = new Composio({ apiKey });
  const lists = await Promise.all(
    slugs.map((toolkit) => composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 200 } as any).then((l: any) => callSafeTools(l ?? [])).catch(() => [] as any[])),
  );
  const tools = lists.flat() as any[];
  if (!tools.length) return;
  const known = new Set(tools.map((t) => t.slug as string));
  const session = await composio.create(userId);

  return {
    defs: tools.map((t) => ({
      type: "function",
      function: { name: t.slug, description: String(t.description ?? t.name ?? t.slug).slice(0, 400), parameters: t.inputParameters ?? { type: "object", properties: {} } },
    })),
    prompt: `CRM TOOLS. You can use the user's connected apps (${slugs.join(", ")}) with these tools: ${[...known].join(", ")}. Use one only when the caller's request needs it (e.g. looking up or saving their details). Collect what the tool needs first, say only "One moment." while it runs, then tell the caller the result in plain words. Never claim something was saved or found unless the tool returned it.`,
    run: async (name, args) => {
      if (!known.has(name)) return `Unknown tool ${name}`;
      try {
        const result: any = await session.execute(name, args ?? {});
        console.log(`[crm] ${name}: ${result?.successful === false || result?.error ? "failed" : "ok"}`);
        if (result?.successful === false || result?.error) return `The ${name} action failed: ${String(result?.error ?? "unknown error").slice(0, 300)}. Tell the caller you couldn't do that right now.`;
        return JSON.stringify(result?.data ?? result ?? {}).slice(0, 2000);
      } catch (e) {
        return `The ${name} action didn't run (${(e as Error).message.slice(0, 200)}). Tell the caller you couldn't do that right now.`;
      }
    },
  };
}
