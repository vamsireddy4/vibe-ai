// Calling minutes (user_minute_balances), server side only: service role key, never the browser.
// Shared by the voice agent (which enforces them on every call) and the app's /api/local/minutes route.

/** Every new user gets this once: their first balance row is created with it, never again. */
export const FREE_SECONDS = 10 * 60;

type Db = { supabaseUrl: string; serviceRoleKey: string };
const headers = (db: Db) => ({ apikey: db.serviceRoleKey, Authorization: `Bearer ${db.serviceRoleKey}`, "Content-Type": "application/json" });

/** Seconds left for this user. Creates their balance with the free minutes the first time (once per user, ever). */
export async function ensureBalance(userId: string, db: Db): Promise<number> {
  const rest = `${db.supabaseUrl}/rest/v1`;
  // Insert-if-absent: user_id is unique, so a second insert is ignored and can't top the balance up again.
  const created = await fetch(`${rest}/user_minute_balances?on_conflict=user_id`, {
    method: "POST",
    headers: { ...headers(db), Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ user_id: userId, available_seconds: FREE_SECONDS }),
  });
  const rows = await created.json().catch(() => []);
  if (created.ok && Array.isArray(rows) && rows.length) {
    await fetch(`${rest}/minute_transactions`, {
      method: "POST",
      headers: { ...headers(db), Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, kind: "signup_credit", source: "free_trial", seconds_delta: FREE_SECONDS, notes: "10 free minutes for new users" }),
    }).catch(() => undefined);
    return FREE_SECONDS;
  }
  const r = await fetch(`${rest}/user_minute_balances?select=available_seconds&user_id=eq.${encodeURIComponent(userId)}&limit=1`, { headers: headers(db) });
  const data = await r.json().catch(() => []);
  if (!r.ok || !Array.isArray(data) || !data.length) throw new Error("Could not read your minutes balance.");
  return Math.max(0, Number(data[0].available_seconds) || 0);
}

/** Take used seconds off the balance (atomic in Postgres, never below zero). Returns seconds actually taken. */
export async function deductSeconds(userId: string, seconds: number, kind: "demo_deduction" | "live_deduction", db: Db): Promise<number> {
  const used = Math.ceil(Math.max(0, seconds));
  if (!used) return 0;
  const r = await fetch(`${db.supabaseUrl}/rest/v1/rpc/deduct_minute_balance`, {
    method: "POST",
    headers: headers(db),
    body: JSON.stringify({ p_user_id: userId, p_seconds: used }),
  });
  const taken = Number(await r.json().catch(() => 0)) || 0;
  if (taken) {
    await fetch(`${db.supabaseUrl}/rest/v1/minute_transactions`, {
      method: "POST",
      headers: { ...headers(db), Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, kind, source: "voice_agent", seconds_delta: -taken }),
    }).catch(() => undefined);
  }
  return taken;
}

/** POST /api/local/minutes -> { availableSeconds } for the signed-in caller (creating the free minutes on first visit). */
export async function minutesHandle(_body: unknown, callerId: string | null, db: Db) {
  if (!callerId) return { status: 401, body: { error: "Sign in again." } };
  try {
    return { status: 200, body: { availableSeconds: await ensureBalance(callerId, db) } };
  } catch (e) {
    return { status: 502, body: { error: (e as Error).message } };
  }
}
