// Live check of the free-minutes rules against the real DB (throwaway user, cleaned up after).
// Run: npx tsx --env-file=.env scripts/check-minutes.mts
import assert from "node:assert";
import { ensureBalance, deductSeconds, FREE_SECONDS } from "../server/minutes.ts";
const db = { supabaseUrl: process.env.VITE_SUPABASE_URL!, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY! };
const u = "user_probeMinutesCheck01";
const h = { apikey: db.serviceRoleKey, Authorization: `Bearer ${db.serviceRoleKey}` };
const clean = () => Promise.all(["user_minute_balances", "minute_transactions"].map((t) => fetch(`${db.supabaseUrl}/rest/v1/${t}?user_id=eq.${u}`, { method: "DELETE", headers: h })));
await clean();
try {
  assert.equal(await ensureBalance(u, db), FREE_SECONDS, "first visit gets 7 free minutes");
  assert.equal(await ensureBalance(u, db), FREE_SECONDS, "second visit does NOT add more");
  assert.equal(await deductSeconds(u, 29.2, "demo_deduction", db), 30, "rounds used seconds up");
  assert.equal(await ensureBalance(u, db), FREE_SECONDS - 30);
  assert.equal(await deductSeconds(u, 9999, "demo_deduction", db), FREE_SECONDS - 30, "never below zero");
  assert.equal(await ensureBalance(u, db), 0, "used up stays at 0 (no re-grant)");
  console.log("minutes probe: all checks passed");
} finally { await clean(); }
