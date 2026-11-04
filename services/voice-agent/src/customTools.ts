/**
 * Custom Tools (Agent > Tools > Custom Tools): the agent's active HTTP tools from agent_tools, offered to the
 * call model as functions. When the model calls one, we make the HTTP request and give it the response.
 */
import type { AgentTools } from "./llm/groqStreamer.js";

type Param = { paramType: "dynamic" | "automatic"; name: string; location: string; required?: boolean; schema?: { type?: string; description?: string }; knownValue?: string };
type Tool = { name: string; description: string | null; http_method: string; http_url: string; http_headers: Record<string, string> | null; http_body_template: Record<string, unknown> | null; parameters: Param[] | null };

const FN_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Turn one saved tool + the model's arguments into the HTTP request. Exported for the selfcheck. */
export function buildRequest(t: Tool, args: Record<string, unknown>): { url: string; init: RequestInit } {
  const method = (t.http_method || "GET").toUpperCase();
  const params = t.parameters ?? [];
  const url = new URL(t.http_url);
  const headers: Record<string, string> = { ...(t.http_headers ?? {}) };
  const body: Record<string, unknown> = {};
  // Static values (saved in the body template; keys starting "__" are settings, not data).
  for (const [k, v] of Object.entries(t.http_body_template ?? {})) if (!k.startsWith("__")) (method === "GET" ? url.searchParams.set(k, String(v)) : (body[k] = v));
  const put = (name: string, location: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    if (location === "header") headers[name] = String(value);
    else if (location === "path") url.pathname = url.pathname.replace(`%7B${name}%7D`, encodeURIComponent(String(value)));
    else if (location === "query" || method === "GET") url.searchParams.set(name, String(value));
    else body[name] = value;
  };
  for (const p of params) put(p.name, p.location, p.paramType === "automatic" ? p.knownValue : args[p.name]);
  if (!params.some((p) => p.paramType === "dynamic")) put("input", "query", args.input);
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000) };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] ??= "application/json";
    init.body = JSON.stringify(body);
  }
  return { url: url.toString(), init };
}

function schema(t: Tool) {
  const dyn = (t.parameters ?? []).filter((p) => p.paramType === "dynamic" && FN_NAME.test(p.name));
  if (!dyn.length) return { type: "object", properties: { input: { type: "string", description: "What the caller said that this tool needs (for example a number or name)" } } };
  return {
    type: "object",
    properties: Object.fromEntries(dyn.map((p) => [p.name, { type: TYPES.has(p.schema?.type ?? "") ? p.schema!.type : "string", description: p.schema?.description || p.name }])),
    required: dyn.filter((p) => p.required).map((p) => p.name),
  };
}

/** The agent's active custom tools, or undefined when it has none. */
export async function customTools(userId: string, agentId?: string): Promise<AgentTools | undefined> {
  if (!agentId) return;
  const db = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const r = await fetch(
    `${db}/rest/v1/agent_tools?select=name,description,http_method,http_url,http_headers,http_body_template,parameters&agent_id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  ).catch(() => null);
  const tools: Tool[] = (r?.ok ? ((await r.json()) as Tool[]) : []).filter((t) => FN_NAME.test(t.name) && /^https:\/\//i.test(t.http_url ?? ""));
  if (!tools.length) return;
  return {
    defs: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || `Call ${t.name}`, parameters: schema(t) } })),
    prompt: `TOOLS. You can call these tools during the call: ${tools.map((t) => `${t.name} (${t.description || "no description"})`).join("; ")}. Collect what a tool needs from the caller first. While it runs, say only "One moment." Then tell the caller the result in plain words. Never make up a result.`,
    run: async (name, args) => {
      const t = tools.find((x) => x.name === name);
      if (!t) return `Unknown tool ${name}`;
      try {
        const { url, init } = buildRequest(t, args ?? {});
        const res = await fetch(url, init);
        const text = (await res.text()).slice(0, 2000);
        console.log(`[tool] ${name} -> ${new URL(url).host}: ${res.status}`);
        const fixed = t.http_body_template?.__staticResponse;
        if (!res.ok) return `The tool failed (HTTP ${res.status}). Tell the caller you couldn't get that right now.`;
        return typeof fixed === "string" && fixed ? fixed : text || "Done (no data returned).";
      } catch (e) {
        console.error(`[tool] ${name} failed`, (e as Error).message);
        return "The tool didn't respond. Tell the caller you couldn't get that right now.";
      }
    },
  };
}
