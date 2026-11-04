// Clerk session check for the server routes (Vite dev middleware locally, Cloudflare Pages Functions in production).
// Login is Clerk, so Supabase Auth can't identify callers. Verify the Clerk session JWT ourselves
// (RS256 against Clerk's published keys). Web Crypto only, so the same code runs in Node and Workers.
const clerkKeys = new Map<string, Awaited<ReturnType<typeof crypto.subtle.importKey>>>();

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

function clerkFrontendApi(publishableKey: string) {
  // pk_test_<base64("new-cobra-3523.clerk.accounts.dev$")>
  return atob(publishableKey.split("_")[2] ?? "").replace(/\$$/, "");
}

/** The Clerk user id in a valid, unexpired session token from this Clerk instance; otherwise null. */
export async function verifyClerkToken(token: string, publishableKey: string, now = Date.now() / 1000): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !publishableKey) return null;
  const [h, p, sig] = parts;
  let header: { alg?: string; kid?: string };
  let payload: { sub?: string; exp?: number; nbf?: number; iss?: string };
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const issuer = `https://${clerkFrontendApi(publishableKey)}`;
  if (payload.iss !== issuer) return null;
  if (typeof payload.exp !== "number" || payload.exp < now - 5) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 5) return null;

  if (!clerkKeys.has(header.kid)) {
    const jwks = (await fetch(`${issuer}/.well-known/jwks.json`).then((r) => r.json()).catch(() => ({ keys: [] }))) as { keys?: { kid: string; kty?: string; n?: string; e?: string }[] };
    for (const jwk of jwks.keys ?? []) {
      const key = await crypto.subtle
        .importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
        .catch(() => null);
      if (key) clerkKeys.set(jwk.kid, key);
    }
  }
  const key = clerkKeys.get(header.kid);
  if (!key) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    return null;
  }
  return ok && typeof payload.sub === "string" ? payload.sub : null;
}

/**
 * The user's verified primary email, from Clerk itself (never from profiles: users can edit their own
 * profile row, and admin/agency access is decided by email). Cached per isolate.
 */
const emailCache = new Map<string, string>();
export async function clerkEmail(userId: string, clerkSecretKey: string): Promise<string> {
  if (emailCache.has(userId)) return emailCache.get(userId)!;
  if (!clerkSecretKey) return "";
  const u: any = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${clerkSecretKey}` } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const primary = u?.email_addresses?.find((e: any) => e.id === u.primary_email_address_id);
  const email = primary?.verification?.status === "verified" ? String(primary.email_address).toLowerCase() : "";
  if (email) emailCache.set(userId, email);
  return email;
}

/**
 * Verified caller from an `Authorization: Bearer <Clerk token>` header, or null. `email` is Clerk's verified
 * primary email, or "" when it can't be looked up (no CLERK_SECRET_KEY): email-based checks (admin) then fail closed.
 */
export async function getCaller(
  authorization: string | null | undefined,
  env: { publishableKey: string; clerkSecretKey: string },
): Promise<{ id: string; email: string } | null> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const id = token ? await verifyClerkToken(token, env.publishableKey) : null;
  if (!id) return null;
  return { id, email: await clerkEmail(id, env.clerkSecretKey) };
}
