/**
 * Appointment booking during calls. When the agent has an active Appointment Tool (Agent > Tools), the call
 * gets a `book_appointment` tool: the agent collects name, phone, email and time, confirms them, and the
 * booking is made on the user's own calendar (Google Calendar through Composio, or Cal.com with the user's
 * Cal.com API key and event type from Calendars), then saved to appointment_bookings.
 * The agent may only say "booked" after this returns success (see BOOKING_RULES).
 */
import { Composio } from "@composio/core";
import type { AgentTools } from "./llm/groqStreamer.js";

type Day = { start: string; end: string; enabled: boolean };
type Booking = {
  userId: string; agentId: string; toolId: string; integrationId: string; provider: string; calendarId: string; apiKey: string;
  typeName: string; durationMin: number; timezone: string; hours: Record<string, Day>;
};

const env = () => ({ url: process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" });
async function rows(path: string): Promise<any[]> {
  const { url, key } = env();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }).catch(() => null);
  return r?.ok ? ((await r.json()) as any[]) : [];
}

/** The agent's active appointment tool + its calendar, or null (then the call has no booking tool). */
async function loadBooking(userId: string, agentId: string): Promise<Booking | null> {
  const [tool] = await rows(
    `appointment_tools?select=*,calendar_integrations(id,provider,calendar_id,is_active,config,api_key)&agent_id=eq.${agentId}&user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true&limit=1`,
  );
  const cal = tool?.calendar_integrations;
  if (!tool || !cal?.is_active) return null;
  const [profile] = await rows(`profiles?select=timezone&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  const type = Array.isArray(tool.appointment_types) ? tool.appointment_types[0] : null;
  return {
    userId, agentId, toolId: tool.id, integrationId: cal.id, provider: cal.provider, calendarId: cal.calendar_id || "primary", apiKey: cal.api_key || "",
    typeName: type?.name || "Appointment", durationMin: Number(type?.duration) || 30,
    timezone: profile?.timezone || "UTC", hours: tool.business_hours ?? {},
  };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Wall-clock parts of `d` in `tz` (weekday, HH:MM) for the business-hours check. */
function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: p.weekday as string, time: `${p.hour}:${p.minute}` };
}

/** Reasons the requested slot can't be booked, or null. Exported for the selfcheck. */
export function slotProblem(start: Date, b: Pick<Booking, "timezone" | "hours" | "durationMin">, now = new Date()): string | null {
  if (Number.isNaN(start.getTime())) return "The time wasn't understood. Ask for the date and time again.";
  if (start.getTime() < now.getTime() + 5 * 60_000) return "That time is in the past. Ask for a future date and time.";
  const { day, time } = localParts(start, b.timezone);
  const end = localParts(new Date(start.getTime() + b.durationMin * 60_000), b.timezone).time;
  const h = b.hours[day];
  if (h && Object.keys(b.hours).length && (!h.enabled || time < h.start || end > h.end)) {
    const open = DAYS.filter((d) => b.hours[d]?.enabled).map((d) => `${d} ${b.hours[d].start}-${b.hours[d].end}`).join(", ");
    return `Outside business hours (${b.timezone}). Open: ${open}. Offer a time inside these hours.`;
  }
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "2026-11-05" + "11:00" on the wall clock in `tz` -> that instant. Exported for the selfcheck. */
export function zonedTime(date: string, time: string, tz: string): Date {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/), t = time.match(/^(\d{1,2}):(\d{2})/);
  if (!d || !t) return new Date(NaN);
  const asUtc = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  // The zone's offset at that moment: format the UTC instant in tz and see how far the wall clock moved.
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - asUtc;
  return new Date(asUtc - offset);
}

async function book(b: Booking, args: any): Promise<string> {
  const name = String(args?.name ?? "").trim();
  const phone = String(args?.phone ?? "").replace(/[^\d+]/g, "");
  const email = String(args?.email ?? "").trim().toLowerCase();
  const start = zonedTime(String(args?.date ?? ""), String(args?.time ?? ""), b.timezone);
  const missing = [!name && "full name", phone.replace(/\D/g, "").length < 7 && "phone number", !EMAIL.test(email) && "valid email"].filter(Boolean);
  if (missing.length) return `Not booked: missing ${missing.join(", ")}. Ask the caller for it.`;
  const problem = slotProblem(start, b);
  if (problem) return `Not booked: ${problem}`;
  const notes = args?.notes ? String(args.notes).slice(0, 500) : "";
  const made = b.provider === "cal_com" ? await bookCalCom(b, { name, phone, email, start, notes })
    : b.provider.includes("google") ? await bookGoogle(b, { name, phone, email, start, notes })
    : { error: "Not booked: this calendar isn't supported for live booking yet. Tell the caller the team will confirm by email." };
  if ("error" in made) return made.error;
  const { url, key } = env();
  await fetch(`${url}/rest/v1/appointment_bookings`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: b.userId, agent_id: b.agentId, appointment_tool_id: b.toolId, calendar_integration_id: b.integrationId,
      provider: b.provider, calendar_name: b.calendarId, provider_booking_id: made.id, title: `${b.typeName} with ${name}`,
      booked_for_name: name, booked_for_email: email, booked_for_phone: phone,
      start_time: start.toISOString(), end_time: new Date(start.getTime() + b.durationMin * 60_000).toISOString(),
      notes: notes || null, status: "confirmed", metadata: { source: "voice_call", html_link: made.link },
    }),
  }).catch((e) => console.error("booking row save failed", e));
  const when = new Intl.DateTimeFormat("en-US", { timeZone: b.timezone, dateStyle: "full", timeStyle: "short" }).format(start);
  return `Booked: ${b.typeName} on ${when} (${b.timezone}) for ${name}. A calendar invite was sent to ${email}.`;
}

type Who = { name: string; phone: string; email: string; start: Date; notes: string };
type Made = { id: string | null; link: string | null } | { error: string };
const REJECTED = "Not booked: the calendar rejected it. Apologize and say the team will follow up to confirm.";

/** Cal.com v2: the event type saved when the user connected Cal.com (calendar_id) decides length and availability. */
async function bookCalCom(b: Booking, w: Who): Promise<Made> {
  const eventTypeId = Number(b.calendarId);
  if (!b.apiKey || !Number.isInteger(eventTypeId)) return { error: "Not booked: the Cal.com calendar isn't fully connected (no API key or event type). Tell the caller the team will confirm by email." };
  const r = await fetch("https://api.cal.com/v2/bookings", {
    method: "POST",
    headers: { Authorization: `Bearer ${b.apiKey}`, "cal-api-version": "2024-08-13", "Content-Type": "application/json" },
    body: JSON.stringify({
      start: w.start.toISOString(), eventTypeId,
      attendee: { name: w.name, email: w.email, timeZone: b.timezone, ...(w.phone.startsWith("+") ? { phoneNumber: w.phone } : {}) },
      metadata: { source: "Vibe AI call", phone: w.phone.slice(0, 40), ...(w.notes ? { notes: w.notes } : {}) },
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => e as Error);
  if (r instanceof Error) return { error: REJECTED };
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data?.status !== "success") {
    const why = String(data?.error?.message ?? data?.message ?? r.status).slice(0, 200);
    console.error("cal.com booking failed", r.status, why);
    // Cal.com refuses taken or unavailable times; let the agent offer another one.
    if (/available|slot|busy|booked|conflict/i.test(why)) return { error: "Not booked: that time isn't available on the calendar. Ask the caller for another date or time." };
    return { error: REJECTED };
  }
  const booking = Array.isArray(data.data) ? data.data[0] : data.data;
  return { id: booking?.uid ?? (booking?.id != null ? String(booking.id) : null), link: booking?.uid ? `https://app.cal.com/booking/${booking.uid}` : null };
}

async function bookGoogle(b: Booking, w: Who): Promise<Made> {
  const { name, phone, email, start } = w;
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY ?? "" });
  const session = await composio.create(b.userId);
  const result: any = await session.execute("GOOGLECALENDAR_CREATE_EVENT", {
    calendar_id: b.calendarId,
    summary: `${b.typeName} with ${name}`,
    start_datetime: start.toISOString(),
    event_duration_minutes: b.durationMin,
    timezone: b.timezone,
    attendees: [email],
    send_updates: "all",
    description: `Booked by your Vibe AI agent during a call.\nName: ${name}\nPhone: ${phone}\nEmail: ${email}${w.notes ? `\nNotes: ${w.notes}` : ""}`,
  });
  const ok = result?.successful !== false && !result?.error;
  if (!ok) {
    console.error("booking failed", JSON.stringify(result?.error ?? result).slice(0, 300));
    return { error: REJECTED };
  }
  const event = result?.data?.response_data ?? result?.data ?? {};
  return { id: event.id ?? null, link: event.htmlLink ?? null };
}

