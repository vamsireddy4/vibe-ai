import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isAdminEmail, isAgencyEmail } from "../_shared/admin.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALL_SPACES = ["voice", "sms", "whatsapp", "firebrand", "gmail"] as const;
type VibeSpace = typeof ALL_SPACES[number];

function normalizeEnabledSpaces(value: unknown): VibeSpace[] {
  if (!Array.isArray(value)) return ["voice"];

  const normalized = value.filter(
    (entry): entry is VibeSpace => typeof entry === "string" && ALL_SPACES.includes(entry as VibeSpace),
  );

  return normalized.length > 0 ? Array.from(new Set(normalized)) : ["voice"];
}

function normalizeRequestedSpaces(value: unknown): VibeSpace[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value.filter(
        (entry): entry is VibeSpace => typeof entry === "string" && ALL_SPACES.includes(entry as VibeSpace),
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

    const clientUserId = typeof requestBody?.client_user_id === "string" ? requestBody.client_user_id.trim() : "";
    const clientEmail = typeof requestBody?.client_email === "string" ? requestBody.client_email.trim().toLowerCase() : "";
    const enabledSpaces = normalizeEnabledSpaces(requestBody?.enabled_spaces);

    if (!clientUserId) {
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
    const adminFlag = isAdminEmail(userEmail);

    if (!adminFlag && !isAgency) {
      return new Response(JSON.stringify({ error: "Admin/Agency access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Agency operators (non-admins) may only modify clients that belong to them or
    // to a sub-agency they parent. Without this, any agency could edit any client.
    if (!adminFlag) {
      const accessibleAgencyEmails = [userEmail || ""];
      const { data: relations } = await supabase
        .from("agency_relationships")
        .select("child_agency_email")
        .eq("parent_agency_email", userEmail);
      if (relations) {
        for (const r of relations) {
          if (r.child_agency_email) accessibleAgencyEmails.push(String(r.child_agency_email).toLowerCase());
        }
      }

      const agencyCodes: string[] = [];
      const { data: agencyGrants } = await supabase
        .from("agency_access_grants")
        .select("agency_code")
        .in("email", accessibleAgencyEmails);
      if (agencyGrants) {
        for (const g of agencyGrants) {
          if (g.agency_code) agencyCodes.push(String(g.agency_code).trim().toUpperCase());
        }
      }

      let ownershipQuery = supabase
        .from("client_details")
        .select("user_id")
        .eq("user_id", clientUserId);
      if (agencyCodes.length > 0) {
        ownershipQuery = ownershipQuery.or(
          `agency_email.in.(${accessibleAgencyEmails.map((e) => `"${e}"`).join(",")}),agency_code.in.(${agencyCodes.map((c) => `"${c}"`).join(",")})`,
        );
      } else {
        ownershipQuery = ownershipQuery.in("agency_email", accessibleAgencyEmails);
      }

      const { data: ownedClient } = await ownershipQuery.maybeSingle();
      if (!ownedClient) {
        return new Response(JSON.stringify({ error: "Unauthorized access to this client" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: directUser, error: directUserError } = await supabase.auth.admin.getUserById(clientUserId);
    if (directUserError && directUserError.status !== 404) {
      throw directUserError;
    }

    let authUser = directUser?.user ?? null;

    if (!authUser) {
      const usersResult = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersResult.error) {
        throw usersResult.error;
      }

      authUser =
        (usersResult.data.users ?? []).find((account) =>
          account.id === clientUserId || (clientEmail && account.email?.toLowerCase() === clientEmail),
        ) ?? null;
    }

    if (!authUser) {
      return new Response(JSON.stringify({ error: "Client user not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const currentMetadata = authUser.user_metadata ?? {};
    const requestedSpaces = normalizeRequestedSpaces(currentMetadata.magicteams_requested_spaces);
    const nextRequestedSpaces = requestedSpaces.filter((space) => !enabledSpaces.includes(space));

    const updateResult = await supabase.auth.admin.updateUserById(authUser.id, {
      user_metadata: {
        ...currentMetadata,
        magicteams_enabled_spaces: enabledSpaces,
        magicteams_requested_spaces: nextRequestedSpaces,
        magicteams_spaces_updated_at: new Date().toISOString(),
      },
    });

    if (updateResult.error) {
      throw updateResult.error;
    }

    if (isAdminEmail(userEmail)) {
      if (requestBody.hasOwnProperty("agency_code") || requestBody.hasOwnProperty("agency_email")) {
        let targetAgencyCode = typeof requestBody.agency_code === "string" && requestBody.agency_code.trim()
          ? requestBody.agency_code.trim().toUpperCase()
          : null;
        
        let targetAgencyEmail = typeof requestBody.agency_email === "string" && requestBody.agency_email.trim()
          ? requestBody.agency_email.trim().toLowerCase()
          : null;

        // If agency_code is provided, resolve the email from the database to keep both fields synced
        if (targetAgencyCode) {
          const { data: grant } = await supabase
            .from("agency_access_grants")
            .select("email")
            .eq("agency_code", targetAgencyCode)
            .maybeSingle();
          if (grant?.email) {
            targetAgencyEmail = grant.email.toLowerCase();
          }
        } else if (targetAgencyEmail) {
          // If agency_email is provided but agency_code is not, resolve the code from the database
          const { data: grant } = await supabase
            .from("agency_access_grants")
            .select("agency_code")
            .eq("email", targetAgencyEmail)
            .maybeSingle();
          if (grant?.agency_code) {
            targetAgencyCode = grant.agency_code.toUpperCase();
          }
        }

        const { error: profileUpdateError } = await supabase
          .from("profiles")
          .update({
            agency_code: targetAgencyCode,
            agency_email: targetAgencyEmail,
          })
          .eq("user_id", clientUserId);

        if (profileUpdateError) {
          throw profileUpdateError;
        }
      }
    }

    return new Response(JSON.stringify({ success: true, enabled_spaces: enabledSpaces }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to update client spaces",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
