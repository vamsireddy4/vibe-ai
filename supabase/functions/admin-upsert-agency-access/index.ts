import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAdminEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizeAgencyEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isGmailAddress(email: string) {
  return /^[a-z0-9._%+-]+@gmail\.com$/i.test(email);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const requestBody = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "")
      : typeof requestBody?.access_token === "string"
        ? requestBody.access_token
        : "";

    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = normalizeAgencyEmail(requestBody?.email);
    if (!isGmailAddress(email)) {
      return new Response(JSON.stringify({ error: "Enter a valid Gmail address." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    const userEmail = normalizeAgencyEmail(user?.email);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isAdminEmail(userEmail)) {
      return new Response(JSON.stringify({ error: "Admin access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const wholesaleRate = requestBody?.wholesale_rate_per_minute != null 
      ? Number(requestBody.wholesale_rate_per_minute) 
      : undefined;

    const { data, error } = await supabase
      .from("agency_access_grants")
      .upsert(
        {
          email,
          is_active: true,
          granted_by: userEmail,
          ...(wholesaleRate != null && !isNaN(wholesaleRate) ? { wholesale_rate_per_minute: wholesaleRate } : {}),
        },
        { onConflict: "email" },
      )
      .select("id, email, is_active, agency_code, granted_by, created_at, updated_at, wholesale_rate_per_minute")
      .single();

    if (error) {
      throw error;
    }

    return new Response(JSON.stringify({ success: true, agency: data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to save agency access",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
