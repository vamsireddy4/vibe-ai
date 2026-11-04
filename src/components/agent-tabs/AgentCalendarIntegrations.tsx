import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, Pencil, Calendar, MoreHorizontal } from "lucide-react";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { useNavigate } from "react-router-dom";
import { getVibePath } from "@/lib/vibe-routes";
import CreateAppointmentToolDialog from "./CreateAppointmentToolDialog";
import googleCalendarLogo from "@/assets/google-calendar-logo.svg";
import calcomLogo from "@/assets/calcom-logo.png";
import { GOHIGHLEVEL_LOGO as gohighlevelLogo } from "@/lib/brand-logos"; // the old PNG cropped its wordmark to "HighL"
import { getErrorMessage, getFunctionUnavailableMessage, isEdgeFunctionUnavailable } from "@/lib/edge-functions";

interface CalendarIntegration {
  id: string; user_id: string; provider: string; display_name: string;
  api_key: string | null; calendar_id: string | null; is_active: boolean;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  config: Record<string, any>; created_at: string;
}

interface AppointmentTool {
  id: string;
  name: string;
  provider: string;
  calendar_integration_id: string | null;
  business_hours: Record<string, { enabled: boolean; start: string; end: string }>;
  appointment_types: { name: string; duration: number }[];
  is_active: boolean;
  created_at: string;
}

interface AppointmentBooking {
  id: string;
  agent_id: string | null;
  appointment_tool_id: string | null;
  calendar_integration_id: string | null;
  provider?: string | null;
  provider_booking_id?: string | null;
  calendar_name: string | null;
  title?: string | null;
  booked_for_name: string;
  booked_for_email: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
}

const PROVIDER_LOGOS: Record<string, string> = {
  google_calendar: googleCalendarLogo,
  cal_com: calcomLogo,
  gohighlevel: gohighlevelLogo,
};

const PROVIDER_NAMES: Record<string, string> = {
  google_calendar: "Google Calendar",
  cal_com: "Cal.com",
  gohighlevel: "GoHighLevel",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const formatDayKey = (date: Date) =>
  date.toLocaleDateString("en-US", { weekday: "long" });

const toDateInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getAvailabilityErrorMessage = (payload: any, fallback: string) => {
  const details = payload?.details;
  if (typeof details === "string" && details.trim()) return details;
  if (details && typeof details === "object") {
    if (typeof details.error === "string" && details.error.trim()) return details.error;
    if (typeof details.message === "string" && details.message.trim()) return details.message;
    if (typeof details.details === "string" && details.details.trim()) return details.details;
  }
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
};

const buildGoogleSlots = (
  tool: AppointmentTool,
  fromDate: string,
  toDate: string,
  events: Array<{ id?: string; summary?: string; start?: string; end?: string; attendeeName?: string | null; attendeeEmail?: string | null }>
) => {
  const durationMinutes = tool.appointment_types?.[0]?.duration || 30;
  const slots: Array<{ time: string; date: string; status: "available" | "booked"; summary?: string; attendeeName?: string | null; attendeeEmail?: string | null; eventId?: string; end?: string }> = [];
  const startDate = new Date(`${fromDate}T00:00:00`);
  const endDate = new Date(`${toDate}T00:00:00`);

  for (let current = new Date(startDate); current <= endDate; current.setDate(current.getDate() + 1)) {
    const dayKey = formatDayKey(current);
    const hours = tool.business_hours?.[dayKey];
    if (!hours?.enabled) continue;

    const [startHour, startMinute] = hours.start.split(":").map(Number);
    const [endHour, endMinute] = hours.end.split(":").map(Number);
    const windowStart = new Date(current);
    windowStart.setHours(startHour, startMinute, 0, 0);
    const windowEnd = new Date(current);
    windowEnd.setHours(endHour, endMinute, 0, 0);

    for (let slotStart = new Date(windowStart); slotStart < windowEnd; slotStart = new Date(slotStart.getTime() + durationMinutes * 60 * 1000)) {
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);
      if (slotEnd > windowEnd) break;

      const overlappingEvent = events.find((event) => {
        if (!event.start || !event.end) return false;
        const eventStart = new Date(event.start);
        const eventEnd = new Date(event.end);
        return slotStart < eventEnd && slotEnd > eventStart;
      });

      slots.push({
        time: slotStart.toISOString(),
        date: toDateInput(current),
        status: overlappingEvent ? "booked" : "available",
        summary: overlappingEvent?.summary,
        attendeeName: overlappingEvent?.attendeeName || null,
        attendeeEmail: overlappingEvent?.attendeeEmail || null,
        eventId: overlappingEvent?.id,
        end: overlappingEvent?.end,
      });
    }
  }

  return slots;
};

const formatSlotTime = (value?: string | null) => {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const formatSlotDateTime = (value?: string | null) => {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  });
};

const getToolDurationMinutes = (tool: AppointmentTool | null) =>
  tool?.appointment_types?.[0]?.duration || 30;

const getBaseSlotIntervalMinutes = (slots: any[]) => {
  const times = slots
    .map((slot) => (typeof slot === "object" ? (slot.time || slot.start || "") : slot))
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .sort((a, b) => a - b);

  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i += 1) {
    const diff = times[i] - times[i - 1];
    if (diff > 0 && diff < minDiff) minDiff = diff;
  }

  if (!Number.isFinite(minDiff)) return 30;
  return Math.max(1, Math.round(minDiff / (60 * 1000)));
};

const normalizeSlotsForToolDuration = (tool: AppointmentTool | null, slots: any[]) => {
  if (!tool || !Array.isArray(slots) || slots.length === 0) return slots;

  const durationMinutes = getToolDurationMinutes(tool);
  const baseIntervalMinutes = getBaseSlotIntervalMinutes(slots);
  if (durationMinutes <= baseIntervalMinutes) return slots;

  const step = Math.max(1, Math.round(durationMinutes / baseIntervalMinutes));
  const grouped: Record<string, any[]> = slots.reduce((acc: Record<string, any[]>, slot) => {
    const slotTime = typeof slot === "object" ? (slot.time || slot.start || "") : slot;
    if (!slotTime) return acc;
    const dateKey = new Date(slotTime).toISOString().slice(0, 10);
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(slot);
    return acc;
  }, {} as Record<string, any[]>);

  return Object.values(grouped).flatMap((daySlots) => {
    const sorted = [...daySlots].sort((a: any, b: any) => {
      const aTime = new Date(typeof a === "object" ? (a.time || a.start || "") : a).getTime();
      const bTime = new Date(typeof b === "object" ? (b.time || b.start || "") : b).getTime();
      return aTime - bTime;
    });

    return sorted.filter((slot: any, index: number) => {
      if (slot?.status === "booked") return true;
      return index % step === 0;
    });
  });
};

