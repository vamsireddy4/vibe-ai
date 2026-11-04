import { useEffect, useMemo, useState } from "react";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import { CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { CalendarIcon, Mail, MessageCircleMore, MessageSquareText, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { bucketByDay, CHANNELS, type Channel, type ChannelEvent } from "@/lib/channel-activity";

// The app's black-and-white palette: four grey steps, darkest first (stepped again for dark mode).
// All solid lines (user's choice); greys alone are close, so every series is also named with its
// number in the cards, legend and donut list, and the tooltip names each line on hover.
const chartConfig = {
  calls: { label: "Calls", theme: { light: "#171717", dark: "#fafafa" } },
  sms: { label: "SMS sent", theme: { light: "#525252", dark: "#bdbdbd" } },
  whatsapp: { label: "WhatsApp", theme: { light: "#8a8a8a", dark: "#8a8a8a" } },
  email: { label: "Emails sent", theme: { light: "#bdbdbd", dark: "#5c5c5c" } },
} satisfies ChartConfig;

// The same colors as CSS variables for the cards / legend / bars outside the chart (light, then dark mode).
const SERIES_CSS = (["light", "dark"] as const)
  .map((mode) => `${mode === "dark" ? ".dark " : ""}.channel-colors{${CHANNELS.map((ch) => `--color-${ch}:${chartConfig[ch].theme[mode]};`).join("")}}`)
  .join("");

const ICONS: Record<Channel, typeof PhoneCall> = { calls: PhoneCall, sms: MessageSquareText, whatsapp: MessageCircleMore, email: Mail };
const RANGES = { "7": "Last 7 days", "30": "Last month", "90": "Last 3 months", custom: "Custom dates" } as const;
const daysAgo = (n: number) => startOfDay(subDays(new Date(), n - 1));

/** Rows from a table, or [] when it is missing or the read fails (a channel with no data shows 0, never breaks the page). */
async function rows<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) console.warn("dashboard: channel data unavailable", error);
  return data ?? [];
}

