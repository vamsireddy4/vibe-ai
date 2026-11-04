function sanitizeEmailValue(value: string) {
  return value.trim().replace(/^['"]+|['"]+$/g, "").toLowerCase();
}

export function getAdminEmails() {
  // VITE_-prefixed vars are browser build-time only and are never present in the
  // Deno edge runtime, so they were dead. Configure ADMIN_EMAILS (comma-separated)
  // or ADMIN_EMAIL as a Supabase function secret in production.
  const configured =
    Deno.env.get("ADMIN_EMAILS") ||
    Deno.env.get("ADMIN_EMAIL") ||
    "saphaarelabs@gmail.com";

  return configured
    .split(",")
    .map(sanitizeEmailValue)
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined) {
  const normalized = sanitizeEmailValue(String(email || ""));
  if (!normalized) return false;
  return getAdminEmails().includes(normalized);
}

export function getPrimaryAdminEmail() {
  return getAdminEmails()[0] || "saphaarelabs@gmail.com";
}

export async function isAgencyEmail(supabase: any, email: string | null | undefined) {
  const normalized = sanitizeEmailValue(String(email || ""));
  if (!normalized) return false;

  const { data, error } = await supabase
    .from("agency_access_grants")
    .select("is_active")
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    console.error("Error checking agency access:", error);
    return false;
  }

  return Boolean(data?.is_active);
}

