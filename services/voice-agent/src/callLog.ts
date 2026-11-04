/**
 * Save a finished call to Supabase `call_logs` (shown on the app's Call History page).
 * Uses the service role key from the app's .env (server only, never sent to a browser).
 * Recordings are NOT stored: Telnyx keeps them, and the app fetches them live by call id
 * (twilio_call_sid = "telnyx:<call_control_id>").
 * ponytail: the new project's call_logs has no recording_path column, so the provider call id
 * goes in twilio_call_sid with a "telnyx:" prefix; add a provider_call_id column if more providers come.
 */
// Read per call: on Cloudflare, process.env comes from the Worker's secrets.
const env = () => ({ url: process.env.SUPABASE_URL?.replace(/\/$/, ""), key: process.env.SUPABASE_SERVICE_ROLE_KEY });

export type TranscriptLine = { role: "user" | "agent"; text: string; timestamp: string };

export type CallOwner = { userId: string; agentId?: string };

const CLERK_USER = /^user_[A-Za-z0-9]{10,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner fields from a client message; null when missing or malformed (then the call isn't logged). */
export function parseOwner(v: any): CallOwner | null {
  if (typeof v?.userId !== "string" || !CLERK_USER.test(v.userId)) return null;
  return { userId: v.userId, ...(typeof v.agentId === "string" && UUID.test(v.agentId) ? { agentId: v.agentId } : {}) };
}

const BUCKET = "call-recordings"; // private; users read only their own folder (supabase/call_recordings_bucket.sql)

/** Browser demo calls have no provider recording, so the WAV goes to Supabase Storage. Returns "storage:<path>". */
export async function uploadRecording(owner: CallOwner, wavBytes: Buffer): Promise<string | undefined> {
  const { url, key } = env();
  if (!url || !key) return;
  const path = `${owner.userId}/${crypto.randomUUID()}.wav`;
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "audio/wav" },
    body: new Uint8Array(wavBytes),
  }).catch((e: Error) => e);
  if (res instanceof Error || !res.ok) {
    // The call row is still saved, just without a recording.
    return void console.error("recording upload failed", res instanceof Error ? res.message : `${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return `storage:${path}`;
}

export async function saveCallLog(row: {
  owner: CallOwner;
  direction: "demo" | "outbound" | "inbound";
  status: string;
  from?: string;
  to?: string;
  startedAt: Date;
  endedAt: Date;
  transcript: TranscriptLine[];
  providerCallId?: string; // "telnyx:<call_control_id>" or "storage:<path>": where the app finds the recording
}) {
  const { url, key } = env();
  if (!url || !key) return console.warn("call log not saved: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  const res = await fetch(`${url}/rest/v1/call_logs`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: row.owner.userId,
      agent_id: row.owner.agentId ?? null,
      direction: row.direction,
      status: row.status,
      caller_number: row.from ?? null,
      recipient_number: row.to ?? null,
      started_at: row.startedAt.toISOString(),
      ended_at: row.endedAt.toISOString(),
      duration: Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000),
      transcript: row.transcript,
      twilio_call_sid: row.providerCallId ?? null,
    }),
  }).catch((e: Error) => e);
  if (res instanceof Error) console.error("call log save failed", res.message);
  else if (!res.ok) console.error("call log save failed", res.status, (await res.text()).slice(0, 300));
  await sendWebhooks(row.owner, "call.ended", {
    agent_id: row.owner.agentId ?? null, direction: row.direction, status: row.status,
    from: row.from ?? null, to: row.to ?? null,
    started_at: row.startedAt.toISOString(), ended_at: row.endedAt.toISOString(),
    duration_seconds: Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000),
    transcript: row.transcript, provider_call_id: row.providerCallId ?? null,
  });
}

/** HMAC-SHA256 hex of the body, so receivers can check the request came from Vibe AI. */
export async function sign(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST the event to the user's active webhooks (Webhooks page) for this agent, or for all agents. */
// ponytail: one attempt per webhook, no retry queue; add a retry table if receivers are flaky.
export async function sendWebhooks(owner: CallOwner, event: string, data: object) {
  const { url, key } = env();
  if (!url || !key) return;
  const agent = owner.agentId ? `,agent_id.eq.${owner.agentId}` : "";
  const r = await fetch(
    `${url}/rest/v1/webhooks?select=url,secret&user_id=eq.${encodeURIComponent(owner.userId)}&is_active=eq.true&events=cs.{${event}}&or=(agent_id.is.null${agent})`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  ).catch(() => null);
  const hooks: { url: string; secret: string | null }[] = r?.ok ? await r.json() : [];
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data });
  await Promise.all(hooks.filter((h) => /^https:\/\//i.test(h.url)).map(async (h) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "VibeAI-Webhooks" };
    if (h.secret) headers["X-Vibe-Signature"] = `sha256=${await sign(h.secret, body)}`;
    const res = await fetch(h.url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) }).catch((e: Error) => e);
    const res2 = res instanceof Error ? res.message : res.status;
    console.log(`[webhook] ${event} -> ${new URL(h.url).host}: ${res2}`);
    if (!(res instanceof Error)) await res.body?.cancel();
  }));
}
