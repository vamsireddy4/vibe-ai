import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath) {
  const envText = fs.readFileSync(filePath, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function hasFinalUserUtterance(transcript) {
  if (!Array.isArray(transcript)) return false;
  return transcript.some((item) => {
    if (!item || typeof item !== "object") return false;
    const speaker = String(item.speaker || "").trim().toLowerCase();
    const text = String(item.text || "").trim();
    const isFinal = item.isFinal !== false;
    return speaker === "user" && isFinal && text.length >= 2;
  });
}

async function sbFetch(url, init = {}) {
  const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  };
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  loadDotEnv(path.join(process.cwd(), ".env"));
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const callLogs = await sbFetch(
    `${supabaseUrl}/rest/v1/call_logs?direction=eq.demo&billing_status=eq.charged&select=id,user_id,billed_seconds,billed_amount,billed_rate_per_minute,transcript&order=started_at.desc&limit=500`,
  );

  const refundCandidates = callLogs.filter((row) => !hasFinalUserUtterance(row.transcript) && Number(row.billed_seconds || 0) > 0);

  if (refundCandidates.length === 0) {
    console.log(JSON.stringify({ refunded: 0, refundedSeconds: 0, candidates: [] }, null, 2));
    return;
  }

  let refundedSeconds = 0;
  const refunded = [];

  for (const row of refundCandidates) {
    const billedSeconds = Math.max(0, Number(row.billed_seconds || 0));
    const billedAmount = Number(row.billed_amount || 0);
    const rate = Number(row.billed_rate_per_minute || 0) || null;

    const existingRefunds = await sbFetch(
      `${supabaseUrl}/rest/v1/minute_transactions?call_log_id=eq.${row.id}&kind=eq.admin_credit&select=id,seconds_delta,notes`,
    );
    const alreadyRefunded = Array.isArray(existingRefunds) && existingRefunds.some((tx) =>
      String(tx.notes || "").includes("Refund for non-billable demo session"),
    );
    if (alreadyRefunded) continue;

    const balances = await sbFetch(
      `${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${row.user_id}&select=user_id,available_seconds`,
    );
    const balance = Array.isArray(balances) ? balances[0] : null;
    if (!balance) {
      throw new Error(`No minute balance row found for user ${row.user_id}`);
    }

    const nextAvailableSeconds = Math.max(0, Number(balance.available_seconds || 0)) + billedSeconds;

    await sbFetch(
      `${supabaseUrl}/rest/v1/user_minute_balances?user_id=eq.${row.user_id}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ available_seconds: nextAvailableSeconds }),
      },
    );

    await sbFetch(
      `${supabaseUrl}/rest/v1/minute_transactions`,
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: row.user_id,
          call_log_id: row.id,
          kind: "admin_credit",
          source: "standard",
          seconds_delta: billedSeconds,
          rate_per_minute: rate,
          amount: billedAmount,
          notes: "Refund for non-billable demo session",
        }),
      },
    );

    await sbFetch(
      `${supabaseUrl}/rest/v1/call_logs?id=eq.${row.id}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          billing_status: "refunded",
          billing_source: "refund_nonbillable_demo",
          billed_amount: 0,
          billed_minutes: 0,
          billed_rate_per_minute: 0,
          billed_seconds: 0,
        }),
      },
    );

    refundedSeconds += billedSeconds;
    refunded.push({
      callLogId: row.id,
      userId: row.user_id,
      refundedSeconds: billedSeconds,
    });
  }

  console.log(JSON.stringify({
    refunded: refunded.length,
    refundedSeconds,
    refundedMinutesFloor: Math.floor(refundedSeconds / 60),
    candidates: refunded,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
