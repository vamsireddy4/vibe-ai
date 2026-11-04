// Cloudflare Pages Functions glue: Pages env -> the shared server/ handlers (same ones the Vite dev server runs).
import { getCaller } from "./clerk-token";

export type PagesEnv = Record<string, string | undefined>;
export type PagesContext = { request: Request; env: PagesEnv };

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The signed-in caller from the request's Clerk Bearer token, or null. */
export const callerOf = (request: Request, env: PagesEnv) =>
  getCaller(request.headers.get("Authorization"), {
    publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY ?? "",
    clerkSecretKey: env.CLERK_SECRET_KEY ?? "",
  });

/** POST route: JSON body + verified caller id in, the handler's {status, body} out. */
export const sharedRoute =
  (handle: (body: any, callerId: string | null, origin: string, env: PagesEnv) => Promise<{ status: number; body: unknown }>) =>
  async ({ request, env }: PagesContext) => {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    const body = await request.json().catch(() => null);
    if (!body) return json(400, { error: "Invalid request" });
    const caller = await callerOf(request, env);
    const out = await handle(body, caller?.id ?? null, new URL(request.url).origin, env);
    return json(out.status, out.body);
  };
