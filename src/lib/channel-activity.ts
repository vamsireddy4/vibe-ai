import { eachDayOfInterval, format } from "date-fns";

export const CHANNELS = ["calls", "sms", "whatsapp", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One dated event: a call, or N SMS / emails sent by a campaign run, or one WhatsApp message. */
export type ChannelEvent = { channel: Channel; at: string; count?: number };

export type DayRow = { day: string; label: string } & Record<Channel, number>;

/** Per-day counts for every channel from `start` to `end` (inclusive, local days); days with nothing are 0. */
export function bucketByDay(events: ChannelEvent[], start: Date, end: Date): DayRow[] {
  const rows = new Map<string, DayRow>();
  for (const d of eachDayOfInterval({ start, end })) {
    const day = format(d, "yyyy-MM-dd");
    rows.set(day, { day, label: format(d, "MMM d"), calls: 0, sms: 0, whatsapp: 0, email: 0 });
  }
  for (const e of events) {
    const row = rows.get(format(new Date(e.at), "yyyy-MM-dd"));
    if (row) row[e.channel] += e.count ?? 1;
  }
  return [...rows.values()];
}
