// Runs the Supabase Edge Functions (supabase/functions, written for Deno + Supabase Auth) as Cloudflare
// Pages Functions. scripts/build-edge.mjs rewrites each function to import from here:
//   Deno.env.get(k)        -> denoEnv(k)        (Pages env, via nodejs_compat's process.env)
//   esm.sh supabase-js     -> createClient below, whose auth.getUser() accepts the app's Clerk session
import { createClient as realCreateClient } from "@supabase/supabase-js";
import { clerkEmail, verifyClerkToken } from "./clerk-token";

// The functions read the names Supabase gives them; the app's env uses the VITE_ names.
const ALIASES: Record<string, string> = {
  SUPABASE_URL: "VITE_SUPABASE_URL",
  SUPABASE_ANON_KEY: "VITE_SUPABASE_PUBLISHABLE_KEY",
  SUPABASE_PUBLISHABLE_KEY: "VITE_SUPABASE_PUBLISHABLE_KEY",
  ADMIN_EMAIL: "VITE_ADMIN_EMAIL",
};
export function denoEnv(key: string): string | undefined {
  const env = (globalThis as any).process?.env ?? {};
  return env[key] ?? (ALIASES[key] ? env[ALIASES[key]] : undefined);
}

/** Clerk id + verified email (from Clerk, see clerkEmail) for a Clerk session token, or null. */
async function clerkUser(token: string) {
  const id = token ? await verifyClerkToken(token, denoEnv("VITE_CLERK_PUBLISHABLE_KEY") ?? "") : null;
  if (!id) return null;
  const email = await clerkEmail(id, denoEnv("CLERK_SECRET_KEY") ?? "");
  return { id, email, aud: "authenticated", role: "authenticated", user_metadata: {}, app_metadata: {} };
}

/** supabase-js, except auth.getUser() verifies the Clerk token (login is Clerk; Supabase Auth has no users). */
export function createClient(url: string, key: string, options?: any) {
  const client: any = realCreateClient(url, key, options);
  const headers = options?.global?.headers ?? {};
  const headerToken = String(headers.Authorization ?? headers.authorization ?? "");
  client.auth.getUser = async (jwt?: string) => {
    const token = String(jwt ?? headerToken).replace(/^Bearer\s+/i, "").trim();
    const user = await clerkUser(token);
    return user
      ? { data: { user }, error: null }
      : { data: { user: null }, error: { name: "AuthApiError", message: "Invalid or expired session", status: 401 } };
  };
  // Some functions read the caller from getClaims(token).claims.sub instead.
  client.auth.getClaims = async (jwt?: string) => {
    const { data, error } = await client.auth.getUser(jwt);
    return data.user ? { data: { claims: { sub: data.user.id, email: data.user.email } }, error: null } : { data: null, error };
  };
  return client;
}
