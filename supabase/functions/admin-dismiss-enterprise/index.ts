import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getPrimaryAdminEmail, isAdminEmail, isAgencyEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAIL = getPrimaryAdminEmail();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    const requestBody = await req.json();
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

    const { client_user_id } = requestBody;
    if (!client_user_id) {
      return new Response(JSON.stringify({ error: "client_user_id is required" }), {
        status: 400,
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
    const isAdmin = isAdminEmail(userEmail);

    if (!isAdmin && !isAgency) {
      return new Response(JSON.stringify({ error: "Admin or Agency access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Helper function to verify client refers to the active agency
    const verifyClientBelongsToAgency = async (agencyEmail: string, clientUserId: string): Promise<boolean> => {
      const accessibleAgencyEmails = [agencyEmail];
      const { data: relations } = await supabase
        .from("agency_relationships")
        .select("child_agency_email")
        .eq("parent_agency_email", agencyEmail);

      if (relations) {
        relations.forEach((r: any) => accessibleAgencyEmails.push(r.child_agency_email.toLowerCase()));
      }

      const agencyCodes: string[] = [];
      const { data: agencyGrants } = await supabase
        .from("agency_access_grants")
        .select("agency_code")
        .in("email", accessibleAgencyEmails);
      
      if (agencyGrants) {
        agencyGrants.forEach((g: any) => {
          if (g.agency_code) {
            agencyCodes.push(g.agency_code.trim().toUpperCase());
          }
        });
      }

      let query = supabase
        .from("client_details")
        .select("user_id")
        .eq("user_id", clientUserId);

      if (agencyCodes.length > 0) {
        query = query.or(`agency_email.in.(${accessibleAgencyEmails.map(e => `"${e}"`).join(',')}),agency_code.in.(${agencyCodes.map(c => `"${c}"`).join(',')})`);
      } else {
        query = query.in("agency_email", accessibleAgencyEmails);
      }

      const { data, error } = await query.maybeSingle();
      if (error || !data) {
        return false;
      }
      return true;
    };

    if (isAgency && !isAdmin) {
      const belongs = await verifyClientBelongsToAgency(userEmail || "", client_user_id);
      if (!belongs) {
        return new Response(JSON.stringify({ error: "Unauthorized access to this client" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(client_user_id);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentMetadata = userData.user.user_metadata ?? {};
    const nextMetadata = {
      ...currentMetadata,
      enterprise_interest: false,
      enterprise_dismissed_by: userEmail || ADMIN_EMAIL,
      enterprise_dismissed_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase.auth.admin.updateUserById(client_user_id, {
      user_metadata: nextMetadata,
    });

    if (updateError) {
      throw updateError;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to dismiss enterprise request",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
