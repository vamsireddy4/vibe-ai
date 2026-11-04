// Composio (Platform) for CRM Integrations: each signed-in Vibe AI user (their Clerk id) gets their own
// Composio session; Composio hosts the app sign-in (Connect Link), so we never build an OAuth flow.
// Server only: COMPOSIO_API_KEY comes from .env and never reaches the browser.
import { Composio } from "@composio/core";
import { COMPOSIO_TOOLKITS } from "../src/lib/composio-toolkits";

let client: Composio | null = null;
const composio = (apiKey: string) => (client ??= new Composio({ apiKey }));

type Reply = { status: number; body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });

/**
 * POST /api/local/composio  (Authorization: Bearer <Clerk token>; the caller verifies it and passes the Clerk id)
 *   { action: "status" }                      -> { connected: { [cardId]: true } }
 *   { action: "connect", app, returnTo }      -> { redirectUrl }  (Composio's Connect Link)
 *   { action: "test", app }                   -> { tool, ok, logId, summary }  one read-only call
 *   { action: "gmail_account" }               -> { email | null }  the connected Gmail address (Front's From)
 *   { action: "gmail_send", to, subject, body } -> { ok }  sends from that Gmail
 * Plain in/out so the Vite dev server and the Cloudflare Pages Function share it.
 */
export async function composioHandle(body: any, callerId: string | null, origin: string, apiKey: string): Promise<Reply> {
  if (!apiKey) return reply(500, { error: "COMPOSIO_API_KEY is not set" });
  if (!callerId) return reply(401, { error: "Sign in again to manage integrations." });
  const slug = typeof body?.app === "string" ? COMPOSIO_TOOLKITS[body.app] : undefined;

  try {
    const session = await composio(apiKey).create(callerId); // the user's own Composio identity = Clerk user id

    if (body?.action === "status") {
      const { items } = await session.toolkits({ toolkits: Object.values(COMPOSIO_TOOLKITS), limit: 50 });
      const active = new Set(items.filter((t) => t.connection?.isActive).map((t) => t.slug));
      const connected = Object.fromEntries(Object.entries(COMPOSIO_TOOLKITS).filter(([, s]) => active.has(s)).map(([id]) => [id, true]));
      return reply(200, { connected });
    }

    if (body?.action === "gmail_account") {
      const r: any = await session.execute("GMAIL_GET_PROFILE", { user_id: "me" }).catch(() => null);
      return reply(200, { email: r?.data?.emailAddress ?? null });
    }

    if (body?.action === "gmail_send") {
      const to = String(body.to ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return reply(400, { error: "Enter a valid email address." });
      const text = String(body.body ?? "").slice(0, 20_000);
      if (!text.trim()) return reply(400, { error: "Write a message first." });
      const r: any = await session.execute("GMAIL_SEND_EMAIL", {
        recipient_email: to, subject: String(body.subject ?? "").slice(0, 300) || "(no subject)", body: text, user_id: "me",
      });
      if (r?.successful === false || r?.error) return reply(502, { error: String(r?.error ?? "Gmail did not send the email.").slice(0, 300) });
      return reply(200, { ok: true, id: r?.data?.response_data?.id ?? r?.data?.id ?? null });
    }

    if (!slug) return reply(400, { error: "Unknown integration" });

    if (body.action === "connect") {
      // Come back to the same page after signing in; only same-site paths are allowed.
      const returnTo = typeof body.returnTo === "string" && /^\/(?!\/)/.test(body.returnTo) ? body.returnTo : "/voice/crm-integrations";
      const request = await session.authorize(slug, origin ? { callbackUrl: `${origin}${returnTo}` } : undefined);
      if (!request.redirectUrl) return reply(502, { error: "Composio did not return a sign-in link." });
      return reply(200, { redirectUrl: request.redirectUrl });
    }

    if (body.action === "test") {
      // Find a read-only "who am I / profile" tool for this app at runtime, then run it once.
      const found = await session.search({ query: "get the connected account's own profile or user info (read only)", toolkits: [slug] });
      const tool = found.results?.flatMap((r) => r.primaryToolSlugs ?? []).find((t) => t.toUpperCase().startsWith(slug.toUpperCase()));
      if (!tool) return reply(404, { error: `No read-only test tool found for ${slug}.` });
      const result: any = await session.execute(tool, {});
      const logId = result?.logId ?? result?.log_id ?? result?.data?.logId ?? null;
      const ok = result?.successful !== false && !result?.error;
      const summary = JSON.stringify(result?.data ?? result ?? {}).slice(0, 300);
      return reply(200, { tool, ok, logId, summary, error: ok ? undefined : String(result?.error ?? "Tool call failed") });
    }

    return reply(400, { error: "Unknown action" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return reply(502, { error: message.slice(0, 300) });
  }
}
