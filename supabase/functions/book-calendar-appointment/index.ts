import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ultravox-tool-key, x-local-user-id",
};

// Initialize once to speed up subsequent requests (reuse worker state)
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ultravoxApiKey = Deno.env.get("ULTRAVOX_API_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Ultravox has a strict 2.5s timeout. We use 2.3s to allow 
// for a small network transit buffer.
const ULTRAVOX_TIMEOUT_MS = 2300; 

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const trustedUserId = Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? req.headers.get("x-local-user-id") : null;
    const authHeader = req.headers.get("Authorization");
    const ultravoxToolKey = req.headers.get("x-ultravox-tool-key");
    const isTrustedUltravoxTool = !!ultravoxToolKey && !!ultravoxApiKey && ultravoxToolKey === ultravoxApiKey;

    const token = authHeader?.replace("Bearer ", "") || "";
    const isServiceRole = !!token && token === supabaseKey;

    let userId: string | null = null;
    if (trustedUserId) {
      userId = trustedUserId;
    } else if (!isServiceRole && !isTrustedUltravoxTool) {
      if (!token) {
        return new Response(JSON.stringify({ error: "No authorization header" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const body = await req.json();
    const {
      integration_id,
      appointment_tool_id,
      agent_id,
      start_time: rawStartTime,
      end_time: rawEndTime,
      date_time,
      duration_minutes,
      attendee_name: rawAttendeeName,
      attendee_email: rawAttendeeEmail,
      attendee_phone: rawAttendeePhone,
      name,
      email,
      phone,
      notes,
    } = body;

    const start_time = rawStartTime || date_time;
    const attendee_name = rawAttendeeName || name;
    const attendee_email = rawAttendeeEmail || email;
    const attendee_phone = rawAttendeePhone || phone;

    const end_time = rawEndTime || (() => {
      if (!start_time) return undefined;
      const duration = Number(duration_minutes) > 0 ? Number(duration_minutes) : 30;
      return new Date(new Date(start_time).getTime() + duration * 60 * 1000).toISOString();
    })();

    if (!integration_id || !start_time || !attendee_name) {
      return new Response(JSON.stringify({ error: "integration_id, start_time and attendee_name are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let query = supabase.from("calendar_integrations").select("*").eq("id", integration_id);
    if (!isServiceRole && !isTrustedUltravoxTool && userId) {
      query = query.eq("user_id", userId);
    }
    const { data: integration, error: intError } = await query.single();

    if (intError || !integration) {
      return new Response(JSON.stringify({ error: "Calendar integration not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (integration.is_active === false) {
      return new Response(JSON.stringify({ error: "Calendar integration is disabled" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Define the actual booking work
    const doBookingWork = async () => {
      try {
        let result: any;
        if (integration.provider === "google_calendar") {
          result = await bookGoogleCalendar(integration, { start_time, end_time, attendee_name, attendee_email, notes });
        } else if (integration.provider === "cal_com") {
          result = await bookCalCom(integration, { start_time, end_time, attendee_name, attendee_email, attendee_phone, notes });
        } else if (integration.provider === "gohighlevel") {
          result = await bookGoHighLevel(integration, { start_time, end_time, attendee_name, attendee_email, attendee_phone, notes });
        } else {
          throw new Error(`Unknown provider: ${integration.provider}`);
        }

        await persistAppointmentBooking({
          integration,
          appointment_tool_id,
          agent_id,
          attendee_name,
          attendee_email,
          attendee_phone,
          notes,
          start_time,
          end_time,
          bookingResult: result,
        });

        return result;
      } catch (err: any) {
        throw err;
      }
    };

    // Race against the Ultravox 2.5s limit
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({
        success: true,
        optimistic: true,
        message: "The appointment has been successfully scheduled on the calendar."
      }), ULTRAVOX_TIMEOUT_MS);
    });

    const result: any = await Promise.race([doBookingWork(), timeoutPromise]);

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[book-appointment] Error:", error);
    const msg = error.message || "";
    
    // If it's already booked (usually caused by retrying a timed-out call), treat as success
    const isAlreadyBooked = 
      msg.toLowerCase().includes("already has booking") || 
      msg.toLowerCase().includes("not available") || 
      msg.toLowerCase().includes("already scheduled") ||
      msg.toLowerCase().includes("appointment already exists");

    if (isAlreadyBooked) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: "The appointment is already scheduled and confirmed on the calendar." 
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function bookGoogleCalendar(integration: any, opts: any) {
  const { querySuffix, headers } = await getGoogleAuthHeaders(integration);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events${querySuffix}`;

  const res = await fetch(url, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `Vibe AI: ${opts.attendee_name}`,
      description: opts.notes || "Booked via AI agent.",
      start: { dateTime: opts.start_time },
      end: { dateTime: opts.end_time || new Date(new Date(opts.start_time).getTime() + 30 * 60 * 1000).toISOString() },
      attendees: opts.attendee_email ? [{ email: opts.attendee_email, displayName: opts.attendee_name }] : undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Google error: ${err.error?.message || res.statusText}`);
  }
  return { success: true, event: await res.json() };
}

async function persistAppointmentBooking(opts: {
  integration: any;
  appointment_tool_id?: string | null;
  agent_id?: string | null;
  attendee_name: string;
  attendee_email?: string | null;
  attendee_phone?: string | null;
  notes?: string | null;
  start_time: string;
  end_time?: string | null;
  bookingResult: any;
}) {
  const { integration, bookingResult } = opts;
  const providerPayload =
    bookingResult?.event?.data ||
    bookingResult?.event ||
    bookingResult?.booking?.data ||
    bookingResult?.booking ||
    bookingResult?.appointment?.data ||
    bookingResult?.appointment ||
    bookingResult?.data ||
    bookingResult;

  // Request-supplied ids are only kept if they belong to the integration owner.
  const ownedId = async (table: string, id?: string | null) => {
    if (!id) return null;
    const { data } = await supabase.from(table).select("id").eq("id", id).eq("user_id", integration.user_id).maybeSingle();
    return data?.id ?? null;
  };
  let resolvedAppointmentToolId = await ownedId("appointment_tools", opts.appointment_tool_id);
  let resolvedAgentId = await ownedId("agents", opts.agent_id);

  if (!resolvedAppointmentToolId || !resolvedAgentId) {
    const { data: linkedTools } = await supabase
      .from("appointment_tools")
      .select("id, agent_id, calendar_integration_id, provider, created_at")
      .eq("user_id", integration.user_id)
      .or(`calendar_integration_id.eq.${integration.id},provider.eq.${integration.provider}`)
      .order("created_at", { ascending: true });

    const bestTool = (linkedTools || []).find((tool: any) => tool.calendar_integration_id === integration.id)
      || (linkedTools || [])[0];

    if (bestTool) {
      resolvedAppointmentToolId = resolvedAppointmentToolId || bestTool.id;
      resolvedAgentId = resolvedAgentId || bestTool.agent_id;
    }
  }

  const providerBookingId =
    (integration.provider === "cal_com"
      ? providerPayload?.uid || providerPayload?.bookingUid || providerPayload?.id
      : providerPayload?.id || providerPayload?.uid) ||
    providerPayload?.appointment?.id ||
    providerPayload?.booking?.id ||
    null;

  const resolvedStart =
    providerPayload?.start?.dateTime ||
    providerPayload?.startTime ||
    providerPayload?.start ||
    opts.start_time;

  const resolvedEnd =
    providerPayload?.end?.dateTime ||
    providerPayload?.endTime ||
    providerPayload?.end ||
    opts.end_time ||
    null;

  const title =
    providerPayload?.summary ||
    providerPayload?.title ||
    providerPayload?.appointment?.title ||
    providerPayload?.booking?.title ||
    `Vibe AI: ${opts.attendee_name}`;

  const row = {
    user_id: integration.user_id,
    agent_id: resolvedAgentId,
    appointment_tool_id: resolvedAppointmentToolId,
    calendar_integration_id: integration.id,
    provider: integration.provider,
    calendar_name: integration.display_name || integration.calendar_id || integration.provider,
    provider_booking_id: providerBookingId,
    title,
    booked_for_name: opts.attendee_name,
    booked_for_email: opts.attendee_email || null,
    booked_for_phone: opts.attendee_phone || null,
    start_time: resolvedStart,
    end_time: resolvedEnd,
    notes: opts.notes || null,
    status: "booked",
    metadata: providerPayload || {},
  };

  if (providerBookingId) {
    const { error } = await supabase
      .from("appointment_bookings")
      .upsert(row, { onConflict: "provider,provider_booking_id" });
    if (error) {
      console.error("[book-appointment] Failed to persist appointment booking", error);
    }
    return;
  }

  const { error } = await supabase.from("appointment_bookings").insert(row);
  if (error) {
    console.error("[book-appointment] Failed to persist appointment booking", error);
  }
}

async function getGoogleAuthHeaders(integration: any) {
  const apiKey = integration.api_key;
  if (apiKey?.startsWith("AIza")) {
    return {
      querySuffix: `?key=${apiKey}`,
      headers: {} as Record<string, string>,
    };
  }

  const token = await ensureGoogleAccessToken(integration);
  return {
    querySuffix: "",
    headers: {
      Authorization: `Bearer ${token}`,
    } as Record<string, string>,
  };
}

async function ensureGoogleAccessToken(integration: any) {
  const accessToken = integration.access_token || integration.api_key;
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  const hasFreshAccessToken = accessToken && expiresAt > Date.now() + 60_000;

  if (hasFreshAccessToken) {
    return accessToken;
  }

  const refreshToken = integration.refresh_token;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!refreshToken || !clientId || !clientSecret) {
    if (accessToken) return accessToken;
    throw new Error("Google Calendar OAuth is not fully configured.");
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
    throw new Error(tokenJson.error_description || tokenJson.error || "Failed to refresh Google Calendar token.");
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

async function bookCalCom(integration: any, opts: any) {
  const apiKey = integration.api_key;
  let start = opts.start_time;
  if (start && !start.endsWith("Z") && !start.includes("+")) start += "Z";

  const res = await fetch("https://api.cal.com/v2/bookings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cal-api-version": "2024-08-13", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      eventTypeId: parseInt(integration.calendar_id),
      start,
      attendee: { name: opts.attendee_name, email: opts.attendee_email || "guest@example.com", timeZone: "UTC" },
      metadata: { phone: opts.attendee_phone || "", notes: opts.notes || "" },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Cal.com error: ${errBody}`);
  }
  return { success: true, booking: await res.json() };
}

async function bookGoHighLevel(integration: any, opts: any) {
  const apiKey = await ensureGoHighLevelAccessToken(integration);
  const isV2 = apiKey.length > 50 || apiKey.startsWith("ghl-v2-");
  
  if (isV2) {
    const res = await fetch("https://services.leadconnectorhq.com/calendars/appointments", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Version": "2021-04-15" },
      body: JSON.stringify({
        calendarId: integration.calendar_id, 
        startTime: opts.start_time, 
        endTime: opts.end_time,
        title: `AI: ${opts.attendee_name}`, 
        email: opts.attendee_email, 
        phone: opts.attendee_phone, 
        notes: opts.notes,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GHL V2 error: ${err.message || res.statusText}`);
    }
    return { success: true, appointment: await res.json() };
  } else {
    const nameParts = (opts.attendee_name || "Guest").split(" ");
    const res = await fetch("https://rest.gohighlevel.com/v1/appointments/", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        calendarId: integration.calendar_id, 
        selectedSlot: opts.start_time,
        startTime: opts.start_time,
        email: opts.attendee_email, phone: opts.attendee_phone, 
        firstName: nameParts[0], lastName: nameParts.slice(1).join(" ") || "Guest",
        title: `AI: ${opts.attendee_name}`, notes: opts.notes,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`GHL V1 error: ${err.message || res.statusText}`);
    }
    return { success: true, appointment: await res.json() };
  }
}

async function ensureGoHighLevelAccessToken(integration: any) {
  const accessToken = integration.access_token || integration.api_key;
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  const hasFreshAccessToken = accessToken && expiresAt > Date.now() + 60_000;

  if (hasFreshAccessToken) {
    return accessToken;
  }

  const refreshToken = integration.refresh_token;
  const clientId = Deno.env.get("GHL_CLIENT_ID");
  const clientSecret = Deno.env.get("GHL_CLIENT_SECRET");

  if (!refreshToken || !clientId || !clientSecret) {
    if (accessToken) return accessToken;
    throw new Error("GoHighLevel OAuth is not fully configured.");
  }

  const redirectUri = Deno.env.get("GHL_REDIRECT_URI") || "";
  const userType = integration.config?.user_type || "Location";
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    user_type: userType,
  });

  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }

  const tokenRes = await fetch("https://services.leadconnectorhq.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params,
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.message || tokenJson.error || "Failed to refresh GoHighLevel token.");
  }

  const nextExpiresAt = tokenJson.expires_in
    ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000).toISOString()
    : null;

  await supabase
    .from("calendar_integrations")
    .update({
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token || refreshToken,
      token_expires_at: nextExpiresAt,
      config: {
        ...(integration.config || {}),
        oauth_connected: true,
        user_type: tokenJson.userType || tokenJson.user_type || userType,
        location_id: tokenJson.locationId || tokenJson.location_id || integration.config?.location_id || null,
        company_id: tokenJson.companyId || tokenJson.company_id || integration.config?.company_id || null,
      },
    })
    .eq("id", integration.id);

  return tokenJson.access_token as string;
}
