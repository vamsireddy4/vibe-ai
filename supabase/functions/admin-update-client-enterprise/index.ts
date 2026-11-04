import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { creditEnterpriseMinutes, ensureMinuteBalance } from "../_shared/minute-balance.ts";
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

    const { client_user_id } = requestBody;
    if (!client_user_id) {
      return new Response(JSON.stringify({ error: "client_user_id is required" }), {
        status: 400,
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

    // 1. If it's an Agency, we perform a minute TRANSFER
    if (isAgency && !isAdmin) {
      // Verify client belongs to this agency
      const belongs = await verifyClientBelongsToAgency(userEmail || "", client_user_id);
      if (!belongs) {
        return new Response(JSON.stringify({ error: "Unauthorized access to this client" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const minutesToTransfer = Number(requestBody.minutes_to_transfer);
      if (!Number.isInteger(minutesToTransfer) || minutesToTransfer <= 0) {
        return new Response(JSON.stringify({ error: "minutes_to_transfer must be a valid positive integer" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Check agency's own balance
      const agencyBalance = await ensureMinuteBalance(supabase, user.id);
      const agencyAvailableSeconds = agencyBalance.available_seconds || 0;
      const secondsToTransfer = minutesToTransfer * 60;

      if (agencyAvailableSeconds < secondsToTransfer) {
        const availableMinutes = Math.floor(agencyAvailableSeconds / 60);
        return new Response(
          JSON.stringify({ 
            error: `Insufficient minutes. You only have ${availableMinutes} minutes available in your agency account.` 
          }), 
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Deduct from agency atomically. The RPC locks the row and never goes below
      // zero, so two concurrent transfers cannot both pass the balance check and
      // double-spend. It returns the seconds actually deducted.
      const { data: deductedSeconds, error: deductError } = await supabase.rpc("deduct_minute_balance", {
        p_user_id: user.id,
        p_seconds: secondsToTransfer,
      });

      if (deductError) throw deductError;

      if (Number(deductedSeconds ?? 0) < secondsToTransfer) {
        // Lost the race — another transfer drained the balance first. Refund what we
        // took (if any) and report insufficient funds.
        if (Number(deductedSeconds ?? 0) > 0) {
          await supabase.rpc("increment_minute_balance", {
            p_user_id: user.id,
            p_seconds: Number(deductedSeconds),
          });
        }
        return new Response(
          JSON.stringify({ error: "Insufficient minutes. Your agency balance changed — please retry." }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Add to client atomically.
      const clientBalance = await ensureMinuteBalance(supabase, client_user_id);
      const { data: nextClientSeconds, error: addError } = await supabase.rpc("increment_minute_balance", {
        p_user_id: client_user_id,
        p_seconds: secondsToTransfer,
      });

      if (addError) throw addError;

      const parsedRate = requestBody.enterprise_rate_per_minute ? Number(requestBody.enterprise_rate_per_minute) : null;
      const parsedAmount = requestBody.purchase_amount ? Number(requestBody.purchase_amount) : null;

      // Rate metadata is last-write-wins (not additive), so a plain update is correct.
      const metaUpdate: Record<string, any> = {};
      if (parsedRate !== null && !isNaN(parsedRate)) metaUpdate.enterprise_rate_per_minute = parsedRate;
      if (parsedAmount !== null && !isNaN(parsedAmount)) {
        metaUpdate.last_enterprise_amount = parsedAmount;
        metaUpdate.last_enterprise_minutes = minutesToTransfer;
      }
      if (Object.keys(metaUpdate).length > 0) {
        const { error: metaError } = await supabase
          .from("user_minute_balances")
          .update(metaUpdate)
          .eq("user_id", client_user_id);
        if (metaError) throw metaError;
      }

      const effectiveRate = parsedRate ?? clientBalance.enterprise_rate_per_minute ?? 0.1;
      const effectiveAmount = parsedAmount ?? 0;

      // Log transactions — surface insert failures instead of silently dropping the
      // audit trail after the balances have already moved.
      const [txOut, txIn] = await Promise.all([
        supabase.from("minute_transactions").insert({
          user_id: user.id,
          kind: "agency_transfer_out",
          source: "agency",
          seconds_delta: -secondsToTransfer,
          rate_per_minute: agencyBalance.enterprise_rate_per_minute ?? 0.1,
          amount: 0,
          notes: `Transferred to client (ID: ${client_user_id})`,
        }),
        supabase.from("minute_transactions").insert({
          user_id: client_user_id,
          kind: "agency_transfer_in",
          source: "agency",
          seconds_delta: secondsToTransfer,
          rate_per_minute: effectiveRate,
          amount: effectiveAmount,
          notes: `Received transfer from agency (${userEmail})`,
        })
      ]);

      if (txOut.error || txIn.error) {
        throw txOut.error || txIn.error;
      }

      const credit = {
        creditedMinutes: minutesToTransfer,
        creditedSeconds: secondsToTransfer,
        availableSeconds: Number(nextClientSeconds ?? 0),
        ratePerMinute: effectiveRate,
        purchaseAmount: effectiveAmount,
      };

      // Clear client's enterprise_interest metadata
      let updatedUser: any = null;
      const { data: userData } = await supabase.auth.admin.getUserById(client_user_id);
      if (userData?.user) {
        const currentMetadata = userData.user.user_metadata ?? {};
        const nextMetadata = {
          ...currentMetadata,
          enterprise_interest: false,
          enterprise_updated_by: userEmail,
          enterprise_updated_at: new Date().toISOString(),
        };

        const updateResult = await supabase.auth.admin.updateUserById(client_user_id, {
          user_metadata: nextMetadata,
        });

        if (!updateResult.error) {
          updatedUser = updateResult.data?.user ?? null;
        }
      }

      return new Response(JSON.stringify({ success: true, user: updatedUser, credit }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. If it's a Super Admin, perform standard enterprise minting
    const { enterprise_rate_per_minute, purchase_amount } = requestBody;

    // Admin "Minutes to Add" with no price: credit those minutes straight to the client's balance.
    const minutesToAdd = Number(requestBody.minutes_to_transfer);
    if ((enterprise_rate_per_minute == null || purchase_amount == null) && Number.isFinite(minutesToAdd) && minutesToAdd > 0) {
      const seconds = Math.round(minutesToAdd * 60);
      const { data: availableSeconds, error: creditError } = await supabase.rpc("increment_minute_balance", { p_user_id: client_user_id, p_seconds: seconds });
      if (creditError) throw creditError;
      await supabase.from("minute_transactions").insert({
        user_id: client_user_id, kind: "admin_credit", source: "admin_dashboard", seconds_delta: seconds,
        notes: `Added by ${userEmail || ADMIN_EMAIL}`,
      });
      return new Response(JSON.stringify({ success: true, user: null, credit: { creditedMinutes: Math.round(minutesToAdd), availableSeconds } }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (enterprise_rate_per_minute == null || purchase_amount == null) {
      return new Response(JSON.stringify({ error: "enterprise_rate_per_minute and purchase_amount are required for admin crediting" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsedRate = Number(enterprise_rate_per_minute);
    const parsedAmount = Number(purchase_amount);
    if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
      return new Response(JSON.stringify({ error: "enterprise_rate_per_minute must be a valid positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return new Response(JSON.stringify({ error: "purchase_amount must be a valid positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const credit = await creditEnterpriseMinutes(supabase as any, {
      userId: client_user_id,
      purchaseAmount: parsedAmount,
      ratePerMinute: parsedRate,
      adminEmail: ADMIN_EMAIL,
    });

    let updatedUser: { user?: unknown } | null = null;
    const { data: userData } = await supabase.auth.admin.getUserById(client_user_id);
    if (userData?.user) {
      const currentMetadata = userData.user.user_metadata ?? {};
      const nextMetadata = {
        ...currentMetadata,
        enterprise_interest: false,
        enterprise_updated_by: ADMIN_EMAIL,
        enterprise_updated_at: new Date().toISOString(),
      };

      const updateResult = await supabase.auth.admin.updateUserById(client_user_id, {
        user_metadata: nextMetadata,
      });

      if (!updateResult.error) {
        updatedUser = updateResult.data;
      }
    }

    return new Response(JSON.stringify({ success: true, user: updatedUser?.user ?? null, credit }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to update client enterprise plan",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
