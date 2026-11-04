import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getPrimaryAdminEmail, isAdminEmail, isAgencyEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAIL = getPrimaryAdminEmail();
const ALL_SPACES = ["voice", "sms", "whatsapp", "firebrand", "gmail"] as const;

function normalizeEnabledSpaces(value: unknown) {
  if (!Array.isArray(value)) return ["voice"];
  const normalized = value.filter(
    (entry): entry is typeof ALL_SPACES[number] => typeof entry === "string" && ALL_SPACES.includes(entry as typeof ALL_SPACES[number]),
  );
  return normalized.length > 0 ? Array.from(new Set(normalized)) : ["voice"];
}

function normalizeRequestedSpaces(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (entry): entry is typeof ALL_SPACES[number] => typeof entry === "string" && ALL_SPACES.includes(entry as typeof ALL_SPACES[number]),
      ),
    ),
  );
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

    // 1. Build an array of accessible agency emails (hierarchical access check)
    const accessibleAgencyEmails = [userEmail];
    if (isAgency) {
      const { data: relations } = await supabase
        .from("agency_relationships")
        .select("child_agency_email")
        .eq("parent_agency_email", userEmail);

      if (relations) {
        relations.forEach(r => accessibleAgencyEmails.push(r.child_agency_email.toLowerCase()));
      }
    }

    // Retrieve agency_codes mapping to these accessible agency emails
    const agencyCodes: string[] = [];
    if (isAgency) {
      const { data: agencyGrants } = await supabase
        .from("agency_access_grants")
        .select("agency_code")
        .in("email", accessibleAgencyEmails);
      
      if (agencyGrants) {
        agencyGrants.forEach(g => {
          if (g.agency_code) {
            agencyCodes.push(g.agency_code.trim().toUpperCase());
          }
        });
      }
    }

    // 2. Query clients directly from client_details view (database-level filtering)
    let query = supabase
      .from("client_details")
      .select("user_id, email, full_name, company_name, agency_email, agency_code, raw_user_meta_data");

    if (isAgency) {
      if (agencyCodes.length > 0) {
        query = query.or(`agency_email.in.(${accessibleAgencyEmails.map(e => `"${e}"`).join(',')}),agency_code.in.(${agencyCodes.map(c => `"${c}"`).join(',')})`);
      } else {
        query = query.in("agency_email", accessibleAgencyEmails);
      }
    }

    const { data: clientDetails, error: clientDetailsError } = await query;
    if (clientDetailsError) throw clientDetailsError;

    // 3. Fetch respective balances safely restricted to these matching user IDs
    const profileUserIds = (clientDetails ?? []).map((c) => c.user_id);
    let balanceQuery = supabase
      .from("user_minute_balances")
      .select("user_id, available_seconds, enterprise_rate_per_minute, last_enterprise_amount, last_enterprise_minutes");

    if (isAgency && profileUserIds.length > 0) {
      balanceQuery = balanceQuery.in("user_id", profileUserIds);
    }

    const { data: balances, error: balancesError } = await balanceQuery;
    if (balancesError) throw balancesError;

    const balanceMap = new Map((balances ?? []).map((b) => [b.user_id, b]));

    // 4. Map clients to payload
    const clients = (clientDetails ?? [])
      .map((client) => {
        if (!client.email || isAdminEmail(client.email)) {
          return null;
        }
        const metadata = client.raw_user_meta_data ?? {};
        const balance = balanceMap.get(client.user_id);
        return {
          user_id: client.user_id,
          email: client.email,
          full_name: client.full_name ?? (typeof metadata.full_name === "string" ? metadata.full_name : null),
          company_name: client.company_name ?? null,
          enabled_spaces: normalizeEnabledSpaces(metadata.magicteams_enabled_spaces),
          requested_spaces: normalizeRequestedSpaces(metadata.magicteams_requested_spaces),
          enterprise_interest: Boolean(metadata.enterprise_interest),
          available_seconds: balance?.available_seconds ?? 0,
          enterprise_rate_per_minute: balance?.enterprise_rate_per_minute ?? null,
          last_enterprise_amount: balance?.last_enterprise_amount ?? null,
          last_enterprise_minutes: balance?.last_enterprise_minutes ?? null,
          agency_email: client.agency_email ?? null,
          agency_code: client.agency_code ?? null,
        };
      })
      .filter((client): client is NonNullable<typeof client> => client !== null)
      .sort((a, b) => {
        if (a.enterprise_interest !== b.enterprise_interest) {
          return a.enterprise_interest ? -1 : 1;
        }
        return a.email.localeCompare(b.email);
      });

    return new Response(JSON.stringify({ clients }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to list clients",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
