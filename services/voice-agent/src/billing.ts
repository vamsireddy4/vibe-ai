/**
 * Calling minutes, enforced here because every call (phone and browser demo) runs through this service.
 * No minutes left -> the call doesn't start. Minutes run out mid-call -> the call is ended.
 * The used seconds come off the balance when the call ends. The admin account is never metered.
 */
import { deductSeconds, ensureBalance } from "../../../server/minutes.js";
import { clerkEmail } from "../../../server/clerk-token.js";

// Read per call: on Cloudflare, process.env comes from the Worker's secrets.
const dbEnv = () => ({ supabaseUrl: process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "", serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" });
export const NO_MINUTES = "Your free minutes are used up. Add minutes to keep making calls.";

async function isAdmin(userId: string) {
  // Clerk's verified email, never profiles (users can edit their own profile row). No CLERK_SECRET_KEY: nobody is admin.
  const ADMIN_EMAIL = (process.env.VITE_ADMIN_EMAIL ?? "").trim().toLowerCase();
  return Boolean(ADMIN_EMAIL) && (await clerkEmail(userId, process.env.CLERK_SECRET_KEY ?? "")) === ADMIN_EMAIL;
}

/** Seconds this user may talk (Infinity for the admin), or an error to show instead of starting the call. */
export async function allowance(userId: string): Promise<{ seconds: number } | { error: string }> {
  const db = dbEnv();
  if (!db.supabaseUrl || !db.serviceRoleKey) return { error: "Minutes can't be checked: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing." };
  try {
    if (await isAdmin(userId)) return { seconds: Infinity };
    const seconds = await ensureBalance(userId, db);
    return seconds > 0 ? { seconds } : { error: NO_MINUTES };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Meter one connected call: `onExhausted` fires when the allowance runs out; `stop()` (call it once, when
 * the call ends) deducts the seconds used. ponytail: two calls at once each get the whole remaining balance;
 * the deduction is atomic and floors at zero, so the overrun is at most one call's length.
 */
export function meter(userId: string, seconds: number, kind: "demo_deduction" | "live_deduction", onExhausted: () => void) {
  const started = Date.now();
  const timer = Number.isFinite(seconds) ? setTimeout(onExhausted, seconds * 1000) : undefined;
  let stopped = false;
  return {
    /** `usedSeconds`: the provider's own call length when known (e.g. Twilio's CallDuration); else wall time. */
    stop(usedSeconds?: number) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (!Number.isFinite(seconds)) return; // admin: unmetered
      const used = usedSeconds ?? (Date.now() - started) / 1000;
      return deductSeconds(userId, Math.min(used, seconds), kind, dbEnv()).catch((e) => { console.error("minute deduction failed", e); return 0; });
    },
  };
}
