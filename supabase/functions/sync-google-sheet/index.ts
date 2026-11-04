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
      return json({ error: "No authorization header" }, 401);
    }

    const anonKey =
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
      Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ||
      Deno.env.get("SUPABASE_ANON_KEY");

    if (!anonKey) {
      return json({ error: "Supabase publishable key is not configured for sync-google-sheet" }, 500);
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
        return json({ error: "Unauthorized" }, 401);
      }

      userId = user.id;
    }

    const body = await req.json();
    const campaignName = String(body?.campaignName || "Campaign Outcomes");
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const selectedMode = body?.mode === "existing" ? "existing" : "new";
    const existingSheetId = body?.sheetId ? String(body.sheetId) : "";

    if (!rows.length) {
      return json({ error: "No campaign rows were provided for Google Sheets sync." }, 400);
    }

    const { data: integration, error: integrationError } = await supabase
      .from("calendar_integrations")
      .select("*")
      .eq("user_id", userId)
      .eq("provider", "google_sheets")
      .maybeSingle();

    if (integrationError || !integration) {
      return json({ error: "Google Sheets integration not found" }, 404);
    }

    const tabTitle = sanitizeSheetTitle(campaignName);

    let spreadsheetId = existingSheetId;
    let spreadsheetUrl = "";
    let targetSheetTitle = tabTitle;

    if (selectedMode === "new") {
      const createRes = await fetchGoogleJsonWithRefresh(integration, "https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        headers: {
          Authorization: "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          properties: {
            title: `${campaignName} Outcomes`,
          },
          sheets: [
            {
              properties: {
                title: tabTitle,
              },
            },
          ],
        }),
      });

      const createJson = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createJson.spreadsheetId) {
        return json({ error: createJson.error?.message || "Failed to create Google Sheet" }, createRes.status || 500);
      }

      spreadsheetId = createJson.spreadsheetId as string;
      spreadsheetUrl = (createJson.spreadsheetUrl as string) || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      targetSheetTitle = createJson.sheets?.[0]?.properties?.title || tabTitle;
    } else {
      if (!spreadsheetId) {
        return json({ error: "No Google Sheet was selected." }, 400);
      }

      const getRes = await fetchGoogleJsonWithRefresh(
        integration,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
        {
          headers: {
            Authorization: "",
          },
        },
      );

      const getJson = await getRes.json().catch(() => ({}));
      if (!getRes.ok) {
        return json({ error: getJson.error?.message || "Failed to read the selected Google Sheet" }, getRes.status || 500);
      }

      spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      const firstSheetTitle = getJson.sheets?.[0]?.properties?.title;
      if (firstSheetTitle) {
        targetSheetTitle = firstSheetTitle;
      }
    }

    const valueRange = {
      majorDimension: "ROWS",
      values: rows.map((row: unknown[]) => row.map((cell) => (cell == null ? "" : String(cell)))),
    };

    const updateRes = await fetchGoogleJsonWithRefresh(
      integration,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${targetSheetTitle}!A1`)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(valueRange),
      },
    );

    const updateJson = await updateRes.json().catch(() => ({}));
    if (!updateRes.ok) {
      return json({ error: updateJson.error?.message || "Failed to write campaign data to Google Sheets" }, updateRes.status || 500);
    }

    await fetchGoogleJsonWithRefresh(
      integration,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
      method: "POST",
      headers: {
        Authorization: "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: 0,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: Math.max(rows[0]?.length || 0, 1),
              },
            },
          },
        ],
      }),
      },
    ).catch(() => null);

    return json({
      spreadsheetId,
      spreadsheetUrl,
      sheetTitle: targetSheetTitle,
    });
  } catch (error: any) {
    return json({ error: error.message || "Internal error" }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeSheetTitle(name: string) {
  const cleaned = name.replace(/[\[\]\*\/\\\?\:]/g, " ").trim();
  return (cleaned || "Outcomes").slice(0, 90);
}

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
