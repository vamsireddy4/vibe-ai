import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAdminEmail, isAgencyEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    const userEmail = user?.email?.toLowerCase() || null;

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

    const targetChildAgency = typeof requestBody?.child_agency_email === "string"
      ? requestBody.child_agency_email.trim().toLowerCase()
      : "";

    // Strict format: the email is later interpolated into PostgREST .or() filters
    // (agency_email.in.("...")), so quotes/commas/parens would allow filter injection.
    if (!targetChildAgency || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(targetChildAgency)) {
      return new Response(JSON.stringify({ error: "A valid child_agency_email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Privilege-escalation guards for non-admin (agency) callers: an agency may
    // create sub-agencies, but must not grant agency access to an admin account
    // or to itself. Admins bypass these guards.
    if (!isAdminEmail(userEmail)) {
      if (isAdminEmail(targetChildAgency)) {
        return new Response(JSON.stringify({ error: "Cannot grant agency access to an admin account" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (targetChildAgency === (userEmail || "").trim().toLowerCase()) {
        return new Response(JSON.stringify({ error: "Cannot grant agency access to yourself" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // An agency must not claim an existing agency it did not create: becoming its
      // "parent" would expose all of that agency's clients and balances.
      const { data: existingGrant } = await supabase
        .from("agency_access_grants")
        .select("id")
        .eq("email", targetChildAgency)
        .maybeSingle();
      if (existingGrant) {
        const { data: existingRelation } = await supabase
          .from("agency_relationships")
          .select("child_agency_email")
          .eq("parent_agency_email", userEmail)
          .eq("child_agency_email", targetChildAgency)
          .maybeSingle();
        if (!existingRelation) {
          return new Response(JSON.stringify({ error: "This email already has agency access" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const wholesaleRate = requestBody?.wholesale_rate_per_minute != null 
      ? Number(requestBody.wholesale_rate_per_minute) 
      : undefined;

    // 1. Insert into agency_access_grants so the sub-agency is marked active
    const { error: accessError } = await supabase
      .from("agency_access_grants")
      .upsert({
        email: targetChildAgency,
        is_active: true,
        granted_by: userEmail,
        ...(wholesaleRate != null && !isNaN(wholesaleRate) ? { wholesale_rate_per_minute: wholesaleRate } : {}),
      }, { onConflict: "email" });

    if (accessError) {
      throw accessError;
    }

    // 2. Insert relationship into agency_relationships mapping table
    const { error: grantError } = await supabase
      .from("agency_relationships")
      .upsert({
        parent_agency_email: userEmail,
        child_agency_email: targetChildAgency,
      }, { onConflict: "parent_agency_email,child_agency_email" });

    if (grantError) {
      throw grantError;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to grant agency access",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
