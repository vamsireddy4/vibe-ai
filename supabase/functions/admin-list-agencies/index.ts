import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAdminEmail, isAgencyEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizeAgencyEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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

    const isAgency = await isAgencyEmail(supabase, userEmail);

    if (!isAdminEmail(userEmail) && !isAgency) {
      return new Response(JSON.stringify({ error: "Admin/Agency access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supabase
      .from("agency_access_grants")
      .select("id, email, is_active, agency_code, granted_by, created_at, updated_at, client_rate_per_minute, custom_checkout_url, payment_instruction, wholesale_rate_per_minute, checkout_url_starter, checkout_url_pro, checkout_url_ultra, starter_custom_minutes, starter_custom_price, pro_custom_minutes, pro_custom_price, ultra_custom_minutes, ultra_custom_price")
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    // HIERARCHICAL FILTER: Active agency accounts see themselves and all sub-agencies they granted access to
    let filteredData = data ?? [];
    if (isAgency) {
      const { data: relations } = await supabase
        .from("agency_relationships")
        .select("child_agency_email")
        .eq("parent_agency_email", userEmail);

      const subAgencyEmails = (relations ?? []).map((r) => r.child_agency_email.toLowerCase());
      
      filteredData = (data ?? []).filter((agency) => 
        agency.email?.toLowerCase() === userEmail || subAgencyEmails.includes(agency.email?.toLowerCase())
      );
    }

    return new Response(JSON.stringify({ agencies: filteredData }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to list agencies",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
