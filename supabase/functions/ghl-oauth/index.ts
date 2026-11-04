import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ghlClientId = Deno.env.get("GHL_CLIENT_ID") || "";
const ghlClientSecret = Deno.env.get("GHL_CLIENT_SECRET") || "";
const ghlScopes =
  Deno.env.get("GHL_SCOPES") ||
  "calendars.readonly calendars/events.readonly calendars.write calendars/events.write";

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "") || "";

  if (!token) {
    throw new Error("Missing authorization header.");
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    throw new Error("Unauthorized");
  }

  return user;
}

function getAuthorizeUrl(redirectUri: string, state: string) {
  const url = new URL("https://marketplace.gohighlevel.com/oauth/chooselocation");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("client_id", ghlClientId);
  url.searchParams.set("scope", ghlScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("user_type", "Location");
  url.searchParams.set("loginWindowOpenMode", "self");
  return url.toString();
}

async function exchangeCode(code: string, redirectUri: string) {
  const tokenRes = await fetch("https://services.leadconnectorhq.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: ghlClientId,
      client_secret: ghlClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      user_type: "Location",
    }),
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.message || tokenJson.error || "Failed to exchange GoHighLevel authorization code.");
  }

  return tokenJson;
}

async function fetchCalendars(accessToken: string, locationId: string) {
  const res = await fetch(`https://services.leadconnectorhq.com/calendars/?locationId=${encodeURIComponent(locationId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Version: "2021-04-15",
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.error || "Failed to load GoHighLevel calendars.");
  }

  const calendars = Array.isArray(json.calendars)
    ? json.calendars
    : Array.isArray(json.data?.calendars)
      ? json.data.calendars
      : Array.isArray(json.data)
        ? json.data
        : [];

  return calendars;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!ghlClientId || !ghlClientSecret) {
      return json({ error: "GoHighLevel OAuth is not configured on the server." }, 500);
    }

    const user = await getAuthenticatedUser(req);
    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === "authorize_url") {
      const redirectUri = String(body?.redirect_uri || "");
      const state = String(body?.state || "");
      if (!redirectUri || !state) {
        return json({ error: "redirect_uri and state are required." }, 400);
      }

      return json({ success: true, url: getAuthorizeUrl(redirectUri, state) });
    }

    if (action === "exchange_code") {
      const code = String(body?.code || "");
      const redirectUri = String(body?.redirect_uri || "");
      if (!code || !redirectUri) {
        return json({ error: "code and redirect_uri are required." }, 400);
      }

      const tokenJson = await exchangeCode(code, redirectUri);
      const locationId =
        tokenJson.locationId ||
        tokenJson.location_id ||
        tokenJson.companyId ||
        tokenJson.company_id ||
        "";

      const calendars = locationId ? await fetchCalendars(tokenJson.access_token, locationId) : [];
      const primaryCalendar = calendars[0] || null;
      const expiresAt = tokenJson.expires_in
        ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
        : null;

      const { data: existing, error: existingError } = await supabase
        .from("calendar_integrations")
        .select("id,config")
        .eq("user_id", user.id)
        .eq("provider", "gohighlevel")
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      const payload = {
        user_id: user.id,
        provider: "gohighlevel",
        display_name:
          primaryCalendar?.name ||
          primaryCalendar?.title ||
          (locationId ? `GoHighLevel (${locationId})` : "GoHighLevel"),
        api_key: null,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token || null,
        token_expires_at: expiresAt,
        calendar_id: primaryCalendar?.id || primaryCalendar?._id || null,
        is_active: true,
        config: {
          ...(existing?.config || {}),
          oauth_connected: true,
          location_id: locationId || null,
          company_id: tokenJson.companyId || tokenJson.company_id || null,
          user_type: tokenJson.userType || tokenJson.user_type || "Location",
          scope: tokenJson.scope || ghlScopes,
          calendars: calendars.slice(0, 25).map((calendar: any) => ({
            id: calendar.id || calendar._id || "",
            name: calendar.name || calendar.title || "Untitled calendar",
          })),
        },
      };

      if (existing?.id) {
        const { error } = await supabase
          .from("calendar_integrations")
          .update(payload)
          .eq("id", existing.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("calendar_integrations")
          .insert(payload);

        if (error) throw error;
      }

      return json({
        success: true,
        display_name: payload.display_name,
        calendar_id: payload.calendar_id,
        location_id: locationId || null,
      });
    }

    return json({ error: "Unsupported action." }, 400);
  } catch (error: any) {
    console.error("ghl-oauth error", error);
    return json({ error: error.message || "Internal error" }, 500);
  }
});
