import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-local-user-id",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const trustedUserId = Deno.env.get("ALLOW_LOCAL_USER_HEADER") === "true" ? req.headers.get("x-local-user-id") : null;
    let user: { id: string } | null = null;

    if (trustedUserId) {
      user = { id: trustedUserId };
    } else {
      const authHeader = req.headers.get("Authorization");
      const token = authHeader?.replace("Bearer ", "") || "";
      if (!token) {
        return json({ error: "No authorization header" }, 401);
      }

      const { data: authData, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authData.user) {
        return json({ error: "Unauthorized" }, 401);
      }
      user = { id: authData.user.id };
    }

    const body = await req.json();
    const { booking_id, action, start_time } = body;
    if (!booking_id || !action) {
      return json({ error: "booking_id and action are required" }, 400);
    }
    if (!["cancel", "reschedule"].includes(action)) {
      return json({ error: "Unsupported action" }, 400);
    }
    if (action === "reschedule" && !start_time) {
      return json({ error: "start_time is required for reschedule" }, 400);
    }

    const { data: booking, error: bookingError } = await supabase
      .from("appointment_bookings")
      .select("*")
      .eq("id", booking_id)
      .eq("user_id", user.id)
      .single();

    if (bookingError || !booking) {
      return json({ error: "Appointment booking not found" }, 404);
    }

    const { data: integration, error: integrationError } = await supabase
      .from("calendar_integrations")
      .select("*")
      .eq("id", booking.calendar_integration_id)
      .eq("user_id", user.id)
      .single();

    if (integrationError || !integration) {
      return json({ error: "Calendar integration not found" }, 404);
    }

    let result: any;
    if (integration.provider === "google_calendar") {
      result = action === "cancel"
        ? await cancelGoogleBooking(integration, booking)
        : await rescheduleGoogleBooking(integration, booking, start_time);
    } else if (integration.provider === "cal_com") {
      result = action === "cancel"
        ? await cancelCalBooking(integration, booking)
        : await rescheduleCalBooking(integration, booking, start_time);
    } else {
      return json({ error: `${integration.provider} does not support booking actions yet` }, 400);
    }

    if (action === "cancel") {
      await supabase
        .from("appointment_bookings")
        .update({
          status: "cancelled",
          provider_booking_id:
            booking.provider_booking_id ||
            booking.metadata?.data?.uid ||
            booking.metadata?.uid ||
            booking.metadata?.data?.bookingUid ||
            null,
          metadata: result,
        })
        .eq("id", booking.id);
    } else {
      const payload = result?.data || result?.event || result || {};
      const nextStart = payload?.start?.dateTime || payload?.startTime || payload?.start || start_time;
      const nextEnd =
        payload?.end?.dateTime ||
        payload?.endTime ||
        payload?.end ||
        new Date(
          new Date(start_time).getTime() +
            Math.max(
              15 * 60 * 1000,
              (booking.end_time ? new Date(booking.end_time).getTime() : new Date(booking.start_time).getTime()) -
                new Date(booking.start_time).getTime(),
            ),
        ).toISOString();

      const nextProviderBookingId =
        payload?.rescheduledToUid ||
        payload?.uid ||
        payload?.id ||
        booking.provider_booking_id;

      await supabase
        .from("appointment_bookings")
        .update({
          start_time: nextStart,
          end_time: nextEnd,
          provider_booking_id: nextProviderBookingId,
          status: "booked",
          metadata: result,
        })
        .eq("id", booking.id);
    }

    return json({ success: true, action, data: result });
  } catch (error: any) {
    console.error("[manage-calendar-booking] Error:", error);
    return json({ error: error.message || "Internal error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getGoogleAuthHeaders(integration: any) {
  const apiKey = integration.api_key;
  if (apiKey?.startsWith("AIza")) {
    return { headers: {} as Record<string, string> };
  }

  const token = await ensureGoogleAccessToken(integration);
  return {
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

async function cancelGoogleBooking(integration: any, booking: any) {
  const { headers } = await getGoogleAuthHeaders(integration);
  const eventId = booking.provider_booking_id;
  if (!eventId) {
    throw new Error("Missing Google event id");
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers,
    },
  );

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || "Failed to cancel Google Calendar event");
  }

  return { success: true };
}

async function rescheduleGoogleBooking(integration: any, booking: any, startTime: string) {
  const { headers } = await getGoogleAuthHeaders(integration);
  const eventId = booking.provider_booking_id;
  if (!eventId) {
    throw new Error("Missing Google event id");
  }

  const originalDurationMs = Math.max(
    15 * 60 * 1000,
    (booking.end_time ? new Date(booking.end_time).getTime() : new Date(booking.start_time).getTime()) -
      new Date(booking.start_time).getTime(),
  );

  const newStart = new Date(startTime);
  const newEnd = new Date(newStart.getTime() + originalDurationMs);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start: { dateTime: newStart.toISOString() },
        end: { dateTime: newEnd.toISOString() },
      }),
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || "Failed to reschedule Google Calendar event");
  }

  return payload;
}

async function cancelCalBooking(integration: any, booking: any) {
  const bookingUid =
    booking.provider_booking_id ||
    booking.metadata?.data?.uid ||
    booking.metadata?.uid ||
    booking.metadata?.data?.bookingUid ||
    null;
  if (!bookingUid) {
    throw new Error("Missing Cal.com booking UID");
  }

  const response = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(bookingUid)}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cal-api-version": "2024-08-13",
      Authorization: `Bearer ${integration.api_key}`,
    },
    body: JSON.stringify({
      cancellationReason: "User requested cancellation",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "Failed to cancel Cal.com booking");
  }

  return payload;
}

async function rescheduleCalBooking(integration: any, booking: any, startTime: string) {
  const bookingUid =
    booking.provider_booking_id ||
    booking.metadata?.data?.uid ||
    booking.metadata?.uid ||
    booking.metadata?.data?.bookingUid ||
    null;
  if (!bookingUid) {
    throw new Error("Missing Cal.com booking UID");
  }

  const response = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(bookingUid)}/reschedule`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cal-api-version": "2024-08-13",
      Authorization: `Bearer ${integration.api_key}`,
    },
    body: JSON.stringify({
      start: startTime,
      rescheduledBy: booking.booked_for_email || undefined,
      reschedulingReason: "User requested reschedule",
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "Failed to reschedule Cal.com booking");
  }

  return payload;
}
