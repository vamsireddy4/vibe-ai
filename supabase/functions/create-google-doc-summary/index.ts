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
      return json({ error: "Supabase publishable key is not configured for create-google-doc-summary" }, 500);
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

    const body = await req.json().catch(() => ({}));
    const agentId = String(body?.agentId || "").trim();
    const campaignName = String(body?.campaignName || "Campaign");
    const contactName = String(body?.contactName || body?.customerName || "Customer").trim() || "Customer";
    const contactEmail = String(body?.contactEmail || "").trim();
    const phone = String(body?.phone || "").trim();
    const result = String(body?.result || "").trim();
    const duration = String(body?.duration || "").trim();
    const transcript = String(body?.transcript || "").trim();
    const summary = String(body?.summary || "").trim();
    const startedAt = String(body?.startedAt || "").trim();
    const selectedMode = body?.mode === "existing" ? "existing" : "new";
    const existingSheetId = String(body?.sheetId || "").trim();
    const rows = normalizeRows(body?.rows);

    if (!agentId) {
      return json({ error: "agentId is required" }, 400);
    }

    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, use_google_docs")
      .eq("id", agentId)
      .eq("user_id", userId)
      .maybeSingle();

    if (agentError) {
      return json({ error: agentError.message || "Failed to load agent settings" }, 500);
    }

    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (!agent.use_google_docs) {
      return json({ error: "Google Docs is disabled for this agent. Enable use_google_docs on the agent before creating Docs." }, 400);
    }

    const { data: integration, error: integrationError } = await supabase
      .from("calendar_integrations")
      .select("*")
      .eq("user_id", userId)
      .in("provider", ["google_sheets", "google_docs"])
      .order("provider", { ascending: true })
      .limit(2);

    const integrations = Array.isArray(integration) ? integration : [];
    const googleIntegration =
      integrations.find((item) => item.refresh_token && String(item.refresh_token).trim()) ||
      integrations.find((item) => {
        const expiresAt = item.token_expires_at ? new Date(item.token_expires_at).getTime() : 0;
        return (item.access_token || item.api_key) && expiresAt > Date.now() + 60_000;
      }) ||
      integrations.find((item) => item.provider === "google_sheets") ||
      integrations.find((item) => item.provider === "google_docs");

    if (integrationError || !googleIntegration) {
      return json({ error: "Google integration not found" }, 404);
    }

    let documentId = "";
    let documentUrl = "";
    let title = "";

    title = `Call Summary - ${contactName} - ${formatDocumentDate(startedAt)}`;
    const createRes = await fetchGoogleJsonWithRefresh(googleIntegration, "https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: {
        Authorization: "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });

    const createJson = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createJson.documentId) {
      return json({ error: createJson.error?.message || "Failed to create Google Doc" }, createRes.status || 500);
    }

    documentId = String(createJson.documentId);
    const content = buildDocumentText({
      campaignName,
      contactName,
      contactEmail,
      phone,
      result,
      duration,
      startedAt,
      summary,
      transcript,
    });

    const updateRes = await fetchGoogleJsonWithRefresh(
      googleIntegration,
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: content,
              },
            },
          ],
        }),
      },
    );

    const updateJson = await updateRes.json().catch(() => ({}));
    if (!updateRes.ok) {
      return json({ error: updateJson.error?.message || "Failed to write Google Doc content" }, updateRes.status || 500);
    }

    const fileRes = await fetchGoogleJsonWithRefresh(
      googleIntegration,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}?fields=id,webViewLink`,
      {
        headers: {
          Authorization: "",
        },
      },
    );

    const fileJson = await fileRes.json().catch(() => ({}));
    if (!fileRes.ok) {
      return json({ error: fileJson.error?.message || "Google Doc created, but the document metadata could not be loaded." }, fileRes.status || 500);
    }

    documentUrl = String(fileJson.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`);

    let spreadsheetId = "";
    let spreadsheetUrl = "";
    let sheetTitle = "";
    if (rows.length > 0) {
      const rowsWithDocumentLink = documentUrl ? addDocumentLinkColumn(rows, documentUrl) : rows;
      const sheetResult = await writeGoogleSheet({
        integration: googleIntegration,
        campaignName,
        mode: selectedMode,
        existingSheetId,
        rows: rowsWithDocumentLink,
      });
      spreadsheetId = sheetResult.spreadsheetId;
      spreadsheetUrl = sheetResult.spreadsheetUrl;
      sheetTitle = sheetResult.sheetTitle;
    }

    return json({
      documentId: documentId || null,
      documentUrl: documentUrl || null,
      title: title || null,
      googleDocsUsed: true,
      spreadsheetId: spreadsheetId || null,
      spreadsheetUrl: spreadsheetUrl || null,
      sheetTitle: sheetTitle || null,
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

function formatDocumentDate(input: string) {
  if (!input) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function normalizeRows(input: unknown): string[][] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((row) => Array.isArray(row))
    .map((row) => (row as unknown[]).map((cell) => (cell == null ? "" : String(cell))));
}

function addDocumentLinkColumn(rows: string[][], documentUrl: string) {
  if (!rows.length) return rows;
  return rows.map((row, index) => {
    if (index === 0) {
      return row.some((cell) => cell.trim().toLowerCase() === "document link") ? row : [...row, "Document Link"];
    }
    return [...row, documentUrl];
  });
}

function buildDocumentText(input: {
  campaignName: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  result: string;
  duration: string;
  startedAt: string;
  summary: string;
  transcript: string;
}) {
  const lines = [
    "Call Summary",
    "",
    `Campaign: ${input.campaignName}`,
    `Contact: ${input.contactName}`,
    `Email: ${input.contactEmail || "-"}`,
    `Phone: ${input.phone || "-"}`,
    `Result: ${input.result || "-"}`,
    `Duration: ${input.duration || "-"}`,
    `Time: ${input.startedAt || "-"}`,
    "",
    "AI Summary",
    input.summary || "No AI summary available.",
    "",
    "Transcript",
    input.transcript || "No transcript available.",
    "",
  ];

  return lines.join("\n");
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

function sanitizeSheetTitle(name: string) {
  const cleaned = name.replace(/[\[\]\*\/\\\?\:]/g, " ").trim();
  return (cleaned || "Outcomes").slice(0, 90);
}

async function writeGoogleSheet({
  integration,
  campaignName,
  mode,
  existingSheetId,
  rows,
}: {
  integration: any;
  campaignName: string;
  mode: "new" | "existing";
  existingSheetId: string;
  rows: string[][];
}) {
  const tabTitle = sanitizeSheetTitle(campaignName);
  let spreadsheetId = existingSheetId;
  let spreadsheetUrl = "";
  let targetSheetTitle = tabTitle;

  if (mode === "new") {
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
        sheets: [{ properties: { title: tabTitle } }],
      }),
    });

    const createJson = await createRes.json().catch(() => ({}));
    if (!createRes.ok || !createJson.spreadsheetId) {
      throw new Error(createJson.error?.message || "Failed to create Google Sheet");
    }

    spreadsheetId = String(createJson.spreadsheetId);
    spreadsheetUrl = String(createJson.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
    targetSheetTitle = String(createJson.sheets?.[0]?.properties?.title || tabTitle);
  } else {
    if (!spreadsheetId) {
      throw new Error("No Google Sheet was selected.");
    }

    const getRes = await fetchGoogleJsonWithRefresh(
      integration,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties.title`,
      { headers: { Authorization: "" } },
    );
    const getJson = await getRes.json().catch(() => ({}));
    if (!getRes.ok) {
      throw new Error(getJson.error?.message || "Failed to read the selected Google Sheet");
    }

    spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    const firstSheetTitle = getJson.sheets?.[0]?.properties?.title;
    if (firstSheetTitle) targetSheetTitle = String(firstSheetTitle);
  }

  const updateRes = await fetchGoogleJsonWithRefresh(
    integration,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${targetSheetTitle}!A1`)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        majorDimension: "ROWS",
        values: rows,
      }),
    },
  );

  const updateJson = await updateRes.json().catch(() => ({}));
  if (!updateRes.ok) {
    throw new Error(updateJson.error?.message || "Failed to write campaign data to Google Sheets");
  }

  return { spreadsheetId, spreadsheetUrl, sheetTitle: targetSheetTitle };
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
    throw new Error("Google Docs connection expired. Please reconnect Google Docs.");
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
    throw new Error(tokenJson.error_description || tokenJson.error || "Google Docs connection expired. Please reconnect Google Docs.");
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
