import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useDragControls, useMotionValue } from "framer-motion";
import { Loader2, MousePointer2, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { authJsonHeaders } from "@/lib/local-functions";
import { enhanceAgentPrompt } from "@/lib/analysis";
import type { Tables } from "@/integrations/supabase/types";
import { boxToViewport, isForbiddenButton, isRiskyButton, isSecretField, userGave, labelScore, splitReply, WEEKDAYS, type AskStep, type AskTask, type Box } from "@/lib/ask-vibe";
import { getVibePath, isAppPath } from "@/lib/vibe-routes";
import { canPlaceMetaTelnyxCall, placeMetaTelnyxCall, runVoiceCampaign } from "@/lib/outbound-call";
import { extractEdgeFunctionError } from "@/lib/edge-functions";

/**
 * Ask Vibe: floating help chat. Muse Spark answers (streamed) and may return steps; the app
 * opens the page, finds buttons on a capture of this tab with SAM 3.1 and clicks them, fills
 * values the user gave (keys too, but only ones the user typed into the chat), and stops at commit buttons (save, connect, call).
 */

const API = `${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/ask`;
const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], [role="combobox"], input:not([type="hidden"]), select, textarea';
const SUGGESTIONS = ["How do I connect Telnyx?", "Create a new agent", "Make an outbound call"];

type Msg = { role: "user" | "assistant"; content: string; auto?: boolean }; // auto: the app's own "continue" turn, not shown
const MAX_ROUNDS = 6; // a task may span this many pages/dialogs (open page → pick → fill …)
type Rect = { left: number; top: number; width: number; height: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Press like a real mouse: some controls (tabs, menus) react to pointer/mouse down, not to click(). */
function press(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...at, buttons: 0 }));
  el.click();
}
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const inPanel = (el: Element | null) => !!el?.closest("[data-ask-vibe]");

function labelOf(el: Element): string {
  const h = el as HTMLInputElement;
  const text = (el as HTMLElement).innerText?.split("\n")[0]?.trim();
  return (el.getAttribute("aria-label") || text || h.labels?.[0]?.innerText || h.placeholder || el.getAttribute("title") || "").trim();
}

const isField = (el: Element) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute("role") === "combobox";
/** A form field's own label (a dropdown's text is its current value, so prefer <label for>). */
function fieldLabel(el: Element): string {
  return ((el as HTMLInputElement).labels?.[0]?.innerText || el.getAttribute("aria-label") || nearbyLabel(el) || (el as HTMLInputElement).placeholder || labelOf(el)).trim();
}

/** A <Label> that isn't wired to its field (common with shadcn Selects): the label in the same small group. */
function nearbyLabel(el: Element): string {
  for (let box = el.parentElement, depth = 0; box && depth < 3; box = box.parentElement, depth++) {
    const labels = box.querySelectorAll("label");
    if (labels.length === 1) return (labels[0] as HTMLElement).innerText.trim();
    if (labels.length > 1) return "";
  }
  return "";
}

/** What the model sees: each visible control, marked as a field or dropdown when it is one. */
function pageSummary(): string[] {
  const out = clickables().map(({ el, label }) => {
    if (!isField(el)) return label;
    const kind = el.tagName === "SELECT" || el.getAttribute("role") === "combobox" ? "dropdown" : "field";
    const name = fieldLabel(el) || label;
    const current = kind === "dropdown" ? labelOf(el) : (el as HTMLInputElement).value;
    return `${kind}: ${name}${current && current !== name ? ` = ${current.slice(0, 30)}` : ""}`;
  });
  return [...new Set(out)];
}

/** Visible buttons, links and fields on the page, outside the chat. */
function clickables() {
  return [...document.querySelectorAll(CLICKABLE)]
    .filter((el) => !inPanel(el) && el.getClientRects().length > 0)
    .map((el) => ({ el, label: labelOf(el) }))
    .filter((c) => c.label);
}