/** Booking tool for this call, or undefined when the agent has no active appointment tool. */
export async function bookingTools(userId: string, agentId?: string): Promise<AgentTools | undefined> {
  if (!agentId) return undefined;
  const b = await loadBooking(userId, agentId).catch(() => null);
  if (!b) return undefined;
  const now = new Intl.DateTimeFormat("en-US", { timeZone: b.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date());
  const open = DAYS.filter((d) => b.hours[d]?.enabled).map((d) => `${d} ${b.hours[d].start}-${b.hours[d].end}`).join(", ");
  return {
    defs: [{
      type: "function",
      function: {
        name: "book_appointment",
        description: `Book a ${b.durationMin}-minute ${b.typeName} on the calendar. Call only after the caller confirmed every detail.`,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Caller's full name" },
            phone: { type: "string", description: "Caller's phone number with country code" },
            email: { type: "string", description: "Caller's email address" },
            date: { type: "string", description: "Appointment date as YYYY-MM-DD" },
            time: { type: "string", description: `Start time as 24-hour HH:MM in ${b.timezone}, e.g. 14:30 for 2:30 PM` },
            notes: { type: "string", description: "Reason for the appointment, if given" },
          },
          required: ["name", "phone", "email", "date", "time"],
        },
      },
    }],
    prompt: `BOOKING. You can book a ${b.durationMin}-minute ${b.typeName}. Right now it is ${now} (${b.timezone}).${open ? ` Business hours: ${open}.` : ""}
To book, collect ALL of: the caller's full name, phone number, email address, and the date and time. Ask for what's missing one item at a time. Spell the email back letter by letter and read the phone number back digit by digit (with the country code) to confirm, and repeat the date and time. Only then call book_appointment, saying only "One moment while I book that." as you do.
Never say an appointment is booked, scheduled or confirmed unless book_appointment returned a message starting with "Booked". If it returns "Not booked", tell the caller why in plain words and fix it with them.`,
    run: async (name, args) => (name === "book_appointment" ? book(b, args) : `Unknown tool ${name}`),
  };
}
