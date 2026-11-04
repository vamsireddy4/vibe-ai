/**
 * Ask Vibe's read access: a short, read-only summary of the signed-in user's own account (agents, calls,
 * campaigns, tools, ...), added to the chat's system prompt so it can answer "which voice does X use?".
 * userId comes from the Pages proxy (Clerk-verified), never from the request body.
 * No secrets: API keys, tokens, auth tokens, webhook secrets and prompts' full text are never selected.
 */
const env = () => ({ url: process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" });

async function rows(table: string, query: string, userId: string): Promise<{ list: any[]; total: number }> {
  const { url, key } = env();
  const r = await fetch(`${url}/rest/v1/${table}?${query}&user_id=eq.${encodeURIComponent(userId)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!r?.ok) return { list: [], total: 0 };
  const list = (await r.json()) as any[];
  return { list, total: Number(r.headers.get("content-range")?.split("/")[1]) || list.length };
}

const day = (v?: string) => (v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");
const secs = (n?: number | null) => (n == null ? "?" : `${Math.floor(n / 60)}m ${n % 60}s`);

/** The account summary as plain lines (at most ~6k characters). Exported for the selfcheck via formatAccount. */
export function formatAccount(d: Record<string, { list: any[]; total: number }>): string {
  const agentName = new Map(d.agents.list.map((a) => [a.id, a.name]));
  const an = (id?: string | null) => (id ? agentName.get(id) ?? "unknown agent" : "no agent");
  const lines = [
    `Agents (${d.agents.total}): ${d.agents.list.map((a) => `${a.name} [voice ${a.voice || "default"}, model ${a.model || "default"}, language ${a.language_hint || "auto"}, ${a.is_active ? "active" : "inactive"}${a.custom_crm_providers?.length ? `, custom CRM: ${a.custom_crm_providers.join("/")}` : ""}]`).join("; ") || "none"}`,
    `Phone numbers (${d.phones.total}): ${d.phones.list.map((p) => `${p.phone_number} (${p.provider}${p.inbound_agent_id ? `, inbound agent ${an(p.inbound_agent_id)}` : ""})`).join("; ") || "none"}`,
    `Calls in History: ${d.calls.total} total. Latest ${d.calls.list.length}: ${d.calls.list.map((c) => `${day(c.started_at)} ${c.direction} ${c.caller_number ?? "?"} -> ${c.recipient_number ?? "?"}, ${an(c.agent_id)}, ${c.status}, ${secs(c.duration)}${c.summary ? `, summary: ${String(c.summary).replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join(" | ") || "none"}`,
    `Voice campaigns (${d.campaigns.total}): ${d.campaigns.list.map((c) => `${c.venue_name || "Untitled"} [${c.status}, agent ${an(c.agent_id)}, ${c.calls_made ?? 0}/${c.total_contacts ?? 0} called]`).join("; ") || "none"}`,
    `Email campaigns (${d.gmail.total}): ${d.gmail.list.map((c) => `${c.name} [${c.status}, ${c.total_contacts ?? 0} contacts]`).join("; ") || "none"}`,
    `Emails sent (History > Email, ${d.emailsSent.total}): ${d.emailsSent.list.map((c) => `${day(c.completed_at)} "${c.name}" ${c.template_name === "Single email" ? "single email" : "campaign"}, sent ${c.sent_count ?? 0}, failed ${c.failed_count ?? 0}`).join(" | ") || "none"}`,
    `WhatsApp campaigns (${d.whatsapp.total}): ${d.whatsapp.list.map((c) => `${c.name} [${c.status}, sent ${c.sent_count ?? 0}]`).join("; ") || "none"}`,
    `Audiences (${d.audiences.total}): ${d.audiences.list.map((a) => a.name).join("; ") || "none"}`,
    `Custom tools (${d.tools.total}): ${d.tools.list.map((t) => `${t.name} [${t.http_method ?? ""} for ${an(t.agent_id)}, ${t.is_active ? "active" : "off"}]`).join("; ") || "none"}`,
    `Appointment tools (${d.apptTools.total}): ${d.apptTools.list.map((t) => `${t.name} [${t.provider ?? "calendar"} for ${an(t.agent_id)}, ${t.is_active ? "active" : "off"}]`).join("; ") || "none"}`,
    `Upcoming bookings (${d.bookings.total}): ${d.bookings.list.map((b) => `${day(b.start_time)} ${b.title} (${b.booked_for_name ?? "?"}, ${b.status})`).join("; ") || "none"}`,
    `Calendars connected: ${d.calendars.list.map((c) => `${c.provider}${c.is_active ? "" : " (off)"}`).join(", ") || "none"}`,
    `Knowledge base (${d.knowledge.total}): ${d.knowledge.list.map((k) => `${k.title} [${k.type}, ${k.processing_status}, for ${an(k.agent_id)}]`).join("; ") || "none"}`,
    `Webhooks (${d.webhooks.total}): ${d.webhooks.list.map((w) => `${w.url} [${(w.events ?? []).join("/") || "all events"}, ${w.is_active ? "active" : "off"}]`).join("; ") || "none"}`,
    `Profile: ${d.profile.list[0] ? `name ${d.profile.list[0].full_name || "not set"}, company ${d.profile.list[0].company_name || "not set"}, timezone ${d.profile.list[0].timezone || "UTC"}` : "not set"}`,
  ];
  return lines.map((l) => (l.length > 900 ? `${l.slice(0, 900)}…` : l)).join("\n");
}

export async function accountData(userId: string): Promise<string> {
  if (!env().url || !env().key) return "";
  const now = new Date().toISOString();
  const q = {
    agents: rows("agents", "select=id,name,voice,model,language_hint,is_active,custom_crm_providers&order=created_at.desc&limit=30", userId),
    phones: rows("phone_configs", "select=phone_number,provider,inbound_agent_id&is_active=eq.true&limit=20", userId),
    calls: rows("call_logs", "select=started_at,direction,caller_number,recipient_number,agent_id,status,duration,summary&order=started_at.desc&limit=8", userId),
    campaigns: rows("campaigns", "select=venue_name,status,agent_id,calls_made,total_contacts&order=created_at.desc&limit=15", userId),
    gmail: rows("gmail_campaigns", "select=name,status,total_contacts&order=created_at.desc&limit=15", userId),
    emailsSent: rows("gmail_completed_campaigns", "select=name,template_name,sent_count,failed_count,completed_at&order=created_at.desc&limit=8", userId),
    whatsapp: rows("whatsapp_campaigns", "select=name,status,sent_count&order=created_at.desc&limit=10", userId),
    audiences: rows("whatsapp_audiences", "select=name&limit=20", userId),
    tools: rows("agent_tools", "select=name,http_method,agent_id,is_active&limit=20", userId),
    apptTools: rows("appointment_tools", "select=name,provider,agent_id,is_active&limit=10", userId),
    bookings: rows("appointment_bookings", `select=title,start_time,booked_for_name,status&start_time=gte.${now}&order=start_time.asc&limit=8`, userId),
    calendars: rows("calendar_integrations", "select=provider,is_active&limit=10", userId),
    knowledge: rows("knowledge_base_items", "select=title,type,processing_status,agent_id&limit=20", userId),
    webhooks: rows("webhooks", "select=url,events,is_active&limit=10", userId),
    profile: rows("profiles", "select=full_name,company_name,timezone&limit=1", userId),
  };
  const d = Object.fromEntries(await Promise.all(Object.entries(q).map(async ([k, p]) => [k, await p] as const)));
  return formatAccount(d);
}