export default function AskVibe() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, refreshProfile } = useAuth();
  const [open, setOpen] = useState(false);
  // Draggable by the button or the chat header; the spot is remembered per browser.
  const dragControls = useDragControls();
  const bounds = useRef<HTMLDivElement>(null);
  const dragged = useRef(false); // a drag that ends on the button is not a click
  const saved = (() => { try { return JSON.parse(localStorage.getItem("ask-vibe-pos") || "null"); } catch { return null; } })();
  const posX = useMotionValue<number>(saved?.x ?? 0);
  const posY = useMotionValue<number>(saved?.y ?? 0);
  // Open the chat toward the side with room (above/below, left/right of the button), so it never leaves the screen.
  const [place, setPlace] = useState({ below: false, toRight: false });
  const launcher = useRef<HTMLButtonElement>(null);
  const toggleOpen = () => {
    const r = launcher.current?.getBoundingClientRect();
    if (r) setPlace({ below: r.top < Math.min(540, window.innerHeight - 112) + 24, toRight: r.right < Math.min(380, window.innerWidth - 32) });
    setOpen((o) => !o);
  };
  const savePos = () => { try { localStorage.setItem("ask-vibe-pos", JSON.stringify({ x: posX.get(), y: posY.get() })); } catch { /* private mode */ } };
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [highlight, setHighlight] = useState<(Rect & { via: string }) | null>(null);
  // The AI cursor: glides to each control before Ask Vibe uses it, so the user sees what SAM 3.1 found.
  const [cursor, setCursor] = useState<{ x: number; y: number; down: boolean } | null>(null);
  const cursorHide = useRef<ReturnType<typeof setTimeout>>();
  // An outbound call waiting for the user's one-click confirm (it rings a real phone and costs money).
  // A job that contacts people (e.g. starting a campaign): runs only after the user taps Confirm.
  const [pendingRun, setPendingRun] = useState<{ label: string; run: () => Promise<string> } | null>(null);
  // A commit button (Send, Call, Start Campaign, Delete, Connect…) Ask Vibe reached: pressed only after the user taps Confirm.
  const [pendingPress, setPendingPress] = useState<{ label: string; target: string; path: string } | null>(null);
  const [pendingCall, setPendingCall] = useState<{ agent: Tables<"agents">; number: Tables<"phone_configs">; to: string } | null>(null);
  const contextRef = useRef<{ agents: Tables<"agents">[]; numbers: Tables<"phone_configs">[] }>({ agents: [], numbers: [] });
  const streamRef = useRef<MediaStream | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharingPaused, setSharingPaused] = useState(false); // between tasks: share kept, nothing read
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  // Braces matter: Chrome's scrollTo() now returns a Promise, which React would treat as the cleanup.
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages, status]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Tab share stays on for the session (one browser prompt per page load); the user can stop it from the browser bar.
  const stopCapture = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setSharing(false); };
  useEffect(() => () => stopCapture(), []);

  // Highlight follows nothing: drop it on scroll/resize, or after 8 s.
  useEffect(() => {
    if (!highlight) return;
    const clear = () => setHighlight(null);
    const t = setTimeout(clear, 8000);
    // Start listening a moment later: our own scrollIntoView fires a scroll event right after highlighting.
    // While typing, the field itself scrolls; keep the highlight on it.
    const arm = setTimeout(() => { if (highlight.via !== "typing") window.addEventListener("scroll", clear, true); window.addEventListener("resize", clear); }, 400);
    return () => { clearTimeout(t); clearTimeout(arm); window.removeEventListener("scroll", clear, true); window.removeEventListener("resize", clear); };
  }, [highlight]);

  /** One frame of this tab, as the user sees it (asks permission the first time). */
  // Chrome allows the share prompt only right after a click, so it is requested when the user presses
  // Send (startShare), not later when a step needs SAM (by then the click has expired and it fails silently).
  // Asked once per visit: the share is kept for later tasks, and a "Cancel" isn't asked again.
  const sharePromise = useRef<Promise<MediaStream | null> | null>(null);
  const shareDeclined = useRef(false);
  function startShare() {
    if (streamRef.current?.active || shareDeclined.current || !navigator.mediaDevices?.getDisplayMedia) return;
    sharePromise.current = navigator.mediaDevices
      .getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions)
      .then((stream) => {
        streamRef.current = stream;
        setSharing(true);
        // Stopped from Chrome's own bar: keep our indicator in sync.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => { streamRef.current = null; setSharing(false); });
        return stream;
      })
      .catch(() => { shareDeclined.current = true; return null; }); // declined: don't ask again this session
  }

  async function captureTab(): Promise<string> {
    if (!streamRef.current?.active) await sharePromise.current;
    if (!streamRef.current?.active) throw new DOMException("Screen sharing is off", "NotAllowedError");
    const video = document.createElement("video");
    video.srcObject = streamRef.current;
    video.muted = true;
    await video.play();
    await sleep(150); // let a frame with the current page arrive
    const scale = Math.min(1, 1600 / video.videoWidth); // smaller upload, same layout
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  /** Wait (up to 4 s) for the page or dialog to render something matching `target`; best page element or null. */
  async function findOnPage(target: string, fieldsOnly: boolean) {
    for (let i = 0; i < 16; i++) {
      const best = clickables()
        .filter((c) => !fieldsOnly || isField(c.el))
        .map((c) => (fieldsOnly ? { ...c, label: fieldLabel(c.el) || c.label } : c))
        .map((c) => ({ ...c, score: labelScore(c.label, target) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.5) return best;
      await sleep(250);
    }
    return null;
  }

  /** Locate a button on screen with SAM 3.1 (tab capture), matched to the real element; page structure as fallback. */
  async function locateButton(target: string): Promise<{ el: Element; rect: Rect; via: string } | null> {
    const best = await findOnPage(target, false);
    if (best) { best.el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }); await sleep(200); }
    try {
      setStatus(`Reading your screen with SAM 3.1 to find “${target}”…`);
      const image = await captureTab();
      const res = await fetch(`${API}/sam`, {
        method: "POST",
        headers: await authJsonHeaders(),
        body: JSON.stringify({ image, prompt: "button" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      let pick: { el: Element; rect: Rect; score: number } | null = null;
      for (const box of data.boxes as Box[]) {
        const rect = boxToViewport(box, window.innerWidth, window.innerHeight);
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!hit || inPanel(hit)) continue;
        const el = hit.closest(CLICKABLE) ?? hit;
        const same = best && (el === best.el || best.el.contains(el) || el.contains(best.el));
        const score = same ? 1.1 : labelScore(labelOf(el), target);
        if (score >= 0.5 && (!pick || score > pick.score)) pick = { el, rect, score };
      }
      if (pick) return { el: pick.el, rect: pick.rect, via: "SAM 3.1" };
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) console.warn("Ask Vibe SAM step failed", e);
    }
    if (!best) return null;
    const r = best.el.getBoundingClientRect();
    return { el: best.el, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, via: "page" };
  }

  /** React-controlled inputs ignore plain `.value =`; use the native setter and fire input. */
  function fillInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Move the AI cursor onto `rect` (and outline it), then press: the user watches each action happen. */
  async function pointAt(rect: Rect, via: string) {
    clearTimeout(cursorHide.current);
    setHighlight({ ...rect, via });
    setCursor({ x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2, down: false });
    await sleep(reducedMotion() ? 50 : 650); // the glide
    setCursor((c) => c && { ...c, down: true });
    await sleep(140);
    setCursor((c) => c && { ...c, down: false });
    setHighlight(null);
    cursorHide.current = setTimeout(() => setCursor(null), 1500);
  }

  /** Run the model's steps. Clicks safe buttons and fills values the user gave; stops at commit buttons. */
  async function runSteps(steps: AskStep[], userTexts: string[]): Promise<{ log: string[]; stopped: boolean }> {
    const log: string[] = [];
    let stopped = false;
    const toAsk: { el: Element; label: string }[] = [];
    for (const step of steps) {
      if (step.do === "click") {
        const found = await locateButton(step.target);
        if (!found) { log.push(`Couldn't find “${step.target}” on this page.`); stopped = true; break; }
        const label = labelOf(found.el) || step.target;
        if (isRiskyButton(label)) {
          setHighlight({ ...found.rect, via: found.via });
          if (isForbiddenButton(label)) log.push(`I don't press “${label}” (payments and signing out are yours). It's highlighted.`);
          else if ((found.el as HTMLButtonElement).disabled) log.push(`“${label}” is still disabled: fill the required fields above it first.`);
          else {
            setPendingPress({ label, target: step.target, path: pathRef.current });
            log.push(`Ready to press “${label}” (highlighted). Tap “Confirm ${label}” below to go ahead, or Cancel.`);
          }
          stopped = true;
          break;
        }
        if ((found.el as HTMLButtonElement).disabled) {
          setHighlight({ ...found.rect, via: found.via });
          log.push(`“${label}” is still disabled: fill the required fields above it first.`);
          stopped = true;
          break;
        }
        await pointAt(found.rect, found.via);
        press(found.el as HTMLElement);
        log.push(`Clicked “${label}”${found.via === "SAM 3.1" ? " (found by SAM 3.1)" : ""}.`);
        await sleep(500); // dialogs and tabs animate in
        continue;
      }
      setStatus(`Looking for “${step.target}”…`);
      const field = await findOnPage(step.target, true);
      if (!field) { log.push(`Couldn't find the “${step.target}” field.`); continue; }
      const input = field.el as HTMLInputElement;
      if (step.do === "fill" && step.value !== undefined) {
        input.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        const r = input.getBoundingClientRect();
        await pointAt({ left: r.left, top: r.top, width: r.width, height: r.height }, "page");
      }
      // Secrets (keys, tokens, passwords) only with a value the user typed into this chat.
      const secret = isSecretField(field.label) || isSecretField(step.target) || input.type === "password";
      const canFill = step.do === "fill" && step.value !== undefined && (!secret || userGave(step.value, userTexts));
      if (canFill && input.getAttribute("role") === "combobox") {
        // Dropdown: open it and pick the option matching the value.
        input.click();
        await sleep(300);
        const option = [...document.querySelectorAll('[role="option"]')]
          .map((o) => ({ o, score: labelScore((o as HTMLElement).innerText, step.value!) }))
          .sort((a, b) => b.score - a.score)[0];
        if (option && option.score >= 0.5) {
          (option.o as HTMLElement).click();
          log.push(`Chose “${(option.o as HTMLElement).innerText.trim()}” for “${field.label}”.`);
          await sleep(200);
        } else {
          document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          toAsk.push(field);
        }
      } else if (canFill && input.tagName === "SELECT") {
        // Native dropdown: choose the option whose text best matches the value.
        const sel = input as unknown as HTMLSelectElement;
        const option = [...sel.options].map((o) => ({ o, score: labelScore(o.text, step.value!) })).sort((a, b) => b.score - a.score)[0];
        if (option && option.score >= 0.5) {
          sel.value = option.o.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          log.push(`Chose “${option.o.text.trim()}” for “${field.label}”.`);
        } else toAsk.push(field);
      } else if (canFill) {
        fillInput(input, step.value!);
        log.push(`Filled “${field.label}”.`);
        await sleep(150); // let the form re-render (e.g. enable "Next") before the next step
      } else {
        toAsk.push(field);
      }
    }
    if (toAsk.length) {
      const first = toAsk[0].el as HTMLElement;
      first.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      first.focus();
      const r = first.getBoundingClientRect();
      setHighlight({ left: r.left, top: r.top, width: r.width, height: r.height, via: "page" });
      log.push(`Your turn: enter ${toAsk.map((f) => `“${f.label}”`).join(", ")}, or paste it here and I'll fill it in.`);
      stopped = true;
    }
    return { log, stopped };
  }

  /** Wait until `find()` returns something (polling), up to `ms`. */
  async function waitFor<T>(find: () => T | null | undefined, ms = 5000): Promise<T | null> {
    for (let t = 0; t < ms; t += 100) {
      const v = find();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  /** Type into a field visibly, the way a person would (React sees every keystroke). */
  async function typeLive(el: HTMLInputElement | HTMLTextAreaElement, text: string, totalMs: number) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(350);
    const r = el.getBoundingClientRect();
    setHighlight({ left: r.left, top: r.top, width: r.width, height: Math.min(r.height, window.innerHeight - r.top), via: "typing" });
    el.focus();
    const step = Math.max(1, Math.ceil(text.length / (totalMs / 16)));
    for (let i = step; i < text.length + step; i += step) {
      fillInput(el, text.slice(0, i));
      if (el instanceof HTMLTextAreaElement) el.scrollTop = el.scrollHeight;
      await sleep(16);
    }
  }

  /** Create the agent on screen: open the form, type it in, then press the form's own Create Agent button (found by SAM 3.1). */
  async function createAgentLive(task: Extract<AskTask, { type: "create_agent" }>): Promise<string> {
    // Expand what the user described into the standard 6-section prompt; keep the model's draft if that fails.
    setStatus("Writing a structured system prompt…");
    const systemPrompt = await enhanceAgentPrompt({ name: task.name, description: task.system_prompt }).catch(() => task.system_prompt);
    setStatus("Opening a new agent form…");
    navigate(`${getVibePath("voice", "agents")}/new`);
    const name = await waitFor(() => document.getElementById("name") as HTMLInputElement | null);
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement | null;
    if (!name || !prompt) return "The new agent form didn't open.";

    setStatus("Typing the agent name…");
    await typeLive(name, task.name, 700);
    setStatus("Writing the system prompt…");
    await typeLive(prompt, systemPrompt, 2500);
    const language = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.trim() === "Language")
      ?.parentElement?.querySelector("input");
    if (language && task.language !== "en") {
      setStatus("Setting the language…");
      await typeLive(language, task.language, 200);
    }

    const button = await locateButton("Create Agent");
    if (!button || button.el.getAttribute("type") !== "submit") return "Everything is filled in. Press “Create Agent” at the bottom to save it.";
    setHighlight({ ...button.rect, via: button.via });
    setStatus(`Pressing “Create Agent”${button.via === "SAM 3.1" ? " (found by SAM 3.1)" : ""}…`);
    await sleep(800); // let the user see what is about to be pressed
    (button.el as HTMLButtonElement).click(); // the user asked for this agent, so saving it is the task
    const saved = await waitFor(() => (pathRef.current.endsWith("/agents") ? true : null), 8000);
    setHighlight(null);
    return saved
      ? `Created “${task.name}” with Muse Spark 1.3. It's in your agents list; open it to change the voice or prompt.`
      : "I filled in the form and pressed Create Agent, but it didn't save. Check the form for a message.";
  }

  /** Do the whole job: create the agent, or line up the call for one-click confirm. */
  /** Give an agent appointment booking on the user's connected Google Calendar, with the hours they gave. */
  async function addBooking(task: Extract<AskTask, { type: "add_booking" }>): Promise<string> {
    if (!user) return "Sign in again first.";
    // Fresh list: the agent may have been created a moment ago in this same request.
    const { data: agents } = await supabase.from("agents").select("id, name").order("created_at", { ascending: false });
    const agent = (agents ?? []).map((a) => ({ a, s: labelScore(a.name, task.agent) })).sort((x, y) => y.s - x.s)[0];
    if (!agent || agent.s < 0.5) return `I couldn't find an agent called “${task.agent}”.`;
    const { data: calendars } = await supabase.from("calendar_integrations").select("id").eq("provider", "google_calendar").eq("is_active", true).limit(1);
    if (!calendars?.length) {
      navigate(getVibePath("voice", "calendar-integrations"));
      return "Google Calendar isn't connected yet. I opened Calendars: press “Connect” on Google Calendar, then ask me again to add booking.";
    }
    const business_hours = Object.fromEntries(
      WEEKDAYS.map((d) => [d, { start: task.start, end: task.end, enabled: task.days.includes(d) }]),
    );
    const { error } = await supabase.from("appointment_tools" as never).insert({
      user_id: user.id,
      agent_id: agent.a.id,
      calendar_integration_id: calendars[0].id,
      name: task.appointment,
      provider: "google_calendar",
      appointment_types: [{ name: task.appointment, duration: task.duration }],
      business_hours,
      is_active: true,
    } as never);
    if (error) return `I couldn't add booking: ${error.message}`;
    const days = task.days.length === 6 && !task.days.includes("Sunday") ? "Monday to Saturday" : task.days.join(", ");
    return `Added booking to “${agent.a.name}”: ${task.duration}-minute ${task.appointment} on your Google Calendar, ${days}, ${task.start} to ${task.end}. On calls it now collects name, phone, email and time, then books.`;
  }

  /** The user's agent best matching a name (fresh: it may have been created a moment ago in this request). */
  async function findAgent(name: string) {
    const { data: agents } = await supabase.from("agents").select("id, name").order("created_at", { ascending: false });
    const best = (agents ?? []).map((a) => ({ a, s: labelScore(a.name, name) })).sort((x, y) => y.s - x.s)[0];
    return best && best.s >= 0.5 ? best.a : null;
  }

  /** Profile fields live in the account window (not a page), so the app saves them directly. */
  async function updateProfile(task: Extract<AskTask, { type: "update_profile" }>): Promise<string> {
    if (!user) return "Sign in again first.";
    const { type: _t, voice_model, ...rest } = task;
    const fields = { ...rest, ...(voice_model ? { voice_llm_model: voice_model } : {}) };
    const { error } = await supabase.from("profiles").update(fields as never).eq("user_id", user.id);
    if (error) return `I couldn't update your profile: ${error.message}`;
    await refreshProfile();
    const said = [task.full_name && `name ${task.full_name}`, task.company_name && `company ${task.company_name}`, task.timezone && `timezone ${task.timezone}`, voice_model && `voice model ${voice_model}`].filter(Boolean);
    return `Saved your ${said.join(", ")}.`;
  }

  async function addForwarding(task: Extract<AskTask, { type: "add_forwarding" }>): Promise<string> {
    if (!user) return "Sign in again first.";
    const agent = await findAgent(task.agent);
    if (!agent) return `I couldn't find an agent called “${task.agent}”.`;
    const { data: existing } = await supabase.from("call_forwarding_numbers").select("priority").eq("agent_id", agent.id);
    const priority = (existing ?? []).reduce((m, r) => Math.max(m, r.priority + 1), 0);
    const { error } = await supabase.from("call_forwarding_numbers").insert({ agent_id: agent.id, user_id: user.id, phone_number: task.number, label: task.label || null, priority });
    if (error) return `I couldn't add the forwarding number: ${error.message}`;
    return `Added ${task.number} to “${agent.name}” call forwarding (number ${priority + 1} in order). On calls, the agent transfers there when a caller asks for a person.`;
  }

  async function createTool(task: Extract<AskTask, { type: "create_tool" }>): Promise<string> {
    if (!user) return "Sign in again first.";
    const agent = await findAgent(task.agent);
    if (!agent) return `I couldn't find an agent called “${task.agent}”.`;
    const { error } = await supabase.from("agent_tools").insert({
      user_id: user.id, agent_id: agent.id, name: task.name, description: task.description,
      http_method: task.method, http_url: task.url, http_headers: {}, http_body_template: {}, parameters: [],
    } as never);
    if (error) return `I couldn't create the tool: ${error.message}`;
    return `Created the ${task.method} tool “${task.name}” for “${agent.name}”. It's on the Tools page, and the agent can use it on its next call.`;
  }

  async function addWebhook(task: Extract<AskTask, { type: "add_webhook" }>): Promise<string> {
    if (!user) return "Sign in again first.";
    const agent = task.agent ? await findAgent(task.agent) : null;
    if (task.agent && !agent) return `I couldn't find an agent called “${task.agent}”.`;
    const host = new URL(task.url).hostname;
    const { error } = await supabase.from("webhooks").insert({ user_id: user.id, agent_id: agent?.id ?? null, name: host, url: task.url, events: ["call.ended"] } as never);
    if (error) return `I couldn't add the webhook: ${error.message}`;
    return `Added the webhook ${host}: it gets each call's details and transcript when ${agent ? `“${agent.name}”'s calls` : "any call"} end.`;
  }

  async function setToolActive(task: Extract<AskTask, { type: "set_tool_active" }>): Promise<string> {
    const { data: tools } = await supabase.from("agent_tools").select("id, name");
    const best = (tools ?? []).map((t) => ({ t, s: labelScore(t.name, task.tool) })).sort((x, y) => y.s - x.s)[0];
    if (!best || best.s < 0.5) return `I couldn't find a tool called “${task.tool}”.`;
    const { error } = await supabase.from("agent_tools").update({ is_active: task.active } as never).eq("id", best.t.id);
    if (error) return `I couldn't change the tool: ${error.message}`;
    return `Turned “${best.t.name}” ${task.active ? "on" : "off"}. ${task.active ? "Its agent can use it on calls again." : "Its agent won't use it on calls."}`;
  }

  /** Change an agent: voice (exact, or by gender in its language from the live voice list), name, language, on/off, instructions. */
  async function updateAgent(task: Extract<AskTask, { type: "update_agent" }>): Promise<string> {
    const found = await findAgent(task.agent);
    if (!found) return `I couldn't find an agent called “${task.agent}”.`;
    const { data: agent } = await supabase.from("agents").select("*").eq("id", found.id).single();
    if (!agent) return `I couldn't open “${found.name}”.`;
    const fields: Record<string, unknown> = {};
    const said: string[] = [];
    if (task.name) { fields.name = task.name; said.push(`name ${task.name}`); }
    if (task.language) { fields.language_hint = task.language; said.push(`language ${task.language}`); }
    if (task.active !== undefined) { fields.is_active = task.active; said.push(task.active ? "turned on" : "turned off"); }
    let voice = task.voice;
    if (!voice && task.voice_gender) {
      setStatus("Choosing a voice…");
      const base = import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`;
      // Two tries, 12 s each: a cold voice agent loads the list from Deepgram first.
      const load = () => fetch(`${base}/voices`, { signal: AbortSignal.timeout(12_000) }).then((r) => (r.ok ? r.json() : Promise.reject())).then((d) => d.voices ?? []);
      const list: { id: string; name: string; language: string; gender: string }[] = await load().catch(load).catch(() => []);
      const lang = String(task.language || agent.language_hint || "en").slice(0, 2);
      const pick = list.find((v) => v.gender === task.voice_gender && v.language.startsWith(lang)) ?? list.find((v) => v.gender === task.voice_gender && v.language.startsWith("en"));
      if (!pick) return "I couldn't load the voice list. Pick a voice on the agent's page.";
      voice = pick.id;
      said.push(`voice ${pick.name} (${task.voice_gender === "masculine" ? "male" : "female"})`);
    } else if (voice) said.push(`voice ${voice}`);
    if (voice) fields.voice = voice;
    if (task.instructions) {
      setStatus("Writing a structured system prompt…");
      fields.system_prompt = await enhanceAgentPrompt({ name: task.name || agent.name, description: `${task.instructions}\n\nCurrent instructions:\n${agent.system_prompt}` }).catch(() => `${agent.system_prompt}\n\n${task.instructions}`);
      said.push("updated instructions");
    }
    const { error } = await supabase.from("agents").update(fields as never).eq("id", agent.id);
    if (error) return `I couldn't update “${agent.name}”: ${error.message}`;
    return `Updated “${agent.name}”: ${said.join(", ")}.`;
  }

  /** Open Front with the composer filled in; the user reviews it and presses Send / Call. */
  async function composeMessage(task: Extract<AskTask, { type: "compose_message" }>): Promise<string> {
    const agent = task.channel === "voice" && task.agent ? await findAgent(task.agent) : null;
    if (task.channel === "voice" && task.agent && !agent) return `I couldn't find an agent called “${task.agent}”.`;
    navigate(getVibePath("voice", "unibox"), { state: { compose: { channel: task.channel, to: task.to, subject: task.subject, message: task.message, agentId: agent?.id } } });
    const what = task.channel === "email" ? "email" : task.channel === "voice" ? "call" : `${task.channel === "sms" ? "SMS" : "WhatsApp"} message`;
    const button = task.channel === "voice" ? "Call" : "Send";
    if (task.send) {
      // The user asked to send: line up the composer's button for one-tap confirm.
      await sleep(1200);
      const found = await locateButton(button);
      if (found && !(found.el as HTMLButtonElement).disabled) {
        setHighlight({ ...found.rect, via: found.via });
        setPendingPress({ label: button, target: button, path: pathRef.current });
        return `Your ${what} to ${task.to} is ready. Tap “Confirm ${button}” below to send it, or Cancel.`;
      }
    }
    return `Your ${what} to ${task.to} is ready in Front. Check it, then press “${button}”.`;
  }

  /** Find the campaign (and email template) by name and line it up for one-tap confirm. */
  async function startCampaign(task: Extract<AskTask, { type: "start_campaign" }>): Promise<string> {
    // "the test email campaign" means the campaign named "test": drop channel/filler words before matching.
    const bare = (s: string) => s.replace(/\b(the|my|email|gmail|voice|sms|whatsapp|campaign|template)\b/gi, " ").trim() || s;
    const pick = <T,>(rows: T[] | null, name: (r: T) => string, want: string) =>
      (rows ?? []).map((r) => ({ r, s: Math.max(labelScore(name(r), want), labelScore(bare(name(r)), bare(want))) })).sort((a, b) => b.s - a.s).find((x) => x.s >= 0.5)?.r;
    if (task.channel === "voice") {
      const { data } = await supabase.from("campaigns").select("id, venue_name, total_contacts");
      const c = pick(data, (r) => r.venue_name || "", task.campaign);
      if (!c) return `I couldn't find a voice campaign called “${task.campaign}”.`;
      setPendingRun({ label: "Start calls", run: async () => {
        const r: any = await runVoiceCampaign(c.id);
        return `Started “${c.venue_name}”: calling ${r?.queued ?? c.total_contacts} contact(s) one at a time.`;
      } });
      return `Ready to start “${c.venue_name}”: ${c.total_contacts ?? 0} contact(s) will be called by its agent. Tap “Confirm Start calls”, or Cancel.`;
    }
    const [{ data: campaigns }, { data: templates }] = await Promise.all([
      supabase.from("gmail_campaigns").select("id, name, total_contacts, extracted_contacts"),
      supabase.from("gmail_templates").select("id, name"),
    ]);
    const c = pick(campaigns, (r) => r.name || "", task.campaign);
    if (!c) return `I couldn't find an email campaign called “${task.campaign}”.`;
    const t = pick(templates, (r) => r.name || "", task.template);
    if (!t) return `I couldn't find an email template called “${task.template}”.`;
    const count = Array.isArray(c.extracted_contacts) ? c.extracted_contacts.length : 0;
    setPendingRun({ label: "Start campaign", run: async () => {
      const { data, error } = await supabase.functions.invoke("run-gmail-campaign", {
        body: { campaign_id: c.id, template_id: t.id, selected_contact_indexes: Array.from({ length: count }, (_, i) => i) },
      });
      if (error) throw new Error((await extractEdgeFunctionError(error)) || error.message);
      const outcomes: any[] = data?.completed_campaign?.outcomes ?? [];
      const sent = outcomes.filter((o) => o.status === "sent").length;
      return `Ran “${c.name}” with “${t.name}”: ${sent} sent, ${outcomes.length - sent} failed (failed ones usually have no email address). See Campaigns > Completed.`;
    } });
    return `Ready to email ${count} contact(s) in “${c.name}” using “${t.name}”. Tap “Confirm Start campaign”, or Cancel.`;
  }

  async function confirmRun() {
    const p = pendingRun;
    if (!p) return;
    setPendingRun(null);
    setBusy(true);
    setStatus(`${p.label}…`);
    const note = await p.run().catch((e: Error) => `That didn't work: ${e.message}`);
    setMessages((m) => [...m, { role: "assistant", content: note }]);
    setBusy(false);
    setStatus("");
  }

  async function runTask(task: AskTask, userTexts: string[] = []): Promise<string> {
    if (task.type === "start_campaign") return startCampaign(task);
    if (task.type === "compose_message") return composeMessage(task);
    if (task.type === "update_agent") return updateAgent(task);
    if (task.type === "set_tool_active") return setToolActive(task);
    if (task.type === "create_agent") return createAgentLive(task);
    if (task.type === "add_booking") return addBooking(task);
    if (task.type === "update_profile") return updateProfile(task);
    if (task.type === "add_forwarding") return addForwarding(task);
    if (task.type === "create_tool") return createTool(task);
    if (task.type === "add_webhook") return addWebhook(task);
    const { agents, numbers } = contextRef.current;
    const agent = agents.map((a) => ({ a, s: labelScore(a.name, task.agent) })).sort((x, y) => y.s - x.s)[0];
    if (!agent || agent.s < 0.5) return `I couldn't find an agent called “${task.agent}”.`;
    const number = task.from ? numbers.find((n) => n.phone_number?.replace(/[^\d+]/g, "") === task.from) : numbers.length === 1 ? numbers[0] : undefined;
    if (!number) return numbers.length ? "Which of your numbers should I call from?" : "Connect a phone number first (Phone Integration).";
    if (!canPlaceMetaTelnyxCall(agent.a, number)) return "Calls from here need a Telnyx or Twilio number.";
    setPendingCall({ agent: agent.a, number, to: task.to });
    return `Ready: ${agent.a.name} will call ${task.to} from ${number.phone_number}. Press “Place call” to dial.`;
  }

  /** The user tapped Confirm: find the same button again and press it (its own "are you sure?" counts as answered). */
  async function confirmPress() {
    const p = pendingPress;
    if (!p) return;
    setPendingPress(null);
    setPendingRun(null);
    setBusy(true);
    let note: string;
    try {
      if (pathRef.current !== p.path) throw new Error("The page changed since then. Ask me again.");
      const found = await locateButton(p.target);
      const label = found ? labelOf(found.el) || p.target : "";
      if (!found || labelScore(label, p.label) < 0.6 || isForbiddenButton(label)) throw new Error(`I can't find “${p.label}” any more.`);
      if ((found.el as HTMLButtonElement).disabled) throw new Error(`“${label}” is disabled now: something above it is missing.`);
      await pointAt(found.rect, found.via);
      const ask = window.confirm;
      window.confirm = () => true; // the user already confirmed in the chat
      try { press(found.el as HTMLElement); } finally { setTimeout(() => { window.confirm = ask; }, 1500); }
      await sleep(2500);
      // Report the page's own toast ("Message sent", "Agent deleted", an error…) if it shows one.
      const toast = [...document.querySelectorAll('[role="status"], li[data-state="open"], [data-sonner-toast]')]
        .map((t) => (t as HTMLElement).innerText.split("\n").map((l) => l.trim()).filter(Boolean).join(". ")).filter(Boolean).pop();
      note = `Pressed “${label}”.${toast ? ` The page says: ${toast.replace(/^Notification\.?\s*/i, "").replace(/\.\.+/g, ".")}` : ""}`;
    } catch (e) {
      note = (e as Error).message;
    }
    setHighlight(null);
    setMessages((m) => [...m, { role: "assistant", content: note }]);
    setBusy(false);
    setStatus("");
  }

  async function confirmCall() {
    const call = pendingCall;
    if (!call) return;
    setPendingCall(null);
    setBusy(true);
    setStatus("Dialing…");
    let note: string;
    try {
      await placeMetaTelnyxCall(call.agent, call.number, call.to, user!.id);
      note = `Calling ${call.to} now with ${call.agent.name}.`;
    } catch (e) {
      note = `The call didn't go through: ${(e as Error).message}`;
    }
    setMessages((m) => [...m, { role: "assistant", content: note }]);
    setBusy(false);
    setStatus("");
  }

  /** One model turn: stream the reply into the chat (shown after `shown`), return the raw text. */
  async function askModel(turns: Msg[], shown: Msg[]): Promise<string> {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: await authJsonHeaders(),
      body: JSON.stringify({
        messages: turns.map(({ role, content }) => ({ role, content })),
        page: { path: pathRef.current, elements: pageSummary() },
        context: {
          // With the id, the model can open an agent's page directly (/voice/agents/<id>) instead of hunting the list.
          agents: contextRef.current.agents.map((a) => `${a.name}${a.ai_provider === "meta" ? "" : " (not Meta)"} [page /voice/agents/${a.id}]`),
          numbers: contextRef.current.numbers.map((n) => `${n.phone_number} (${n.provider})`),
        },
      }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      setMessages([...shown, { role: "assistant", content: raw }]);
    }
    return raw;
  }

  /**
   * Do what the user asked, across pages: the model plans steps, the app runs them, re-reads the page and
   * hands the new page back ("continue"), until the job is done, it needs the user, or MAX_ROUNDS.
   */
  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    startShare(); // must run inside the Send click (see startShare)
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = true)); // resume a paused share
    setSharingPaused(false);
    setInput("");
    setHighlight(null);
    setPendingPress(null);
    let convo: Msg[] = [...messages, { role: "user", content: q }];
    setMessages([...convo, { role: "assistant", content: "" }]);
    setBusy(true);
    setStatus("");
    setPendingCall(null);
    try {
      // The user's own agents and numbers (RLS-scoped), so the model can create and call with real names.
      const [{ data: agents }, { data: numbers }] = await Promise.all([
        supabase.from("agents").select("*").order("created_at", { ascending: false }),
        supabase.from("phone_configs").select("*").eq("is_active", true),
      ]);
      contextRef.current = { agents: agents ?? [], numbers: (numbers ?? []).filter((n) => n.channel !== "sms") };
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let raw = await askModel(convo, convo);
        const { action } = splitReply(raw);
        let more = false;
        if (!action && raw.includes("<<ACTION")) {
          // The reply was cut off (or garbled) mid-action: say so instead of silently doing nothing.
          console.warn("Ask Vibe: unparsed action", raw);
          convo = [...convo, { role: "assistant", content: `${splitReply(raw).text}\n\nI couldn't finish setting that up (my instructions got cut off). Please send the request again.` }];
          setMessages(convo);
          break;
        }
        if (action) {
          const log: string[] = [];
          let stopped = false;
          if (action.navigate && action.navigate !== pathRef.current) {
            setStatus("Opening the page…");
            navigate(action.navigate);
            await sleep(600); // let the new page render before reading it
            log.push("Opened the page.");
          }
          if (action.steps.length) {
            const r = await runSteps(action.steps, convo.filter((m) => m.role === "user" && !m.auto).map((m) => m.content));
            log.push(...r.log);
            stopped = r.stopped;
          }
          const userTexts = convo.filter((m) => m.role === "user" && !m.auto).map((m) => m.content);
          for (const task of action.tasks) log.push(await runTask(task, userTexts)); // in order: e.g. create the agent, then add booking
          // Shown after the reply, and kept in history so the model knows what happened.
          // Only the text before the ACTION: models sometimes repeat a sentence after it, which glued onto the first.
          raw = `${splitReply(raw).text}${log.length ? `\n\n${log.join("\n")}` : ""}`;
          more = action.more && !stopped;
        }
        convo = [...convo, { role: "assistant", content: raw }];
        setMessages(convo);
        if (!more) break;
        setStatus("Reading the page for the next step…");
        await sleep(300);
        convo = [...convo, { role: "user", auto: true, content: "(Ask Vibe app) Done. Here is the page now; continue with the next step of my request, or say it's finished." }];
        setMessages([...convo, { role: "assistant", content: "" }]);
      }
    } catch (e) {
      const msg = e instanceof TypeError ? "Can't reach the Vibe assistant. Start the voice agent (npm start in services/voice-agent)." : (e as Error).message;
      setMessages([...convo, { role: "assistant", content: `Sorry, something went wrong: ${msg}` }]);
    } finally {
      setBusy(false);
      setStatus("");
      // Task done: pause the share (no frames are read) instead of stopping it, so the next task resumes it
      // without Chrome asking again. Stop (or closing/reloading the tab) ends it for real.
      streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = false));
      setSharingPaused(true);
    }
  }

  // Mounted once in App (so the chat survives page changes); shown only inside the logged-in app.
  if (!user || !isAppPath(location.pathname)) return null;

  return (
    // pointer-events-auto: modal dialogs set pointer-events:none on <body>; keep the chat usable.
    <div data-ask-vibe className="pointer-events-auto">
      {highlight && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] rounded-lg border-2 border-primary ring-4 ring-primary/30 animate-pulse"
          style={{ left: highlight.left - 4, top: highlight.top - 4, width: highlight.width + 8, height: highlight.height + 8 }}
        >
          <span className="absolute -top-7 left-0 whitespace-nowrap rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
            {cursor ? (highlight.via === "SAM 3.1" ? "SAM 3.1" : "Ask Vibe") : "Click here"}
          </span>
        </div>
      )}
      <AnimatePresence>
        {cursor && (
          <motion.div
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 z-[61]"
            initial={{ opacity: 0, x: window.innerWidth - 120, y: window.innerHeight - 160 }}
            animate={{ opacity: 1, x: cursor.x, y: cursor.y, scale: cursor.down ? 0.82 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 170, damping: 22, mass: 0.7, scale: { duration: 0.12 } }}
          >
            <MousePointer2 className="h-6 w-6 fill-foreground text-background drop-shadow-md" strokeWidth={1.5} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drag area: the whole window, so Ask Vibe can't be pushed off screen. */}
      <div ref={bounds} aria-hidden className="pointer-events-none fixed inset-4 z-[69]" />
      <motion.div
        drag
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={bounds}
        dragMomentum={false}
        dragElastic={0.08}
        onDragStart={() => { dragged.current = true; }}
        onDragEnd={() => { savePos(); setTimeout(() => { dragged.current = false; }, 0); }}
        style={{ x: posX, y: posY }}
        className="pointer-events-none fixed bottom-4 right-4 z-[70]"
      >
        <AnimatePresence>
        {open && (
          <motion.section
            key="ask-vibe-panel"
            role="dialog"
            aria-label="Ask Vibe chat"
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 12 }}
            transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}
            style={{ transformOrigin: `${place.below ? "top" : "bottom"} ${place.toRight ? "left" : "right"}` }}
            className={`pointer-events-auto absolute ${place.below ? "top-16" : "bottom-16"} ${place.toRight ? "left-0" : "right-0"} flex h-[min(540px,calc(100vh-7rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_24px_60px_-24px_rgb(0_0_0/0.35)]`}
          >
            <header
              onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("button")) dragControls.start(e); }}
              className="flex cursor-grab touch-none select-none items-center justify-between border-b bg-card px-4 py-3 active:cursor-grabbing"
              title="Drag to move"
            >
              <div>
                <h2 className="text-sm font-semibold">Ask Vibe</h2>
                <p className="text-xs text-muted-foreground">Meta Muse Spark · SAM 3.1</p>
              </div>
              {sharing && (
                <Button variant="outline" size="sm" className="ml-auto mr-1 h-7 gap-1.5 px-2 text-xs" onClick={stopCapture} aria-label="Stop sharing this tab with Ask Vibe">
                  <span className={sharingPaused ? "h-2 w-2 rounded-full bg-muted-foreground" : "h-2 w-2 rounded-full bg-red-500"} aria-hidden /> {sharingPaused ? "Paused" : "Sharing"} · Stop
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label="Close Ask Vibe" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Ask anything about Vibe AI, or tell me what you want to do and I'll do it. You only enter your own keys.</p>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="block w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted">
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((m, i) => {
                if (m.auto) return null;
                const text = m.role === "assistant" ? splitReply(m.content).text : m.content;
                return (
                  <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                      {text || <Loader2 className="h-4 w-4 animate-spin" aria-label="Thinking" />}
                    </div>
                  </div>
                );
              })}
              {pendingRun && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmRun}>Confirm {pendingRun.label}</Button>
                  <Button size="sm" variant="outline" onClick={() => setPendingRun(null)}>Cancel</Button>
                </div>
              )}
              {pendingPress && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmPress}>Confirm {pendingPress.label}</Button>
                  <Button size="sm" variant="outline" onClick={() => { setPendingPress(null); setHighlight(null); }}>Cancel</Button>
                </div>
              )}
              {pendingCall && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={confirmCall}>Place call</Button>
                  <Button size="sm" variant="outline" onClick={() => setPendingCall(null)}>Cancel</Button>
                </div>
              )}
              {status && <p className="text-xs text-muted-foreground">{status}</p>}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex gap-2 border-t p-3">
              <label htmlFor="ask-vibe-input" className="sr-only">Message Ask Vibe</label>
              <Input id="ask-vibe-input" ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Vibe…" disabled={busy} />
              <Button type="submit" size="icon" aria-label="Send" disabled={busy || !input.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </motion.section>
        )}
        </AnimatePresence>

        <Button
          onPointerDown={(e) => dragControls.start(e)}
          onClick={() => { if (dragged.current) { dragged.current = false; return; } toggleOpen(); }}
          ref={launcher}
          aria-expanded={open}
          title="Click to open, drag to move"
          className="pointer-events-auto h-12 touch-none gap-2 rounded-full px-5 shadow-lg transition-transform active:scale-[0.97]"
        >
          <Sparkles className="h-4 w-4" /> Ask Vibe
          {sharing && <span className={sharingPaused ? "h-2 w-2 rounded-full bg-muted-foreground" : "h-2 w-2 rounded-full bg-red-500"} aria-label={sharingPaused ? "Screen sharing paused" : "Screen sharing on"} />}
        </Button>
      </motion.div>
    </div>
  );
}
