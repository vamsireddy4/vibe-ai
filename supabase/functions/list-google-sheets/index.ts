import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonKey =
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
      Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ||
      Deno.env.get("SUPABASE_ANON_KEY");

    if (!anonKey) {
      return new Response(JSON.stringify({ error: "Supabase publishable key is not configured for list-google-sheets" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceRoleAuth = authHeader === `Bearer ${serviceRoleKey}`;
    const trustedUserId = Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? req.headers.get("x-local-user-id") : null;
    let userId = "";

    if (serviceRoleAuth && trustedUserId) {
      userId = trustedUserId;
    } else {
      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: authError,
      } = await anonClient.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const { data: integration, error: integrationError } = await supabase
      .from("calendar_integrations")
      .select("*")
      .eq("user_id", userId)
      .eq("provider", "google_sheets")
      .maybeSingle();

    if (integrationError || !integration) {
      return new Response(JSON.stringify({ error: "Google Sheets integration not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: "files(id,name,webViewLink,modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });

    const response = await fetchGoogleJsonWithRefresh(
      integration,
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        headers: {
          Authorization: "",
        },
      },
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: payload.error?.message || "Failed to load Google Sheets files" }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await response.json().catch(() => ({}));
    return new Response(JSON.stringify({ files: payload.files || [] }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchGoogleJsonWithRefresh(integration: any, url: string, init: RequestInit) {
  let accessToken = await ensureGoogleAccessToken(integration);
  let response = await fetch(url, withGoogleAuth(init, accessToken));

  if (response.status !== 401) {
    return response;
  }

  accessToken = await ensureGoogleAccessToken(integration, true);
  response = await fetch(url, withGoogleAuth(init, accessToken));
  return response;
}

function withGoogleAuth(init: RequestInit, accessToken: string): RequestInit {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  return {
    ...init,
    headers,
  };
}

async function ensureGoogleAccessToken(integration: any, forceRefresh = false) {
  const accessToken = integration.access_token || integration.api_key;
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  const hasFreshAccessToken = accessToken && expiresAt > Date.now() + 60_000;

  if (hasFreshAccessToken && !forceRefresh) {
    return accessToken;
  }

  const refreshToken = integration.refresh_token;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("Google Sheets connection expired. Please reconnect Google Sheets.");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || "Google Sheets connection expired. Please reconnect Google Sheets.");
  }

  const nextExpiresAt = tokenJson.expires_in
    ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
    : null;

  await supabase
    .from("calendar_integrations")
    .update({
      access_token: tokenJson.access_token,
      token_expires_at: nextExpiresAt,
    })
    .eq("id", integration.id);

  return tokenJson.access_token as string;
}
