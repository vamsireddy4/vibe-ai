// Pure helpers for the Ask Vibe chat (src/components/AskVibe.tsx). Checked by ask-vibe.test.ts.
import { META_MODELS } from "@/lib/provider-config";

export type AskStep = { do: "click" | "fill" | "ask"; target: string; value?: string };
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type AskTask =
  | { type: "create_agent"; name: string; system_prompt: string; language: string }
  | { type: "outbound_call"; agent: string; to: string; from: string }
  | { type: "add_booking"; agent: string; appointment: string; duration: number; days: string[]; start: string; end: string }
  | { type: "update_profile"; full_name?: string; company_name?: string; timezone?: string; voice_model?: string }
  | { type: "add_forwarding"; agent: string; number: string; label: string }
  | { type: "create_tool"; agent: string; name: string; description: string; url: string; method: string }
  | { type: "add_webhook"; url: string; agent: string }
  | { type: "set_tool_active"; tool: string; active: boolean }
  | { type: "compose_message"; channel: "sms" | "whatsapp" | "email" | "voice"; to: string; subject: string; message: string; agent: string; send: boolean }
  | { type: "start_campaign"; channel: "voice" | "email"; campaign: string; template: string }
  | { type: "update_agent"; agent: string; name?: string; instructions?: string; voice?: string; voice_gender?: "masculine" | "feminine"; language?: string; active?: boolean };
/** tasks: jobs the app runs in order (e.g. create an agent, then give it booking). more: keep going afterwards. */
export type AskAction = { navigate: string; steps: AskStep[]; tasks: AskTask[]; more: boolean };

const E164 = /^\+[1-9]\d{6,14}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Model output is untrusted: only complete, well-formed tasks pass. */
function parseTask(t: any): AskTask | null {
  if (t?.type === "create_agent") {
    const name = str(t.name, 80);
    const system_prompt = str(t.system_prompt, 20000);
    const language = /^[a-z]{2}(-[A-Z]{2})?$/.test(t.language) ? t.language : "en";
    return name && system_prompt ? { type: "create_agent", name, system_prompt, language } : null;
  }
  if (t?.type === "outbound_call") {
    const to = str(t.to, 20).replace(/[^\d+]/g, "");
    const from = str(t.from, 20).replace(/[^\d+]/g, "");
    const agent = str(t.agent, 80);
    return agent && E164.test(to) && (from === "" || E164.test(from)) ? { type: "outbound_call", agent, to, from } : null;
  }
  if (t?.type === "add_booking") {
    const agent = str(t.agent, 80);
    const hhmm = (v: unknown) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : "");
    const start = hhmm(t.start);
    const end = hhmm(t.end);
    const days = (Array.isArray(t.days) ? t.days : []).filter((d: unknown): d is string => WEEKDAYS.includes(d as never));
    const duration = Math.round(Number(t.duration) || 30);
    return agent && start && end && start < end && days.length && duration >= 5 && duration <= 480
      ? { type: "add_booking", agent, appointment: str(t.appointment, 60) || "Appointment", duration, days: [...new Set<string>(days)], start, end }
      : null;
  }
  if (t?.type === "update_profile") {
    const out: Extract<AskTask, { type: "update_profile" }> = { type: "update_profile" };
    if (str(t.full_name, 80)) out.full_name = str(t.full_name, 80);
    if (str(t.company_name, 120)) out.company_name = str(t.company_name, 120);
    if (isTimeZone(t.timezone)) out.timezone = t.timezone;
    if (META_MODELS.some((m) => m.value === t.voice_model)) out.voice_model = t.voice_model;
    return Object.keys(out).length > 1 ? out : null;
  }
  if (t?.type === "add_forwarding") {
    const agent = str(t.agent, 80);
    const number = str(t.number, 20).replace(/[^\d+]/g, "");
    return agent && E164.test(number) ? { type: "add_forwarding", agent, number, label: str(t.label, 40) } : null;
  }
  if (t?.type === "create_tool") {
    const agent = str(t.agent, 80);
    // The call model calls the tool by this name: letters, digits, _ and - only.
    const name = str(t.name, 64).replace(/[^a-zA-Z0-9_-]/g, "");
    const url = HTTPS.test(str(t.url, 500)) ? str(t.url, 500) : "";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(t.method).toUpperCase()) ? String(t.method).toUpperCase() : "GET";
    return agent && name && url ? { type: "create_tool", agent, name, description: str(t.description, 500), url, method } : null;
  }
  if (t?.type === "add_webhook") {
    const url = HTTPS.test(str(t.url, 500)) ? str(t.url, 500) : "";
    return url ? { type: "add_webhook", url, agent: str(t.agent, 80) } : null;
  }
  if (t?.type === "compose_message") {
    const channel = ["sms", "whatsapp", "email", "voice"].includes(t.channel) ? t.channel : "";
    const to = str(t.to, 200);
    const okTo = channel === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to) : E164.test(to.replace(/[^\d+]/g, ""));
    return channel && okTo
      ? { type: "compose_message", channel, to: channel === "email" ? to : to.replace(/[^\d+]/g, ""), subject: str(t.subject, 300), message: str(t.message, 5000), agent: str(t.agent, 80), send: t.send === true }
      : null;
  }
  if (t?.type === "start_campaign") {
    const channel = t.channel === "voice" || t.channel === "email" ? t.channel : "";
    const campaign = str(t.campaign, 120);
    return channel && campaign && (channel === "voice" || str(t.template, 120))
      ? { type: "start_campaign", channel, campaign, template: str(t.template, 120) }
      : null;
  }
  if (t?.type === "update_agent") {
    const agent = str(t.agent, 80);
    const out: Extract<AskTask, { type: "update_agent" }> = { type: "update_agent", agent };
    if (str(t.name, 80)) out.name = str(t.name, 80);
    if (str(t.instructions, 20000)) out.instructions = str(t.instructions, 20000);
    if (/^aura-[\w-]+$/.test(t.voice ?? "")) out.voice = t.voice;
    const g = String(t.voice_gender ?? "").toLowerCase();
    if (/^(male|man|masculine)$/.test(g)) out.voice_gender = "masculine";
    if (/^(female|woman|feminine)$/.test(g)) out.voice_gender = "feminine";
    if (/^[a-z]{2}(-[A-Z]{2})?$/.test(t.language ?? "")) out.language = t.language;
    if (typeof t.active === "boolean") out.active = t.active;
    return agent && Object.keys(out).length > 2 ? out : null;
  }
  if (t?.type === "set_tool_active") {
    const tool = str(t.tool, 64);
    return tool && typeof t.active === "boolean" ? { type: "set_tool_active", tool, active: t.active } : null;
  }
  return null;
}

