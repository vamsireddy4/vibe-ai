// /voice-agent/* -> the voice agent (services/voice-agent, reached through its tunnel at VOICE_AGENT_URL).
// Routes that spend Meta/Deepgram/phone credit (/ask/*, /calls/*, /campaigns/*) need a signed-in caller; the proxy then
// vouches for them with AGENT_PROXY_KEY and sets the call's owner itself, so the body can't pick it.
// The demo-call WebSocket (/ws/call) can't send headers, so it carries the Clerk token as ?token=; the proxy
// checks it, drops it from the URL, and tells the agent who the caller is (the agent meters their minutes).
// Everything else (health, models, voices, provider media sockets) passes straight through.
import { callerOf, json, type PagesContext } from "../../server/pages";

export const onRequest = async ({ request, env }: PagesContext) => {
  const base = env.VOICE_AGENT_URL?.replace(/\/$/, "");
  if (!base) return json(503, { error: "The voice agent isn't connected (VOICE_AGENT_URL is not set)." });
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/voice-agent/, "") || "/";
  const target = `${base}${path}${url.search}`;

  if (path === "/ws/call") {
    if (!env.AGENT_PROXY_KEY) return json(503, { error: "AGENT_PROXY_KEY is not set" });
    const token = url.searchParams.get("token") ?? "";
    url.searchParams.delete("token");
    const caller = await callerOf(new Request(request.url, { headers: { Authorization: `Bearer ${token}` } }), env);
    if (!caller) return json(401, { error: "Sign in again to start a demo call." });
    const headers = new Headers(request.headers);
    headers.set("x-vibe-proxy-key", env.AGENT_PROXY_KEY);
    headers.set("x-vibe-user", caller.id);
    return fetch(`${base}${path}${url.search}`, { method: "GET", headers });
  }

  if (!/^\/(ask|calls|campaigns)\//.test(path)) return fetch(new Request(target, request));

  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!env.AGENT_PROXY_KEY) return json(503, { error: "AGENT_PROXY_KEY is not set" });
  const caller = await callerOf(request, env);
  if (!caller) return json(401, { error: "Sign in again to use the voice agent." });
  let body = await request.text();
  if (path.startsWith("/calls/") || path.startsWith("/campaigns/")) {
    const parsed = JSON.parse(body || "{}");
    body = JSON.stringify({ ...parsed, userId: caller.id });
  }
  return fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vibe-proxy-key": env.AGENT_PROXY_KEY, "x-vibe-user": caller.id },
    body,
  });
};