/** All channels on one dashboard: totals, one chart with a line per channel, and each channel's share. */
export default function AllDashboard() {
  const { user } = useAuth();
  const [range, setRange] = useState<keyof typeof RANGES>("30");
  const [events, setEvents] = useState<ChannelEvent[] | null>(null);
  const [talkSeconds, setTalkSeconds] = useState(0);
  // A preset sets both dates; picking a date by hand switches the dropdown to "Custom dates".
  const [start, setStart] = useState(() => daysAgo(30));
  const [end, setEnd] = useState(() => startOfDay(new Date()));
  const pickRange = (v: keyof typeof RANGES) => {
    setRange(v);
    if (v !== "custom") { setStart(daysAgo(Number(v))); setEnd(startOfDay(new Date())); }
  };
  const pickDate = (which: "start" | "end", d: Date | undefined) => {
    if (!d) return;
    setRange("custom");
    // Keep start <= end: moving one past the other moves both.
    if (which === "start") { setStart(d); if (d > end) setEnd(d); } else { setEnd(d); if (d < start) setStart(d); }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const since = start.toISOString();
    const until = endOfDay(end).toISOString();
    // RLS scopes every table to this user.
    Promise.all([
      rows(supabase.from("call_logs").select("started_at, duration").gte("started_at", since).lte("started_at", until)),
      rows(supabase.from("sms_completed_campaigns").select("started_at, sent_count").gte("started_at", since).lte("started_at", until)),
      rows(supabase.from("whatsapp_messages").select("sent_at").gte("sent_at", since).lte("sent_at", until)),
      rows(supabase.from("gmail_completed_campaigns" as any).select("started_at, sent_count").gte("started_at", since).lte("started_at", until)),
    ]).then(([calls, sms, whatsapp, email]) => {
      if (cancelled) return;
      setTalkSeconds(calls.reduce((s, c: any) => s + (c.duration ?? 0), 0));
      setEvents([
        ...calls.map((c: any) => ({ channel: "calls" as const, at: c.started_at })),
        ...sms.map((r: any) => ({ channel: "sms" as const, at: r.started_at, count: r.sent_count ?? 0 })),
        ...whatsapp.map((m: any) => ({ channel: "whatsapp" as const, at: m.sent_at })),
        ...email.map((r: any) => ({ channel: "email" as const, at: r.started_at, count: r.sent_count ?? 0 })),
      ]);
    });
    return () => { cancelled = true; };
  }, [user, start, end]);

  const days = useMemo(() => (events ? bucketByDay(events, start, end) : []), [events, start, end]);
  const totals = useMemo(
    () => Object.fromEntries(CHANNELS.map((ch) => [ch, days.reduce((s, d) => s + d[ch], 0)])) as Record<Channel, number>,
    [days],
  );
  const grand = CHANNELS.reduce((s, ch) => s + totals[ch], 0);

  return (
    <DashboardLayout>
      <style>{SERIES_CSS}</style>
      <div className="channel-colors space-y-6 animate-rise-in">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <p className="mt-1 text-muted-foreground">Calls, SMS, WhatsApp and email activity in one place.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={range} onValueChange={(v) => pickRange(v as keyof typeof RANGES)}>
            <SelectTrigger className="h-10 w-48" aria-label="Time range"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(RANGES).map(([v, label]) => <SelectItem key={v} value={v}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          {(["start", "end"] as const).map((which, i) => {
            const value = which === "start" ? start : end;
            return (
              <div key={which} className="flex items-center gap-3">
                {i === 1 && <span className="text-sm text-muted-foreground">to</span>}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="h-10 w-44 justify-between font-normal" aria-label={which === "start" ? "Start date" : "End date"}>
                      {format(value, "dd/MM/yyyy")}
                      <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={value} onSelect={(d) => pickDate(which, d)} disabled={{ after: new Date() }} initialFocus />
                  </PopoverContent>
                </Popover>
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {CHANNELS.map((ch) => {
            const Icon = ICONS[ch];
            return (
              <Card key={ch}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden />
                    {chartConfig[ch].label}
                  </div>
                  <p className="mt-3 text-3xl font-semibold tabular-nums">{events ? totals[ch].toLocaleString() : "—"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {ch === "calls" ? `${Math.round(talkSeconds / 60)} min talk time` : `${format(start, "d MMM")} – ${format(end, "d MMM")}`}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-lg">Activity over time</CardTitle>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
                {CHANNELS.map((ch) => (
                  <li key={ch} className="flex items-center gap-1.5">
                    <svg width="18" height="4" aria-hidden><line x1="0" y1="2" x2="18" y2="2" stroke={`var(--color-${ch})`} strokeWidth="2"  /></svg>
                    {chartConfig[ch].label} <span className="tabular-nums text-muted-foreground">{totals[ch]}</span>
                  </li>
                ))}
              </ul>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-80 w-full">
                <LineChart data={days} margin={{ left: 0, right: 12, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  {CHANNELS.map((ch) => (
                    <Line key={ch} dataKey={ch} type="monotone" stroke={`var(--color-${ch})`} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  ))}
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Volume split</CardTitle>
              <p className="text-sm text-muted-foreground">Share of activity by channel</p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="relative mx-auto h-52 w-52">
                <ChartContainer config={chartConfig} className="h-full w-full">
                  <PieChart>
                    {/* No hover tooltip here: it would cover the total in the middle; the list below has every number. */}
                    <Pie
                      // An empty month still draws the ring (one muted slice), so the card never looks broken.
                      data={grand ? CHANNELS.map((ch) => ({ channel: ch, value: totals[ch] })) : [{ channel: "none", value: 1 }]}
                      dataKey="value"
                      nameKey="channel"
                      innerRadius="72%"
                      outerRadius="100%"
                      stroke="hsl(var(--card))"
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
                      {(grand ? CHANNELS : ["none"]).map((ch) => (
                        <Cell key={ch} fill={ch === "none" ? "hsl(var(--muted))" : `var(--color-${ch})`} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-4xl font-semibold tabular-nums">{grand.toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">Total</span>
                </div>
              </div>
              <ul className="space-y-3">
                {CHANNELS.map((ch) => (
                  <li key={ch} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2.5">
                      <span className="h-3 w-3 rounded-full" style={{ background: `var(--color-${ch})` }} aria-hidden />
                      {chartConfig[ch].label}
                    </span>
                    <span className="tabular-nums"><span className="text-muted-foreground">{totals[ch]} · </span><span className="font-medium">{grand ? Math.round((totals[ch] / grand) * 100) : 0}%</span></span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