const HTTPS = /^https:\/\/[^\s/$.?#][^\s]*$/i;
/** A real IANA timezone (e.g. Asia/Kolkata), per the browser's own list. */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(v)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return true; } catch { return false; }
}

const ACTION = /<<ACTION\s*(\{[\s\S]*?\})\s*>>/;

/** Split a (possibly still streaming) reply into the text to show and the trailing action, if complete. */
export function splitReply(raw: string): { text: string; action: AskAction | null } {
  const cut = raw.indexOf("<<");
  // The model sometimes writes its sentence twice with no space ("…campaign.Opening the…"): keep the first.
  const text = (cut === -1 ? raw : raw.slice(0, cut)).replace(/\*\*/g, "").split(/(?<=\p{Ll}[.!?])(?=\p{Lu})/u)[0].trim();
  const m = raw.match(ACTION);
  if (!m) return { text, action: null };
  try {
    const a = JSON.parse(m[1]);
    const navigate = typeof a.navigate === "string" && /^\/(?!\/)[\w/-]*$/.test(a.navigate) ? a.navigate : "";
    // Model output is untrusted: keep only well-formed steps, capped.
    const steps: AskStep[] = (Array.isArray(a.steps) ? a.steps : [])
      .filter((st: any) => ["click", "fill", "ask"].includes(st?.do) && typeof st.target === "string" && st.target.trim())
      .slice(0, 16) // a whole wizard (fills + Next clicks) fits in one action
      .map((st: any) => ({ do: st.do, target: st.target.slice(0, 60), ...(st.do === "fill" && typeof st.value === "string" ? { value: st.value.slice(0, 500) } : {}) }))
      .map((st: AskStep) => (st.do === "fill" && st.value === undefined ? { do: "ask", target: st.target } : st));
    // One task ("task") or several in order ("tasks"); bad ones are dropped, at most 6.
    const tasks = (Array.isArray(a.tasks) ? a.tasks : a.task ? [a.task] : []).map(parseTask).filter(Boolean).slice(0, 6) as AskTask[];
    // A call is never chained into more automatic work: the user confirms it first.
    const more = a.continue === true && !tasks.some((t) => t.type === "outbound_call");
    return { text, action: navigate || steps.length || tasks.length ? { navigate, steps, tasks, more } : null };
  } catch {
    return { text, action: null };
  }
}

/** Keys, tokens, passwords: Ask Vibe types these only with a value the user typed into the chat (userGave). */
export const isSecretField = (label: string) => /api ?key|token|secret|password|passcode|\bsid\b|public key|private key|card|cvv|otp/i.test(label);

/** Buttons Ask Vibe won't press for the user (they commit, spend, call or delete); it highlights them instead. */
export const isRiskyButton = (label: string) => /delete|remove|pay|buy|purchase|checkout|place call|call now|sign ?out|log ?out|send|submit|connect|save|confirm|disconnect|start call|launch/i.test(label);
/** Never pressed by Ask Vibe, even after a confirm: money and the user's own session. */
export const isForbiddenButton = (label: string) => /\b(pay|buy|purchase|checkout|sign ?out|log ?out)\b/i.test(label);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

/** 0..1: how well an on-screen label matches the label the model asked for. */
export function labelScore(label: string, target: string): number {
  const l = norm(label);
  const t = norm(target);
  if (!l || !t) return 0;
  if (l === t) return 1;
  if (l.includes(t) || t.includes(l)) return 0.8 * (Math.min(l.length, t.length) / Math.max(l.length, t.length)) + 0.15;
  const lw = new Set(l.split(" "));
  const tw = t.split(" ");
  return (0.6 * tw.filter((w) => lw.has(w)).length) / Math.max(tw.length, lw.size);
}

export type Box = { x1: number; y1: number; x2: number; y2: number; w: number; h: number };

/** SAM boxes are in captured-frame pixels; convert to CSS viewport pixels. */
export function boxToViewport(b: Box, viewportW: number, viewportH: number) {
  const sx = viewportW / b.w;
  const sy = viewportH / b.h;
  return { left: b.x1 * sx, top: b.y1 * sy, width: (b.x2 - b.x1) * sx, height: (b.y2 - b.y1) * sy };
}

/**
 * Did the user type this exact value into the chat? Secret fields are filled only then, so the model
 * can never invent a key or copy one from page content: it can only pass on what the user gave it.
 */
export const userGave = (value: string, userTexts: string[]) => {
  const v = value.trim();
  return v.length >= 4 && userTexts.some((t) => t.includes(v));
};