interface Props {
  agentId: string;
  userId: string;
}

export default function AgentCalendarIntegrations({ agentId, userId }: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [integrations, setIntegrations] = useState<CalendarIntegration[]>([]);
  const [tools, setTools] = useState<AppointmentTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [viewTool, setViewTool] = useState<AppointmentTool | null>(null);
  const [editTool, setEditTool] = useState<AppointmentTool | null>(null);
  const [editName, setEditName] = useState("");
  const [editHours, setEditHours] = useState<Record<string, { enabled: boolean; start: string; end: string }>>({});
  const [editTypes, setEditTypes] = useState<{ name: string; duration: number }[]>([]);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeDuration, setNewTypeDuration] = useState(30);
  const [saving, setSaving] = useState(false);

  // Live availability state
  const [availabilityFromDate, setAvailabilityFromDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [availabilityToDate, setAvailabilityToDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split("T")[0];
  });
  const [availabilityData, setAvailabilityData] = useState<any>(null);
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const [viewTab, setViewTab] = useState("config");
  const [bookingSlot, setBookingSlot] = useState<{ time: string; date: string } | null>(null);
  const [bookingName, setBookingName] = useState("Test User");
  const [bookingEmail, setBookingEmail] = useState("");
  const [bookingInProgress, setBookingInProgress] = useState(false);
  const [selectedBookedEvent, setSelectedBookedEvent] = useState<any | null>(null);
  const [detailsTool, setDetailsTool] = useState<AppointmentTool | null>(null);
  const [returnToolAfterDetails, setReturnToolAfterDetails] = useState<AppointmentTool | null>(null);
  const [rescheduleSlot, setRescheduleSlot] = useState<{ time: string; date: string } | null>(null);
  const [rescheduleInProgress, setRescheduleInProgress] = useState(false);
  const [cancelInProgress, setCancelInProgress] = useState(false);
  const [bookingsByTool, setBookingsByTool] = useState<Record<string, AppointmentBooking[]>>({});
  const activeToolForBookingDetails = detailsTool || viewTool;

  const getLinkedIntegration = useCallback((tool: AppointmentTool | null) => {
    if (!tool) return null;
    return integrations.find((item) => item.id === tool.calendar_integration_id) || null;
  }, [integrations]);

  const getFallbackIntegration = useCallback((tool: AppointmentTool | null) => {
    if (!tool) return null;
    return integrations.find((item) => item.provider === tool.provider && item.is_active) || null;
  }, [integrations]);

  const relinkToolToActiveIntegration = useCallback(async (tool: AppointmentTool) => {
    const fallbackIntegration = getFallbackIntegration(tool);
    if (!fallbackIntegration) {
      toast({
        title: "No active calendar found",
        description: `Connect an active ${PROVIDER_NAMES[tool.provider]} integration first.`,
        variant: "destructive",
      });
      return null;
    }

    const { error } = await supabase
      .from("appointment_tools" as any)
      .update({ calendar_integration_id: fallbackIntegration.id } as any)
      .eq("id", tool.id);

    if (error) {
      toast({ title: "Relink failed", description: error.message, variant: "destructive" });
      return null;
    }

    const nextTool = { ...tool, calendar_integration_id: fallbackIntegration.id };
    setTools((prev) => prev.map((item) => item.id === tool.id ? nextTool : item));
    setViewTool((prev) => prev?.id === tool.id ? nextTool : prev);
    toast({ title: "Calendar relinked", description: `${tool.name} now uses ${fallbackIntegration.display_name}.` });
    return fallbackIntegration;
  }, [getFallbackIntegration, toast]);

  const fetchGoogleAvailabilityClientSide = useCallback(async (tool: AppointmentTool, fromDate: string, toDate: string) => {
    const integration = getLinkedIntegration(tool) || getFallbackIntegration(tool);
    if (!integration) {
      throw new Error("Calendar integration not found");
    }

    const accessToken = integration.access_token || integration.api_key;
    if (!accessToken) {
      throw new Error("Google Calendar is connected without an access token");
    }

    const calendarId = integration.calendar_id || "primary";
    const start = new Date(`${fromDate}T00:00:00`);
    const end = new Date(`${toDate}T23:59:59`);
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("timeMin", start.toISOString());
    url.searchParams.set("timeMax", end.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || "Failed to fetch Google Calendar availability");
    }

    const events = (payload.items || []).map((event: any) => ({
      id: event.id,
      summary: event.summary,
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      attendeeEmail: event.attendees?.find((attendee: any) => attendee.email)?.email || null,
      attendeeName:
        event.attendees?.find((attendee: any) => attendee.displayName)?.displayName ||
        event.creator?.displayName ||
        null,
    }));

    return {
      success: true,
      events,
      slots: buildGoogleSlots(tool, fromDate, toDate, events),
    };
  }, [getFallbackIntegration, getLinkedIntegration]);

  const normalizeAvailabilityResponse = useCallback(
    (tool: AppointmentTool, fromDate: string, toDate: string, data: any) => {
      if (!data || typeof data !== "object") return data;

      if (
        tool.provider === "google_calendar" &&
        !data.error &&
        !data.slots &&
        Array.isArray(data.events)
      ) {
        return {
          ...data,
          slots: buildGoogleSlots(tool, fromDate, toDate, data.events),
        };
      }

      return data;
    },
    [],
  );

  const bookGoogleSlotClientSide = useCallback(async () => {
    if (!viewTool?.calendar_integration_id || !bookingSlot) {
      throw new Error("No Google booking slot selected");
    }

    const integration = getLinkedIntegration(viewTool) || getFallbackIntegration(viewTool);
    if (!integration) {
      throw new Error("Calendar integration not found");
    }

    const accessToken = integration.access_token || integration.api_key;
    if (!accessToken) {
      throw new Error("Google Calendar is connected without an access token");
    }

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: `Vibe AI: ${bookingName}`,
        start: { dateTime: bookingSlot.time },
        end: { dateTime: new Date(new Date(bookingSlot.time).getTime() + 30 * 60 * 1000).toISOString() },
        attendees: bookingEmail ? [{ email: bookingEmail, displayName: bookingName }] : undefined,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || "Failed to book Google Calendar event");
    }

    return payload;
  }, [bookingEmail, bookingName, bookingSlot, getFallbackIntegration, getLinkedIntegration, viewTool]);

  const fetchData = async () => {
    const nowIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const [intRes, toolsRes, bookingsRes] = await Promise.all([
      supabase.from("calendar_integrations").select("*").eq("user_id", userId).order("created_at"),
      supabase.from("appointment_tools" as any).select("*").eq("agent_id", agentId).order("created_at"),
      supabase
        .from("appointment_bookings" as any)
        .select("id,agent_id,appointment_tool_id,calendar_integration_id,provider,provider_booking_id,calendar_name,title,booked_for_name,booked_for_email,start_time,end_time,status")
        .eq("user_id", userId)
        .eq("agent_id", agentId)
        .neq("status", "cancelled")
        .gte("start_time", nowIso)
        .order("start_time", { ascending: true }),
    ]);
    setIntegrations((intRes.data as CalendarIntegration[]) || []);
    setTools((toolsRes.data as any as AppointmentTool[]) || []);
    const toolsData = ((toolsRes.data as any as AppointmentTool[]) || []);
    const groupedBookings = ((((bookingsRes.data as unknown as AppointmentBooking[]) || []).reduce((acc, booking) => {
      const inferredTool = toolsData.find((tool) => tool.id === booking.appointment_tool_id)
        || toolsData.find((tool) => tool.calendar_integration_id && tool.calendar_integration_id === booking.calendar_integration_id)
        || toolsData.find((tool) => tool.provider === booking.provider && !tool.calendar_integration_id);
      const key = inferredTool?.id || booking.appointment_tool_id || "__unlinked__";
      if (!acc[key]) acc[key] = [];
      acc[key].push(booking);
      return acc;
    }, {} as Record<string, AppointmentBooking[]>)));
    setBookingsByTool(groupedBookings);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const channel = supabase
      .channel(`appt-tools-${agentId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointment_tools" }, () => fetchData())
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_integrations" }, () => fetchData())
      .on("postgres_changes", { event: "*", schema: "public", table: "appointment_bookings" }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [agentId]);

  // Auto-fetch availability when tab switches or dates change
  useEffect(() => {
    if (viewTab === "availability" && viewTool?.calendar_integration_id) {
      fetchAvailability(viewTool, availabilityFromDate, availabilityToDate);
    }
  }, [viewTab, availabilityFromDate, availabilityToDate, viewTool]);

  const fetchAvailability = useCallback(async (tool: AppointmentTool, fromDate: string, toDate: string) => {
    if (!tool.calendar_integration_id) {
      setAvailabilityData({ error: "No calendar connected to this tool" });
      return;
    }
    setLoadingAvailability(true);
    setAvailabilityData(null);
    try {
      const linkedIntegration = getLinkedIntegration(tool);
      const effectiveIntegration = linkedIntegration || await relinkToolToActiveIntegration(tool);
      if (!effectiveIntegration) {
        setAvailabilityData({ error: "Calendar integration not found" });
        return;
      }

      if (typeof window !== "undefined" && window.location.hostname === "localhost") {
        const response = await fetch("/api/local/check-calendar-availability", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId,
            provider: tool.provider,
            integration_id: effectiveIntegration.id,
            date: fromDate,
            end_date: toDate,
          }),
        });

        const raw = await response.text();
        const data = raw ? JSON.parse(raw) : {};
        if (!response.ok) {
          throw new Error(getAvailabilityErrorMessage(data, "Failed to fetch availability"));
        }
        if (data?.error) {
          setAvailabilityData({ error: getAvailabilityErrorMessage(data, "Failed to fetch availability") });
          return;
        }
        setAvailabilityData(normalizeAvailabilityResponse(tool, fromDate, toDate, data));
      } else {
        const { data, error } = await supabase.functions.invoke("check-calendar-availability", {
          body: {
            provider: tool.provider,
            integration_id: effectiveIntegration.id,
            date: fromDate,
            end_date: toDate,
          },
        });
        if (error) throw error;
        if (data?.error) {
          setAvailabilityData({ error: getAvailabilityErrorMessage(data, "Failed to fetch availability") });
          return;
        }
        setAvailabilityData(normalizeAvailabilityResponse(tool, fromDate, toDate, data));
      }
    } catch (err: any) {
      if (tool.provider === "google_calendar" && isEdgeFunctionUnavailable(err)) {
        try {
          const fallbackData = await fetchGoogleAvailabilityClientSide(tool, fromDate, toDate);
          setAvailabilityData(fallbackData);
          return;
        } catch (fallbackErr: any) {
          const message = getErrorMessage(fallbackErr) || "Failed to fetch Google availability";
          setAvailabilityData({
            error: message.toLowerCase().includes("invalid authentication credentials")
              ? "Google Calendar access expired or is invalid. Reconnect Google Calendar from Calendar Integrations and try again."
              : message,
          });
          return;
        }
      }
      setAvailabilityData({
        error: isEdgeFunctionUnavailable(err)
          ? getFunctionUnavailableMessage("Calendar availability")
          : getErrorMessage(err) || "Failed to fetch availability"
      });
    } finally {
      setLoadingAvailability(false);
    }
  }, [getLinkedIntegration, relinkToolToActiveIntegration, fetchGoogleAvailabilityClientSide, normalizeAvailabilityResponse]);

  const handleBookSlot = async () => {
    if (!viewTool?.calendar_integration_id || !bookingSlot) return;
    setBookingInProgress(true);
    try {
      const effectiveIntegration = getLinkedIntegration(viewTool) || await relinkToolToActiveIntegration(viewTool);
      if (!effectiveIntegration) {
        throw new Error("Calendar integration not found");
      }

      const { data, error } = await supabase.functions.invoke("book-calendar-appointment", {
        body: {
          integration_id: effectiveIntegration.id,
          appointment_tool_id: viewTool.id,
          agent_id: agentId,
          start_time: bookingSlot.time,
          attendee_name: bookingName,
          attendee_email: bookingEmail || undefined,
        },
      });
      if (error) throw error;
      toast({ title: "Appointment booked successfully!", description: "The slot has been reserved." });
      setBookingSlot(null);
      // Refresh availability
      fetchAvailability(viewTool, availabilityFromDate, availabilityToDate);
    } catch (err: any) {
      if (viewTool.provider === "google_calendar" && isEdgeFunctionUnavailable(err)) {
        try {
          await bookGoogleSlotClientSide();
          toast({ title: "Appointment booked successfully!", description: "The slot has been reserved." });
          setBookingSlot(null);
          fetchAvailability(viewTool, availabilityFromDate, availabilityToDate);
          return;
        } catch (fallbackErr: any) {
          toast({
            title: "Booking failed",
            description: getErrorMessage(fallbackErr) || "Failed to book appointment",
            variant: "destructive",
          });
          return;
        }
      }
      toast({
        title: "Booking failed",
        description: getErrorMessage(err) || "Failed to book appointment",
        variant: "destructive",
      });
    } finally {
      setBookingInProgress(false);
    }
  };

  const handleRescheduleGoogleEvent = useCallback(async () => {
    if (!activeToolForBookingDetails || !selectedBookedEvent?.id || !rescheduleSlot) {
      throw new Error("No booked appointment selected for reschedule");
    }

    const integration = getLinkedIntegration(activeToolForBookingDetails) || getFallbackIntegration(activeToolForBookingDetails);
    if (!integration) {
      throw new Error("Calendar integration not found");
    }

    const accessToken = integration.access_token || integration.api_key;
    if (!accessToken) {
      throw new Error("Google Calendar is connected without an access token");
    }

    const originalDurationMs =
      selectedBookedEvent.start && selectedBookedEvent.end
        ? Math.max(15 * 60 * 1000, new Date(selectedBookedEvent.end).getTime() - new Date(selectedBookedEvent.start).getTime())
        : (activeToolForBookingDetails.appointment_types?.[0]?.duration || 30) * 60 * 1000;

    const newStart = new Date(rescheduleSlot.time);
    const newEnd = new Date(newStart.getTime() + originalDurationMs);

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events/${encodeURIComponent(selectedBookedEvent.id)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
  }, [activeToolForBookingDetails, getFallbackIntegration, getLinkedIntegration, rescheduleSlot, selectedBookedEvent]);

  const syncClientBookingRecord = useCallback(async (next: { status?: string; start_time?: string; end_time?: string | null }) => {
    if (!activeToolForBookingDetails || !selectedBookedEvent?.id) return;
    await supabase
      .from("appointment_bookings" as any)
      .update(next as any)
      .eq("calendar_integration_id", activeToolForBookingDetails.calendar_integration_id)
      .eq("provider_booking_id", selectedBookedEvent.id);
  }, [activeToolForBookingDetails, selectedBookedEvent]);

  const manageStoredBooking = useCallback(async (action: "cancel" | "reschedule", startTime?: string) => {
    if (!selectedBookedEvent?.bookingId) {
      throw new Error("This booking is not linked to a saved appointment record.");
    }

    if (typeof window !== "undefined" && window.location.hostname === "localhost") {
      const response = await fetch("/api/local/manage-calendar-booking", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          booking_id: selectedBookedEvent.bookingId,
          action,
          start_time: startTime,
        }),
      });

      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!response.ok) {
        const details =
          typeof data?.details === "string"
            ? data.details
            : data?.details?.error || data?.details?.message || data?.error;
        throw new Error(details || "Booking action failed");
      }
      if (data?.error) throw new Error(data.error);
      return data;
    }

    const { data, error } = await supabase.functions.invoke("manage-calendar-booking", {
      body: {
        booking_id: selectedBookedEvent.bookingId,
        action,
        start_time: startTime,
      },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  }, [selectedBookedEvent, userId]);

  const handleCancelGoogleEvent = useCallback(async () => {
    if (!activeToolForBookingDetails || !selectedBookedEvent?.id) {
      throw new Error("No booked appointment selected for cancellation");
    }

    const integration = getLinkedIntegration(activeToolForBookingDetails) || getFallbackIntegration(activeToolForBookingDetails);
    if (!integration) {
      throw new Error("Calendar integration not found");
    }

    const accessToken = integration.access_token || integration.api_key;
    if (!accessToken) {
      throw new Error("Google Calendar is connected without an access token");
    }

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id || "primary")}/events/${encodeURIComponent(selectedBookedEvent.id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || "Failed to cancel Google Calendar event");
    }
  }, [activeToolForBookingDetails, getFallbackIntegration, getLinkedIntegration, selectedBookedEvent]);

  const handleReschedule = async () => {
    if (!selectedBookedEvent || !rescheduleSlot || !activeToolForBookingDetails) return;
    setRescheduleInProgress(true);
    try {
      if (selectedBookedEvent.bookingId) {
        await manageStoredBooking("reschedule", rescheduleSlot.time);
      } else if (activeToolForBookingDetails.provider === "google_calendar") {
        await handleRescheduleGoogleEvent();
        await syncClientBookingRecord({
          start_time: rescheduleSlot.time,
          end_time: new Date(
            new Date(rescheduleSlot.time).getTime() +
              (selectedBookedEvent.start && selectedBookedEvent.end
                ? Math.max(15 * 60 * 1000, new Date(selectedBookedEvent.end).getTime() - new Date(selectedBookedEvent.start).getTime())
                : getToolDurationMinutes(activeToolForBookingDetails) * 60 * 1000),
          ).toISOString(),
        });
      } else {
        throw new Error("Rescheduling is not supported for this booking.");
      }
      toast({ title: "Appointment rescheduled", description: "The meeting date and time were updated." });
      setSelectedBookedEvent(null);
      setDetailsTool(null);
      setRescheduleSlot(null);
      fetchAvailability(activeToolForBookingDetails, availabilityFromDate, availabilityToDate);
      fetchData();
    } catch (err: any) {
      toast({
        title: "Reschedule failed",
        description: getErrorMessage(err) || "Failed to reschedule appointment",
        variant: "destructive",
      });
    } finally {
      setRescheduleInProgress(false);
    }
  };

  const handleCancelBooking = async () => {
    if (!selectedBookedEvent || !activeToolForBookingDetails) return;
    setCancelInProgress(true);
    try {
      if (selectedBookedEvent.bookingId) {
        await manageStoredBooking("cancel");
      } else if (activeToolForBookingDetails.provider === "google_calendar") {
        await handleCancelGoogleEvent();
        await syncClientBookingRecord({ status: "cancelled" });
      } else {
        throw new Error("Deletion is not supported for this booking.");
      }
      toast({ title: "Appointment cancelled", description: "The booking was removed from the calendar." });
      setSelectedBookedEvent(null);
      setDetailsTool(null);
      setRescheduleSlot(null);
      fetchAvailability(activeToolForBookingDetails, availabilityFromDate, availabilityToDate);
      fetchData();
    } catch (err: any) {
      toast({
        title: "Cancel failed",
        description: getErrorMessage(err) || "Failed to cancel appointment",
        variant: "destructive",
      });
    } finally {
      setCancelInProgress(false);
    }
  };

  const openViewTool = (tool: AppointmentTool) => {
    setViewTool(tool);
    setDetailsTool(null);
    setReturnToolAfterDetails(null);
    setViewTab("config");
    setAvailabilityData(null);
    setAvailabilityFromDate(new Date().toISOString().split("T")[0]);
    const d = new Date(); d.setDate(d.getDate() + 7);
    setAvailabilityToDate(d.toISOString().split("T")[0]);
    setSelectedBookedEvent(null);
    setRescheduleSlot(null);
  };

  const openBookedEventDetails = (tool: AppointmentTool, event: any) => {
    setDetailsTool(tool);
    setReturnToolAfterDetails(tool);
    setViewTool(null);
    setViewTab("availability");
    setSelectedBookedEvent(event);
    setRescheduleSlot(null);
  };

  const closeBookedEventDetails = () => {
    setSelectedBookedEvent(null);
    setRescheduleSlot(null);
    setDetailsTool(null);
    if (returnToolAfterDetails) {
      setViewTool(returnToolAfterDetails);
      setViewTab("availability");
      setReturnToolAfterDetails(null);
    }
  };

  const groupedBookedEvents: Record<string, any[]> = Array.isArray(availabilityData?.events)
    ? availabilityData.events.reduce((acc: Record<string, any[]>, event: any) => {
        const dateKey = event.start ? new Date(event.start).toISOString().slice(0, 10) : "unknown";
        if (!acc[dateKey]) acc[dateKey] = [];
        acc[dateKey].push(event);
        return acc;
      }, {} as Record<string, any[]>)
    : {};

  const getBookingsForTool = useCallback((tool: AppointmentTool | null) => {
    if (!tool) return [];
    return bookingsByTool[tool.id] || [];
  }, [bookingsByTool]);

  const getSlotsWithPersistedBookings = useCallback((tool: AppointmentTool | null, slots: any[]) => {
    if (!tool || !Array.isArray(slots)) return [];
    const bookings = getBookingsForTool(tool);
    if (!bookings.length) return slots;
    const durationMinutes = getToolDurationMinutes(tool);
    const mergedSlots = slots.map((slot) => {
      if (typeof slot !== "object") return slot;
      if (slot.status === "booked") return slot;
      const slotStartIso = slot.time || slot.start;
      if (!slotStartIso) return slot;
      const slotStart = new Date(slotStartIso);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);
      const matchingBooking = bookings.find((booking) => {
        const bookingStart = new Date(booking.start_time);
        const bookingEnd = booking.end_time
          ? new Date(booking.end_time)
          : new Date(bookingStart.getTime() + durationMinutes * 60 * 1000);
        return slotStart.getTime() === bookingStart.getTime();
      });

      if (!matchingBooking) return slot;
      return {
        ...slot,
        status: "booked",
        summary: matchingBooking.title || "Booked appointment",
        attendeeName: matchingBooking.booked_for_name,
        attendeeEmail: matchingBooking.booked_for_email,
        bookingId: matchingBooking.id,
        eventId: matchingBooking.provider_booking_id || matchingBooking.id,
        providerBookingId: matchingBooking.provider_booking_id || null,
        provider: matchingBooking.provider || tool.provider,
        end: matchingBooking.end_time,
      };
    });

    const syntheticBookedSlots = bookings
      .filter((booking) => {
        const bookingStart = new Date(booking.start_time).getTime();
      return !mergedSlots.some((slot: any) => {
        if (typeof slot !== "object") return false;
        const slotStartIso = slot.time || slot.start;
        if (!slotStartIso) return false;
        return new Date(slotStartIso).getTime() === bookingStart;
        });
      })
      .map((booking) => ({
        time: booking.start_time,
        date: toDateInput(new Date(booking.start_time)),
        status: "booked" as const,
        summary: booking.title || "Booked appointment",
        attendeeName: booking.booked_for_name,
        attendeeEmail: booking.booked_for_email,
        bookingId: booking.id,
        eventId: booking.provider_booking_id || booking.id,
        providerBookingId: booking.provider_booking_id || null,
        provider: booking.provider || tool.provider,
        end: booking.end_time,
      }));

    return [...mergedSlots, ...syntheticBookedSlots].sort((a: any, b: any) => {
      const aTime = typeof a === "object" ? (a.time || a.start || "") : a;
      const bTime = typeof b === "object" ? (b.time || b.start || "") : b;
      return new Date(aTime).getTime() - new Date(bTime).getTime();
    });
  }, [getBookingsForTool]);

  const toggleTool = async (id: string, current: boolean) => {
    await supabase.from("appointment_tools" as any).update({ is_active: !current } as any).eq("id", id);
    fetchData();
  };

  const deleteTool = async (id: string) => {
    const { error } = await supabase.from("appointment_tools" as any).delete().eq("id", id);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else { toast({ title: "Appointment tool removed" }); fetchData(); }
  };

  const openEdit = (tool: AppointmentTool) => {
    setEditTool(tool);
    setEditName(tool.name);
    setEditHours(tool.business_hours);
    setEditTypes([...tool.appointment_types]);
    setNewTypeName("");
    setNewTypeDuration(30);
    setViewTool(null);
  };

  const handleSaveEdit = async () => {
    if (!editTool) return;
    setSaving(true);
    const { error } = await supabase.from("appointment_tools" as any).update({
      name: editName.trim(),
      business_hours: editHours,
      appointment_types: editTypes,
    } as any).eq("id", editTool.id);
    setSaving(false);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else { toast({ title: "Appointment tool updated" }); setEditTool(null); fetchData(); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Connect calendars so this agent can check availability and book appointments during calls.</p>

      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {tools.length > 0 && (
            <div className="space-y-3">
              {tools.map(tool => (
                <Card key={tool.id} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => openViewTool(tool)}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <img src={PROVIDER_LOGOS[tool.provider]} alt={PROVIDER_NAMES[tool.provider]} className="h-8 w-8 rounded object-contain" />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{tool.name}</span>
                          <Badge variant={tool.is_active ? "default" : "secondary"} className="text-xs">
                            {tool.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Booked on: {getLinkedIntegration(tool)?.display_name || getFallbackIntegration(tool)?.display_name || "No linked calendar"}
                        </div>
                        {bookingsByTool[tool.id]?.length ? (
                          <div className="space-y-0.5">
                            {bookingsByTool[tool.id].slice(0, 3).map((booking) => (
                              <div key={booking.id} className="text-xs text-muted-foreground">
                                {booking.booked_for_name || booking.booked_for_email || "Booked user"} ·{" "}
                                {formatSlotDateTime(booking.start_time)}
                              </div>
                            ))}
                            {bookingsByTool[tool.id].length > 3 && (
                              <div className="text-xs text-muted-foreground">+{bookingsByTool[tool.id].length - 3} more bookings</div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">No booked appointments yet</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-3">
                        <Switch checked={tool.is_active} onCheckedChange={() => toggleTool(tool.id, tool.is_active)} />
                        
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(tool)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              className="text-destructive focus:text-destructive" 
                              onClick={() => deleteTool(tool.id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Button variant="outline" size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Appointment Tool
          </Button>
        </>
      )}

      {/* View Tool Details Dialog */}
      <Dialog open={!!viewTool} onOpenChange={(open) => { if (!open) setViewTool(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {viewTool && <img src={PROVIDER_LOGOS[viewTool.provider]} alt="" className="h-6 w-6 rounded object-contain" />}
              {viewTool?.name}
            </DialogTitle>
            <DialogDescription className="sr-only">
              View appointment tool configuration, linked calendar details, current bookings, and live availability.
            </DialogDescription>
          </DialogHeader>
          {viewTool && (
            <Tabs value={viewTab} onValueChange={setViewTab} className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="config" className="flex-1">Configuration</TabsTrigger>
                <TabsTrigger value="availability" className="flex-1">
                  <Calendar className="h-4 w-4 mr-1" /> Live Availability
                </TabsTrigger>
              </TabsList>

              <TabsContent value="config" className="space-y-5 mt-4">
                <div className="flex items-center gap-2">
                  <Badge variant={viewTool.is_active ? "default" : "secondary"}>
                    {viewTool.is_active ? "Active" : "Inactive"}
                  </Badge>
                  <span className="text-sm text-muted-foreground">{PROVIDER_NAMES[viewTool.provider]}</span>
                  {viewTool.calendar_integration_id && (
                    <Badge variant="outline" className="text-xs">Calendar Connected</Badge>
                  )}
                </div>

                <div>
                  <h4 className="font-semibold text-sm mb-2">Business Hours</h4>
                  <div className="space-y-1.5">
                    {DAYS.map(day => {
                      const h = viewTool.business_hours[day];
                      return (
                        <div key={day} className="flex items-center justify-between text-sm">
                          <span className={h?.enabled ? "font-medium" : "text-muted-foreground"}>{day}</span>
                          <span className={h?.enabled ? "" : "text-muted-foreground"}>
                            {h?.enabled ? `${h.start} – ${h.end}` : "Closed"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <h4 className="font-semibold text-sm mb-2">Appointment Types</h4>
                  <div className="space-y-1.5">
                    {viewTool.appointment_types.map((t, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                        <span className="font-medium">{t.name}</span>
                        <span className="text-muted-foreground">{t.duration} min</span>
                      </div>
                    ))}
                  </div>
                </div>

                <Button variant="outline" className="w-full" onClick={() => openEdit(viewTool)}>
                  <Pencil className="h-4 w-4 mr-1" /> Edit Tool
                </Button>
              </TabsContent>

              <TabsContent value="availability" className="space-y-4 mt-4">
                {!viewTool.calendar_integration_id ? (
                  <div className="text-center py-6 text-sm text-muted-foreground">
                    <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No calendar connected to this tool.</p>
                    <p className="text-xs mt-1">Connect a calendar integration first to check live availability.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">From</Label>
                        <Input
                          type="date"
                          value={availabilityFromDate}
                          onChange={e => setAvailabilityFromDate(e.target.value)}
                        />
                      </div>
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">To</Label>
                        <Input
                          type="date"
                          value={availabilityToDate}
                          onChange={e => setAvailabilityToDate(e.target.value)}
                        />
                      </div>
                    </div>

                    {loadingAvailability && (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    )}

                    {availabilityData && !loadingAvailability && (
                      <div className="space-y-3">
                        {availabilityData.error ? (
                          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive space-y-3">
                            <div>{availabilityData.error}</div>
                            {String(availabilityData.error).toLowerCase().includes("reconnect google calendar") && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-destructive/30 bg-background text-destructive hover:bg-destructive/5 hover:text-destructive"
                                onClick={() => navigate(getVibePath("voice", "calendar-integrations"))}
                              >
                                Reconnect Google Calendar
                              </Button>
                            )}
                          </div>
                        ) : availabilityData.slots ? (
                          <>
                            <h4 className="font-semibold text-sm">Available Slots ({availabilityFromDate} to {availabilityToDate})</h4>
                            {(Array.isArray(availabilityData.slots) && availabilityData.slots.length === 0) ? (
                              <p className="text-sm text-muted-foreground">No available slots found.</p>
                              ) : Array.isArray(availabilityData.slots) ? (
                                <div className="grid grid-cols-3 gap-2">
                                  {normalizeSlotsForToolDuration(
                                    viewTool,
                                    getSlotsWithPersistedBookings(viewTool, availabilityData.slots),
                                  ).map((slot: any, i: number) => {
                                    const slotTime = typeof slot === "string" ? slot : (slot.time || slot.start || "");
                                    const slotDate = typeof slot === "object" && slot.date ? slot.date : "";
                                    const slotStatus = typeof slot === "object" ? slot.status : "available";
                                    const isBooked = slotStatus === "booked";
                                    const dt = slotTime ? new Date(slotTime) : null;
                                    const slotCard = (
                                      <div
                                        key={i}
                                        className={`rounded-md border px-2 py-1.5 text-xs text-center font-medium transition-colors ${
                                          isBooked
                                            ? "cursor-pointer border-green-300 bg-green-50 text-green-800 hover:bg-green-100"
                                            : "cursor-pointer hover:bg-accent hover:border-primary"
                                        }`}
                                        onClick={() => {
                                          if (isBooked) {
                                            openBookedEventDetails(viewTool, {
                                              bookingId: slot.bookingId || null,
                                              id: slot.eventId,
                                              summary: slot.summary,
                                              start: slotTime,
                                              end: slot.end,
                                              attendeeName: slot.attendeeName || null,
                                              attendeeEmail: slot.attendeeEmail || null,
                                              providerBookingId: slot.providerBookingId || null,
                                              provider: slot.provider || viewTool.provider,
                                            });
                                          } else {
                                            setBookingSlot({ time: slotTime, date: slotDate });
                                          }
                                        }}
                                      >
                                        {slotDate && <div className="text-muted-foreground">{new Date(slotDate + "T00:00:00").toLocaleDateString([], { day: '2-digit', month: 'short' })}</div>}
                                        <div>{dt ? formatSlotTime(slotTime) : JSON.stringify(slot)}</div>
                                      </div>
                                    );

                                    if (!isBooked) {
                                      return slotCard;
                                    }

                                    return (
                                      <Tooltip key={i} delayDuration={80}>
                                        <TooltipTrigger asChild>{slotCard}</TooltipTrigger>
                                        <TooltipContent side="top" className="max-w-56 p-3">
                                          <div className="space-y-1 text-xs">
                                            <div className="font-medium text-foreground">{slot.summary || "Booked appointment"}</div>
                                            <div>{dt ? formatSlotDateTime(slotTime) : slotTime}</div>
                                            <div>{slot.attendeeName || slot.attendeeEmail || "Booked attendee"}</div>
                                            {slot.attendeeEmail && slot.attendeeName && (
                                              <div className="text-muted-foreground">{slot.attendeeEmail}</div>
                                            )}
                                            <div className="text-muted-foreground">Click to reschedule or cancel</div>
                                          </div>
                                        </TooltipContent>
                                      </Tooltip>
                                    );
                                  })}
                                </div>
                            ) : (
                              <pre className="text-xs bg-muted p-2 rounded overflow-auto">{JSON.stringify(availabilityData.slots, null, 2)}</pre>
                            )}

                            {Array.isArray(availabilityData.events) && availabilityData.events.length > 0 && (
                              <div className="space-y-3 pt-2">
                                <h4 className="font-semibold text-sm">Booked Appointments</h4>
                                {Object.entries(groupedBookedEvents).map(([dateKey, events]) => (
                                  <div key={dateKey} className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {new Date(`${dateKey}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                                    </div>
                                    <div className="space-y-1.5">
                                      {events.map((evt: any, i: number) => (
                                        <div
                                          key={`${dateKey}-${i}`}
                                          className="rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent/50"
                                          onClick={() => {
                                            openBookedEventDetails(viewTool, evt);
                                          }}
                                        >
                                          <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium">{evt.summary || "Booked appointment"}</span>
                                            <span className="text-muted-foreground text-xs">
                                              {evt.start ? formatSlotTime(evt.start) : ""}
                                              {evt.end ? ` – ${formatSlotTime(evt.end)}` : ""}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-xs text-muted-foreground">
                                            {evt.attendeeName ? `Booked for ${evt.attendeeName}` : evt.attendeeEmail ? `Booked for ${evt.attendeeEmail}` : "Booked"}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : availabilityData.events ? (
                          <>
                            <h4 className="font-semibold text-sm">Booked Appointments ({availabilityFromDate} to {availabilityToDate})</h4>
                            {availabilityData.events.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No appointments booked in this date range.</p>
                            ) : (
                              <div className="space-y-3">
                                {Object.entries(groupedBookedEvents).map(([dateKey, events]) => (
                                  <div key={dateKey} className="space-y-2">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {new Date(`${dateKey}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                                    </div>
                                    <div className="space-y-1.5">
                                      {events.map((evt: any, i: number) => (
                                        <div
                                          key={`${dateKey}-${i}`}
                                          className="rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent/50"
                                          onClick={() => {
                                            openBookedEventDetails(viewTool, evt);
                                          }}
                                        >
                                          <div className="flex items-center justify-between gap-3">
                                            <span className="font-medium">{evt.summary || "Booked appointment"}</span>
                                            <span className="text-muted-foreground text-xs">
                                              {evt.start ? formatSlotTime(evt.start) : ""}
                                              {evt.end ? ` – ${formatSlotTime(evt.end)}` : ""}
                                            </span>
                                          </div>
                                          <div className="mt-1 text-xs text-muted-foreground">
                                            {evt.attendeeName ? `Booked for ${evt.attendeeName}` : evt.attendeeEmail ? `Booked for ${evt.attendeeEmail}` : "Booked"}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-sm">
                            <Badge variant="outline" className="mb-2">Connection OK</Badge>
                            {availabilityData.calendar && <p className="text-muted-foreground">Calendar: {availabilityData.calendar}</p>}
                            {availabilityData.user && <p className="text-muted-foreground">User: {availabilityData.user}</p>}
                          </div>
                        )}
                      </div>
                    )}

                    {!availabilityData && !loadingAvailability && (
                      <div className="text-center py-6 text-sm text-muted-foreground">
                        <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p>Loading availability...</p>
                      </div>
                    )}
                  </>
                )}
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedBookedEvent} onOpenChange={(open) => { if (!open) closeBookedEventDetails(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Appointment Details</DialogTitle>
            <DialogDescription className="sr-only">
              Review the selected booking and use the available actions to reschedule or delete it.
            </DialogDescription>
          </DialogHeader>
          {selectedBookedEvent && (
            <div className="space-y-4">
              <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
                <div className="font-medium">{selectedBookedEvent.summary || "Booked appointment"}</div>
                <div className="mt-1 text-xs">
                  {selectedBookedEvent.start ? formatSlotDateTime(selectedBookedEvent.start) : ""}
                  {selectedBookedEvent.end
                    ? ` - ${formatSlotTime(selectedBookedEvent.end)}`
                    : ""}
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div><span className="font-medium">Booked for:</span> {selectedBookedEvent.attendeeName || "Unknown attendee"}</div>
                {selectedBookedEvent.attendeeEmail && (
                  <div><span className="font-medium">Email:</span> {selectedBookedEvent.attendeeEmail}</div>
                )}
                {!selectedBookedEvent.bookingId && activeToolForBookingDetails?.provider !== "google_calendar" && (
                  <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                    This booking is not linked to a saved Vibe AI booking record, so reschedule and delete are unavailable here.
                  </div>
                )}
              </div>

              {(selectedBookedEvent.bookingId || activeToolForBookingDetails?.provider === "google_calendar") && (
                <div className="space-y-3">
                  <div className="font-medium text-sm">Reschedule meeting</div>
                  {Array.isArray(availabilityData?.slots) && normalizeSlotsForToolDuration(activeToolForBookingDetails, availabilityData.slots).filter((slot: any) => (typeof slot === "object" ? slot.status !== "booked" : true)).length > 0 ? (
                    <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
                      {normalizeSlotsForToolDuration(activeToolForBookingDetails, availabilityData.slots)
                        .filter((slot: any) => (typeof slot === "object" ? slot.status !== "booked" : true))
                        .map((slot: any, i: number) => {
                          const slotTime = typeof slot === "string" ? slot : (slot.time || slot.start || "");
                          const slotDate = typeof slot === "object" && slot.date ? slot.date : "";
                          const isSelected = rescheduleSlot?.time === slotTime;
                          const dt = slotTime ? new Date(slotTime) : null;
                          return (
                            <button
                              key={`reschedule-${i}`}
                              type="button"
                              className={`rounded-md border px-2 py-1.5 text-xs text-center font-medium transition-colors ${
                                isSelected ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent hover:border-primary"
                              }`}
                              onClick={() => setRescheduleSlot({ time: slotTime, date: slotDate })}
                            >
                              {slotDate && <div className="text-muted-foreground">{new Date(slotDate + "T00:00:00").toLocaleDateString([], { day: "2-digit", month: "short" })}</div>}
                          <div>{dt ? formatSlotTime(slotTime) : slotTime}</div>
                        </button>
                      );
                    })}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">No alternate available slots found in the current date range.</div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={closeBookedEventDetails}>
                  Close
                </Button>
                {(selectedBookedEvent.bookingId || activeToolForBookingDetails?.provider === "google_calendar") && (
                  <Button variant="destructive" onClick={handleCancelBooking} disabled={cancelInProgress || rescheduleInProgress}>
                    {cancelInProgress ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {cancelInProgress ? "Deleting..." : "Delete Booking"}
                  </Button>
                )}
                {(selectedBookedEvent.bookingId || activeToolForBookingDetails?.provider === "google_calendar") && (
                  <Button onClick={handleReschedule} disabled={!rescheduleSlot || rescheduleInProgress}>
                    {rescheduleInProgress ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {rescheduleInProgress ? "Rescheduling..." : "Reschedule"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Manual Booking Dialog */}
      <Dialog open={!!bookingSlot} onOpenChange={(open) => { if (!open) setBookingSlot(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Book Appointment</DialogTitle>
            <DialogDescription className="sr-only">
              Confirm the selected time slot and enter attendee details to create a new appointment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="text-sm text-muted-foreground bg-accent/50 p-3 rounded-md">
              <span className="font-semibold text-foreground">Selected Slot:</span>{" "}
              {bookingSlot && formatSlotDateTime(bookingSlot.time)}
            </div>
            <div className="space-y-2">
              <Label htmlFor="book-name">Attendee Name</Label>
              <Input id="book-name" value={bookingName} onChange={e => setBookingName(e.target.value)} placeholder="Full Name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="book-email">Attendee Email (optional)</Label>
              <Input id="book-email" type="email" value={bookingEmail} onChange={e => setBookingEmail(e.target.value)} placeholder="email@example.com" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBookingSlot(null)} disabled={bookingInProgress}>Cancel</Button>
            <Button onClick={handleBookSlot} disabled={bookingInProgress || !bookingName.trim()}>
              {bookingInProgress ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {bookingInProgress ? "Booking..." : "Confirm Booking"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Tool Dialog */}
      <Dialog open={!!editTool} onOpenChange={(open) => { if (!open) setEditTool(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Appointment Tool</DialogTitle>
            <DialogDescription className="sr-only">
              Update this appointment tool’s name, business hours, and appointment duration options.
            </DialogDescription>
          </DialogHeader>
          {editTool && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label>Tool Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} />
              </div>

              <div className="rounded-lg border bg-card p-5 space-y-4">
                <h3 className="font-semibold text-sm">Business Hours</h3>
                <div className="space-y-3">
                  {DAYS.map(day => {
                    const hours = editHours[day] || { enabled: false, start: "09:00", end: "17:00" };
                    return (
                      <div key={day} className="flex items-center gap-3">
                        <div className="flex items-center gap-2 w-32">
                          <Checkbox
                            checked={hours.enabled}
                            onCheckedChange={(checked) =>
                              setEditHours({ ...editHours, [day]: { ...hours, enabled: !!checked } })
                            }
                          />
                          <span className="text-sm font-medium">{day}</span>
                        </div>
                        {hours.enabled ? (
                          <div className="flex items-center gap-2">
                            <Input type="time" value={hours.start}
                              onChange={e => setEditHours({ ...editHours, [day]: { ...hours, start: e.target.value } })}
                              className="w-32" />
                            <span className="text-muted-foreground text-sm">to</span>
                            <Input type="time" value={hours.end}
                              onChange={e => setEditHours({ ...editHours, [day]: { ...hours, end: e.target.value } })}
                              className="w-32" />
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">Closed</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border bg-card p-5 space-y-4">
                <h3 className="font-semibold text-sm">Appointment Types</h3>
                <div className="space-y-2">
                  {editTypes.map((type, i) => (
                    <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div>
                        <span className="text-sm font-medium">{type.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">{type.duration} min</span>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setEditTypes(editTypes.filter((_, idx) => idx !== i))} className="text-destructive h-7 px-2">
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">Name</Label>
                    <Input placeholder="e.g. Follow-up" value={newTypeName} onChange={e => setNewTypeName(e.target.value)} />
                  </div>
                  <div className="w-24 space-y-1">
                    <Label className="text-xs">Duration (min)</Label>
                    <Input type="number" min={5} step={5} value={newTypeDuration} onChange={e => setNewTypeDuration(parseInt(e.target.value) || 30)} />
                  </div>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (!newTypeName.trim()) return;
                    setEditTypes([...editTypes, { name: newTypeName.trim(), duration: newTypeDuration }]);
                    setNewTypeName(""); setNewTypeDuration(30);
                  }} disabled={!newTypeName.trim()}>
                    <Plus className="h-4 w-4 mr-1" /> Add
                  </Button>
                </div>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setEditTool(null)}>Cancel</Button>
                <Button onClick={handleSaveEdit} disabled={saving || !editName.trim() || editTypes.length === 0}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <CreateAppointmentToolDialog
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        integrations={integrations}
        onNavigateToCalendarIntegrations={() => { setWizardOpen(false); navigate(getVibePath("voice", "calendar-integrations")); }}
        agentId={agentId}
        userId={userId}
        onToolCreated={() => { toast({ title: "Appointment tool created" }); fetchData(); }}
      />
    </div>
  );
}
