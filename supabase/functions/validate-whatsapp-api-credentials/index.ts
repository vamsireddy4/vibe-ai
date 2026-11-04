import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Signed-in users only: otherwise anyone could use this server to test Meta tokens.
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

type ValidationRequest = {
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
};

type ValidationResponse = {
  valid: boolean;
  error?: string;
  details?: string;
};

function json(status: number, body: ValidationResponse) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { valid: false, error: "Method not allowed" });
  }

  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  const { data: auth } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  if (!auth?.user) return json(401, { valid: false, error: "Unauthorized" });

  try {
    const {
      accessToken = "",
      phoneNumberId = "",
      businessAccountId = "",
    }: ValidationRequest = await req.json().catch(() => ({}));

    const trimmedAccessToken = String(accessToken).trim();
    const trimmedPhoneNumberId = String(phoneNumberId).trim();
    const trimmedBusinessAccountId = String(businessAccountId).trim();

    if (!trimmedAccessToken || !trimmedPhoneNumberId || !trimmedBusinessAccountId) {
      return json(400, {
        valid: false,
        error: "Missing required fields: accessToken, phoneNumberId, or businessAccountId",
      });
    }

    const graphVersion = "v22.0";

    const tokenResponse = await fetch(
      `https://graph.facebook.com/${graphVersion}/me?access_token=${encodeURIComponent(trimmedAccessToken)}`,
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      return json(200, {
        valid: false,
        error: "Invalid access token",
        details: errorData?.error?.message || "The access token is invalid or expired.",
      });
    }

    const phonesResponse = await fetch(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(trimmedBusinessAccountId)}/phone_numbers?access_token=${encodeURIComponent(trimmedAccessToken)}`,
    );

    if (!phonesResponse.ok) {
      const errorData = await phonesResponse.json().catch(() => ({}));
      const errorCode = String(errorData?.error?.code ?? "");

      if (errorCode === "190" || errorCode === "10" || errorCode === "200") {
        return json(200, {
          valid: false,
          error: "Access token permissions issue",
          details:
            'Token does not have required permissions for this Business Account. Ensure it includes "whatsapp_business_messaging" and "whatsapp_business_management".',
        });
      }

      return json(200, {
        valid: false,
        error: "Invalid Business Account ID",
        details:
          errorData?.error?.message ||
          "The Business Account ID does not match the access token or does not exist.",
      });
    }

    const phonesData = await phonesResponse.json().catch(() => ({}));
    const phoneMatch = Array.isArray(phonesData?.data)
      ? phonesData.data.some((phone: Record<string, unknown>) => String(phone?.id ?? "") === trimmedPhoneNumberId)
      : false;

    if (!phoneMatch) {
      return json(200, {
        valid: false,
        error: "Phone Number ID mismatch",
        details: `The Phone Number ID (${trimmedPhoneNumberId}) does not belong to Business Account ${trimmedBusinessAccountId}. Please verify your credentials in Meta Business Manager.`,
      });
    }

    const phoneDetailsResponse = await fetch(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(trimmedPhoneNumberId)}?fields=verified_name,display_phone_number,quality_rating&access_token=${encodeURIComponent(trimmedAccessToken)}`,
    );

    let phoneDetails: Record<string, unknown> | null = null;
    if (phoneDetailsResponse.ok) {
      phoneDetails = await phoneDetailsResponse.json().catch(() => null);
    }

    return json(200, {
      valid: true,
      details:
        typeof phoneDetails?.verified_name === "string" && phoneDetails.verified_name.trim()
          ? `Connected to: ${phoneDetails.verified_name}${typeof phoneDetails?.display_phone_number === "string" && phoneDetails.display_phone_number.trim() ? ` (${phoneDetails.display_phone_number})` : ""}`
          : "All credentials are valid and properly linked.",
    });
  } catch (error) {
    console.error("[validate-whatsapp-api-credentials]", error);
    return json(500, {
      valid: false,
      error: "Validation failed",
      details: error instanceof Error ? error.message : "An unexpected error occurred during validation.",
    });
  }
});
