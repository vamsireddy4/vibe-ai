// /fn/<name>: the app's Supabase Edge Functions, run here on Cloudflare (see scripts/build-edge.mjs and
// server/edge-shim.ts). The app points supabase.functions at this path in production.
import { handlers } from "../../server/edge/registry";

type Ctx = { request: Request; params: { name: string }; waitUntil: (p: Promise<unknown>) => void };

export const onRequest = async ({ request, params, waitUntil }: Ctx) => {
  const load = handlers[params.name];
  if (!load) return new Response(JSON.stringify({ error: `Unknown function ${params.name}` }), { status: 404, headers: { "Content-Type": "application/json" } });
  // Some functions finish work in the background via Supabase's EdgeRuntime.waitUntil.
  (globalThis as any).EdgeRuntime = { waitUntil };
  const { default: handler } = await load();
  if (typeof handler !== "function") return new Response(JSON.stringify({ error: `${params.name} has no handler` }), { status: 500 });
  return handler(request);
};
