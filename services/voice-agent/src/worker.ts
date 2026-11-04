/**
 * The voice agent on Cloudflare: a Worker routes requests, and each call runs in its own Durable Object
 * (CallRoom) that holds the caller's WebSocket plus the Muse STT / Deepgram TTS sockets for the call.
 * Runs with the laptop closed. Local dev: `npm run dev` (wrangler dev on :8787, LOCAL_DEV=1 in .dev.vars).
 *
 * GET  /health, /models, /voices
 * POST /ask/chat, /ask/sam           Ask Vibe (Meta Muse Spark, SAM 3.1)            trusted only
 * POST /ask/prompt                   write an agent prompt in the standard structure  trusted only
 * POST /calls/telnyx|twilio          dial out; the provider streams the call back    trusted only
 * WS   /ws/telnyx|twilio/<id>        that call's media (one-time id per call)
 * WS   /ws/call?codec=browser        browser demo call (PCM16 24 kHz both ways)       trusted only
 * POST /campaigns/run                start a voice campaign (campaign.ts)             trusted only
 *
 * "Trusted" = the deployed app's proxy (functions/voice-agent) vouching for a signed-in user with
 * AGENT_PROXY_KEY, or local dev. Every call is metered against the user's minutes (billing.ts).
 */
import { DurableObject } from "cloudflare:workers";
import { config } from "./config.js";
import { VoiceSession } from "./session/VoiceSession.js";
import { META_CHAT_MODELS, resolveModel } from "./llm/groqStreamer.js";
import { askChat, askPrompt, askSam } from "./askVibe.js";
import { parseOwner, saveCallLog, uploadRecording, type CallOwner } from "./callLog.js";
import { allowance, meter, NO_MINUTES } from "./billing.js";
import { startCampaign } from "./campaign.js";
import { bookingTools } from "./booking.js";
import { withKnowledge } from "./knowledge.js";
import { customTools } from "./customTools.js";
import { crmTools } from "./crmTools.js";
import { askAnalyze } from "./analyze.js";
import { dialStep, forwardingNumbers, mergeTools, nextStep, transferTool } from "./forwarding.js";
export { CampaignRun } from "./campaign.js";

type Env = { CALLS: DurableObjectNamespace<CallRoom>; CAMPAIGNS: DurableObjectNamespace; AGENT_PROXY_KEY?: string; LOCAL_DEV?: string; PUBLIC_URL?: string };

const MAX_PROMPT_CHARS = 20_000;
const E164 = /^\+[1-9]\d{6,14}$/;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function trusted(req: Request, env: Env) {
  if (env.LOCAL_DEV === "1") return true;
  const key = new TextEncoder().encode(env.AGENT_PROXY_KEY ?? "");
  const got = new TextEncoder().encode(req.headers.get("x-vibe-proxy-key") ?? "");
  return key.length >= 32 && got.length === key.length && (crypto.subtle as unknown as { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean }).timingSafeEqual(got, key) // Workers-only;
}

export type Voice = { id: string; name: string; language: string; accent: string; gender: string; sample: string };
let voiceCache: Promise<Voice[]> | null = null;
/** Every Deepgram Aura voice this key can use, fetched once per isolate. */
/** Deepgram's TTS voices, newest first by language. */
async function fetchDeepgramVoices(): Promise<Voice[]> {
  // Deepgram's model list is slow (3-19 s, ~190 KB), so this only runs on a cache miss or a background refresh.
  const r = await fetch("https://api.deepgram.com/v1/models", { headers: { Authorization: `Token ${config.deepgramApiKey}` }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`Deepgram HTTP ${r.status}`);
  const d: any = await r.json();
  return (d.tts ?? [])
    .map((v: any) => ({
      id: v.canonical_name,
      name: v.metadata?.display_name || v.name,
      language: v.languages?.[0] ?? "",
      accent: v.metadata?.accent ?? "",
      gender: (v.metadata?.tags ?? []).find((t: string) => t === "feminine" || t === "masculine") ?? "",
      sample: v.metadata?.sample ?? "",
    }))
    .sort((a: Voice, b: Voice) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
}

const VOICES_KEY = "https://vibe-voice.internal/voices-v1"; // Cloudflare cache key (shared by every instance in a location)
const VOICES_FRESH_MS = 24 * 3600_000;

/** Voices from memory, else Cloudflare's cache (refreshed in the background once a day old), else Deepgram. */
function listVoices(waitUntil?: (p: Promise<unknown>) => void): Promise<Voice[]> {
  voiceCache ??= (async () => {
    const cache = (globalThis as any).caches?.default as Cache | undefined;
    const save = async () => {
      const voices = await fetchDeepgramVoices();
      await cache?.put(VOICES_KEY, new Response(JSON.stringify({ at: Date.now(), voices }), { headers: { "Cache-Control": "max-age=604800" } }));
      return voices;
    };
    const hit: { at: number; voices: Voice[] } | undefined = await cache?.match(VOICES_KEY).then((r) => r?.json() as Promise<{ at: number; voices: Voice[] }> | undefined).catch(() => undefined);
    if (hit?.voices?.length) {
      if (Date.now() - hit.at > VOICES_FRESH_MS) waitUntil?.(save().catch(() => undefined)); // stale: serve it, refresh quietly
      return hit.voices;
    }
    return save();
  })().catch((e) => { voiceCache = null; throw e; });
  return voiceCache;
}
/** Only voice ids Deepgram lists; anything else falls back to the default. */
async function resolveVoice(requested: unknown): Promise<string> {
  if (typeof requested !== "string") return config.ttsModel;
  const voices = await listVoices().catch(() => []);
  return voices.some((v) => v.id === requested) ? requested : config.ttsModel;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/models") return json(200, { default: config.defaultModel, models: META_CHAT_MODELS });
    if (path === "/voices") {
      try { return json(200, { default: config.ttsModel, voices: await listVoices((p) => ctx.waitUntil(p)) }); } catch (e) { return json(502, { error: (e as Error).message }); }
    }
    if (path === "/ask/chat" || path === "/ask/sam" || path === "/ask/prompt" || path === "/ask/analyze") {
      if (req.method !== "POST" || !trusted(req, env)) return new Response(null, { status: 403 });
      return path === "/ask/chat" ? askChat(req) : path === "/ask/sam" ? askSam(req) : path === "/ask/analyze" ? askAnalyze(req) : askPrompt(req);
    }
    const dial = path.match(/^\/calls\/(telnyx|twilio)$/);
    if (dial) {
      if (req.method !== "POST") return json(405, { error: "Method not allowed" });
      if (!trusted(req, env)) return json(403, { error: "forbidden" });
      const id = crypto.randomUUID();
      // Where the provider streams the call: this Worker's own public address (or PUBLIC_URL for a local tunnel).
      const streamBase = (env.PUBLIC_URL || url.origin).replace(/^http/, "ws").replace(/\/$/, "");
      return env.CALLS.get(env.CALLS.idFromName(id)).fetch(`https://call/dial?provider=${dial[1]}&id=${id}&base=${encodeURIComponent(streamBase)}`, { method: "POST", body: await req.text() });
    }
    if (path === "/campaigns/run") {
      if (req.method !== "POST") return json(405, { error: "Method not allowed" });
      if (!trusted(req, env)) return json(403, { error: "forbidden" });
      const body = await req.json().catch(() => null);
      return startCampaign(body, env as never, (env.PUBLIC_URL || url.origin).replace(/^http/, "ws").replace(/\/$/, ""));
    }
    // Twilio tells us when a dialed call ends (signed with the account's auth token, checked by the CallRoom).
    const status = path.match(/^\/calls\/twilio\/status\/([0-9a-f-]{36})$/);
    if (status && req.method === "POST") {
      const headers = new Headers(req.headers);
      headers.set("x-original-url", req.url);
      return env.CALLS.get(env.CALLS.idFromName(status[1])).fetch(new Request("https://call/status", { method: "POST", headers, body: await req.text() }));
    }
    // Twilio reports each forwarding attempt (Call Forwarding): the CallRoom rings the next number or hangs up.
    const fwd = path.match(/^\/calls\/twilio\/forward\/([0-9a-f-]{36})$/);
    if (fwd && req.method === "POST") {
      const headers = new Headers(req.headers);
      headers.set("x-original-url", req.url);
      return env.CALLS.get(env.CALLS.idFromName(fwd[1])).fetch(new Request("https://call/forward", { method: "POST", headers, body: await req.text() }));
    }
    const media = path.match(/^\/ws\/(telnyx|twilio)\/([0-9a-f-]{36})$/);
    if (media) return env.CALLS.get(env.CALLS.idFromName(media[2])).fetch(req);
    if (path === "/ws/call") {
      if (!trusted(req, env)) return new Response(null, { status: 403 });
      // Through the proxy the owner is the verified user it names, never something the client sends.
      const proxyOwner = parseOwner({ userId: req.headers.get("x-vibe-user") });
      if (!proxyOwner && env.LOCAL_DEV !== "1") return new Response(null, { status: 403 });
      const headers = new Headers(req.headers);
      headers.set("x-owner", proxyOwner?.userId ?? "");
      return env.CALLS.get(env.CALLS.newUniqueId()).fetch(new Request(req.url, { headers }));
    }
    return new Response(null, { status: 404 });
  },
};

type DialedCall = {
  provider: "telnyx" | "twilio"; model: string; systemPrompt?: string; voice: string; owner: CallOwner; from: string; to: string;
  dialedAt: string; callControlId?: string; base?: string; // base: this Worker's https address, for Twilio callbacks
  seconds: number | null; // talk time left; null = unmetered (admin). JSON can't hold Infinity.
  creds: { apiKey?: string; accountSid?: string; authToken?: string }; // to hang up when minutes run out
  connected?: boolean;
  campaign?: { id: string; contactId: string; round: number }; // set when a campaign placed this call
};

/** A campaign call ended: write its result on the contact's outcome row (the runner created it as PENDING). */
function recordOutcome(call: DialedCall, outcome: "ANSWERED" | "VOICEMAIL" | "NO_ANSWER") {
  if (!call.campaign) return Promise.resolve();
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const { id, contactId, round } = call.campaign;
  return fetch(`${url}/rest/v1/call_outcomes?user_id=eq.${encodeURIComponent(call.owner.userId)}&campaign_id=eq.${id}&contact_id=eq.${contactId}&attempt_number=eq.${round}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ outcome, call_timestamp: new Date().toISOString() }),
  }).then(() => undefined, (e) => console.error("outcome update failed", e));
}

/** One call. Phone calls: named by the call id, so the dial request and the provider's media socket meet here. */
export class CallRoom extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/dial") return this.dial(req, url);
    if (url.pathname === "/status") return this.twilioStatus(req);
    if (url.pathname === "/forward") return this.forwardStep(req);
    if (req.headers.get("Upgrade") !== "websocket") return new Response(null, { status: 426 });
    const media = url.pathname.match(/^\/ws\/(telnyx|twilio)\/([0-9a-f-]{36})$/);
    if (media) return this.media(media[1] as "telnyx" | "twilio", media[2]);
    return this.browser(url, req.headers.get("x-owner") || null);
  }

  /** Never answered: log it once the provider has given up ringing. */
  async alarm() {
    const call = await this.ctx.storage.get<DialedCall>("call");
    if (!call || call.connected) return;
    await this.ctx.storage.deleteAll();
    await recordOutcome(call, "NO_ANSWER");
    await saveCallLog({ owner: call.owner, direction: "outbound", status: "no-answer", from: call.from, to: call.to, startedAt: new Date(call.dialedAt), endedAt: new Date(), transcript: [] });
  }

  private async dial(req: Request, url: URL): Promise<Response> {
    const provider = url.searchParams.get("provider") as "telnyx" | "twilio";
    const id = url.searchParams.get("id")!;
    const base = url.searchParams.get("base")!;
    let b: any;
    try { b = await req.json(); } catch { return json(400, { error: "invalid JSON" }); }
    const { apiKey, connectionId, accountSid, authToken, from, to, systemPrompt } = b ?? {};
    if (provider === "telnyx" && (typeof apiKey !== "string" || !apiKey || typeof connectionId !== "string" || !connectionId)) return json(400, { error: "Telnyx API key and Connection ID are required" });
    if (provider === "twilio" && (typeof accountSid !== "string" || !/^AC[0-9a-f]{32}$/i.test(accountSid) || typeof authToken !== "string" || !authToken)) return json(400, { error: "Twilio Account SID and Auth Token are required (Phone Integration)" });
    if (!E164.test(String(from)) || !E164.test(String(to))) return json(400, { error: "from and to must be E.164 numbers like +15551234567" });
    const owner = parseOwner(b);
    if (!owner) return json(401, { error: "Sign in again to place calls." });
    const allowed = await allowance(owner.userId);
    if ("error" in allowed) return json(402, { error: allowed.error });

    const call: DialedCall = {
      provider, from, to, owner, base: base.replace(/^ws/, "http"),
      model: resolveModel(b.model),
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt.slice(0, MAX_PROMPT_CHARS) : undefined,
      voice: await resolveVoice(b.voice),
      dialedAt: new Date().toISOString(),
      seconds: Number.isFinite(allowed.seconds) ? allowed.seconds : null,
      creds: provider === "twilio" ? { accountSid, authToken } : { apiKey },
      campaign:
        typeof b.campaign?.id === "string" && typeof b.campaign?.contactId === "string"
          ? { id: b.campaign.id, contactId: b.campaign.contactId, round: Number(b.campaign.round) || 1 }
          : undefined,
    };

    if (provider === "twilio") {
      // Twilio runs this TwiML when the callee answers: stream both ways to us, record on Twilio's side.
      const twiml = `<Response><Connect><Stream url="${base}/ws/twilio/${id}"/></Connect></Response>`;
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          To: to, From: from, Twiml: twiml, Record: "true",
          // Ends our side as soon as the phone call ends, and bills from Twilio's own call length.
          StatusCallback: `${base.replace(/^ws/, "http")}/calls/twilio/status/${id}`, StatusCallbackEvent: "completed",
        }),
      }).catch((e) => e as Error);
      const data: any = r instanceof Error ? { message: r.message } : await r.json().catch(() => ({}));
      if (r instanceof Error || !r.ok) return json(502, { error: `Twilio: ${data?.message || "request failed"}` });
      call.callControlId = data?.sid;
    } else {
      const r = await fetch("https://api.telnyx.com/v2/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          connection_id: connectionId, to, from,
          stream_url: `${base}/ws/telnyx/${id}`,
          stream_track: "inbound_track",
          stream_bidirectional_mode: "rtp",
          stream_bidirectional_codec: "PCMU",
          // Telnyx keeps the recording; Call History fetches it live (we never store audio).
          record: "record-from-answer",
          record_format: "mp3",
          record_channels: "dual",
        }),
      }).catch((e) => e as Error);
      const data: any = r instanceof Error ? {} : await r.json().catch(() => ({}));
      if (r instanceof Error || !r.ok) {
        const e = data?.errors?.[0];
        return json(502, { error: `Telnyx: ${e?.detail || e?.title || (r instanceof Error ? r.message : `HTTP ${r.status}`)}` });
      }
      call.callControlId = data?.data?.call_control_id;
    }
    await this.ctx.storage.put("call", call);
    await this.ctx.storage.setAlarm(Date.now() + 120_000);
    console.log(`[${provider}-${id.slice(0, 8)}] dialing ${to} from ${from}`);
    return json(200, { callControlId: call.callControlId });
  }

  private hangup(call: DialedCall) {
    const { accountSid, authToken, apiKey } = call.creds;
    return (call.provider === "twilio"
      ? fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.callControlId}.json`, {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ Status: "completed" }),
        })
      : fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(call.callControlId ?? "")}/actions/hangup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: "{}",
        })
    ).then((r) => r.body?.cancel(), () => undefined);
  }

  /** The live call's end function (set while media is connected), so Twilio's status callback can end it. */
  private activeEnd: ((providerSeconds?: number) => void) | null = null;

  /** Twilio's form body if X-Twilio-Signature matches the account's auth token, else null. */
  private async twilioSigned(req: Request, authToken: string): Promise<URLSearchParams | null> {
    const params = new URLSearchParams(await req.text());
    const signed = (req.headers.get("x-original-url") ?? "") + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)))));
    return mac === req.headers.get("x-twilio-signature") ? params : null;
  }

  /** Set when the agent transfers a Twilio call; kept in storage after the AI part ends, for the forward steps. */
  private forward: { numbers: string[]; from: string; authToken: string; action: string } | null = null;

  /** POST /forward?i= from Twilio after ringing forwarding number i: ring the next one, or hang up. */
  private async forwardStep(req: Request): Promise<Response> {
    const f = await this.ctx.storage.get<NonNullable<CallRoom["forward"]>>("forward");
    if (!f) return new Response("<Response><Hangup/></Response>", { headers: { "Content-Type": "text/xml" } });
    const params = await this.twilioSigned(req, f.authToken);
    if (!params) return new Response(null, { status: 403 });
    const i = Number(new URL(req.headers.get("x-original-url") ?? "", "https://x").searchParams.get("i")) || 0;
    const twiml = nextStep(f.numbers, i, params.get("DialCallStatus"), f.from, f.action);
    console.log(`[forward] number ${i + 1}/${f.numbers.length}: ${params.get("DialCallStatus")}`);
    if (twiml.includes("<Hangup/>")) await this.ctx.storage.deleteAll();
    return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
  }

  /** The agent called transfer_call: hand the phone call from the AI stream to the forwarding numbers. */
  private async transfer(call: DialedCall, id: string, numbers: string[]) {
    console.log(`[${call.provider}-${id.slice(0, 8)}] transferring to ${numbers.length} number(s)`);
    const { accountSid, authToken, apiKey } = call.creds;
    if (call.provider === "twilio") {
      const action = `${call.base}/calls/twilio/forward/${id}`;
      this.forward = { numbers, from: call.from, authToken: authToken!, action };
      await this.ctx.storage.put("forward", this.forward);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.callControlId}.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Twiml: dialStep(numbers, 0, call.from, action) }),
      }).catch((e: Error) => e);
      if (r instanceof Error || !r.ok) console.error("transfer failed", r instanceof Error ? r.message : `${r.status} ${(await r.text()).slice(0, 200)}`);
    } else {
      // ponytail: Telnyx transfers to the first number only; ring the rest in order with call-control webhooks if needed.
      const r = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(call.callControlId ?? "")}/actions/transfer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to: numbers[0], from: call.from }),
      }).catch((e: Error) => e);
      if (r instanceof Error || !r.ok) console.error("transfer failed", r instanceof Error ? r.message : `${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  }

  /** POST /status from Twilio: the phone call ended. Verified with X-Twilio-Signature (the account's auth token). */
  private async twilioStatus(req: Request): Promise<Response> {
    const call = await this.ctx.storage.get<DialedCall>("call");
    if (!call?.creds.authToken) return new Response(null, { status: 204 });
    const params = await this.twilioSigned(req, call.creds.authToken);
    if (!params) return new Response(null, { status: 403 });

    const seconds = Number(params.get("CallDuration"));
    const providerSeconds = Number.isFinite(seconds) ? seconds : undefined;
    if (this.activeEnd) {
      this.activeEnd(providerSeconds);
    } else if (call.connected) {
      // Our side was gone (e.g. the media socket broke): still log the call from what was saved, and bill Twilio's length.
      const transcript = (await this.ctx.storage.get<any[]>("transcript")) ?? [];
      const startedAt = new Date((await this.ctx.storage.get<string>("startedAt")) ?? call.dialedAt);
      this.ctx.waitUntil(Promise.all([
        call.seconds === null ? undefined : meter(call.owner.userId, call.seconds, "live_deduction", () => {}).stop(providerSeconds ?? 0),
        recordOutcome(call, (providerSeconds ?? 0) > 10 ? "ANSWERED" : "VOICEMAIL"),
        saveCallLog({ owner: call.owner, direction: "outbound", status: "completed", from: call.from, to: call.to, startedAt, endedAt: new Date(), transcript, providerCallId: call.callControlId }),
        this.ctx.storage.deleteAll(),
      ]));
    } else if (["busy", "no-answer", "failed", "canceled"].includes(params.get("CallStatus") ?? "")) {
      await this.ctx.storage.deleteAlarm();
      await this.alarm(); // logs it as not answered right away instead of after 2 minutes
    }
    return new Response(null, { status: 204 });
  }

  /** The dialed call's media. Telnyx and Twilio both stream PCMU 8 kHz JSON; Twilio also needs its streamSid on every send. */
  private async media(provider: "telnyx" | "twilio", id: string): Promise<Response> {
    const call = await this.ctx.storage.get<DialedCall>("call");
    if (!call || call.provider !== provider || call.connected) return new Response(null, { status: 404 });
    call.connected = true; // one connection per id
    await this.ctx.storage.put("call", call);
    await this.ctx.storage.deleteAlarm();
    const [booking, systemPrompt, forwardTo, custom, crm] = await Promise.all([
      bookingTools(call.owner.userId, call.owner.agentId),
      withKnowledge(call.systemPrompt, call.owner.userId, call.owner.agentId),
      forwardingNumbers(call.owner.userId, call.owner.agentId),
      customTools(call.owner.userId, call.owner.agentId),
      crmTools(call.owner.userId, call.owner.agentId).catch(() => undefined),
    ]);
    // ponytail: waits a fixed 6 s so "Connecting you now" is spoken before the hand-off; hook TTS "done" if it clips.
    const tools = mergeTools(mergeTools(mergeTools(booking, custom), crm), forwardTo.length ? transferTool(() => setTimeout(() => this.ctx.waitUntil(this.transfer(call, id, forwardTo)), 6000)) : undefined);

    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    ws.binaryType = "arraybuffer"; // this runtime defaults to Blob
    const sendJson = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    let session: VoiceSession | null = null;
    let streamSid: string | undefined; // Twilio only
    let billing: ReturnType<typeof meter> | null = null;
    let saveTimer: ReturnType<typeof setInterval> | undefined;
    const end = (providerSeconds?: number) => {
      if (!session) return;
      const s = session;
      session = null;
      this.activeEnd = null;
      clearInterval(saveTimer);
      s.stop();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "call ended");
      const seconds = providerSeconds ?? (Date.now() - s.startedAt.getTime()) / 1000;
      this.ctx.waitUntil(
        Promise.all([
          billing?.stop(providerSeconds),
          recordOutcome(call, seconds > 10 ? "ANSWERED" : "VOICEMAIL"), // same rule the Campaigns page uses
          saveCallLog({
            owner: call.owner, direction: "outbound", status: this.forward ? "forwarded" : "completed", from: call.from, to: call.to,
            startedAt: s.startedAt, endedAt: new Date(), transcript: s.transcript,
            providerCallId: call.callControlId ? (call.provider === "telnyx" ? `telnyx:${call.callControlId}` : call.callControlId) : undefined, // Twilio: plain CallSid
          }),
          this.ctx.storage.deleteAll().then(() => this.forward && this.ctx.storage.put("forward", this.forward)),
        ]),
      );
    };
    ws.addEventListener("message", (e) => {
      let msg: any;
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)); } catch { return; }
      if (msg.event === "start" && !session) {
        call.callControlId ??= msg.start?.call_control_id;
        streamSid = msg.start?.streamSid ?? msg.streamSid;
        session = new VoiceSession(
          "twilio", // same mu-law 8 kHz audio format
          {
            sendAudio: (chunk) => sendJson({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }),
            sendClear: () => sendJson({ event: "clear", streamSid }),
          },
          `${provider}-${id.slice(0, 8)}`,
          call.model,
          systemPrompt,
          call.voice,
          tools,
        );
        session.start();
        this.activeEnd = end;
        // Keep the transcript in storage as the call goes, so a broken connection can still be logged.
        const live = session;
        this.ctx.waitUntil(this.ctx.storage.put("startedAt", live.startedAt.toISOString()));
        saveTimer = setInterval(() => void this.ctx.storage.put("transcript", live.transcript), 10_000);
        // Minutes run out mid-call: hang up at the provider (closing the stream alone doesn't end a Telnyx call).
        billing = meter(call.owner.userId, call.seconds ?? Infinity, "live_deduction", () => {
          console.log(`[${provider}-${id.slice(0, 8)}] minutes used up, hanging up`);
          this.ctx.waitUntil(this.hangup(call));
          ws.close(1000, "minutes used up");
          end();
        });
      } else if (msg.event === "media" && (!msg.media?.track || msg.media.track === "inbound")) {
        session?.handleCallerAudio(Buffer.from(msg.media.payload, "base64"));
      } else if (msg.event === "stop") {
        end();
      }
    });
    ws.addEventListener("close", () => end());
    ws.addEventListener("error", () => end());
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Browser demo call. With ?config=1 the first text message is {"systemPrompt", "voice", "userId", "agentId"}
   * (the agent's own instructions, too long for a URL); the session starts once it arrives and the minutes check passes.
   */
  private async browser(url: URL, proxyOwnerId: string | null): Promise<Response> {
    const model = resolveModel(url.searchParams.get("model"));
    const waitForConfig = url.searchParams.get("config") === "1";
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    ws.binaryType = "arraybuffer"; // this runtime defaults to Blob
    const send = (event: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event));
    let session: VoiceSession | null = null;
    let configuring = false;
    let owner: CallOwner | null = proxyOwnerId ? parseOwner({ userId: proxyOwnerId }) : null;
    let billing: ReturnType<typeof meter> | null = null;

    const begin = async (agentPrompt?: string, voice?: string) => {
      if (owner) {
        const allowed = await allowance(owner.userId);
        if (ws.readyState !== WebSocket.OPEN) return;
        if ("error" in allowed) {
          send({ type: "error", error: allowed.error });
          return ws.close(4402, "no minutes");
        }
        billing = meter(owner.userId, allowed.seconds, "demo_deduction", () => {
          send({ type: "ended", reason: NO_MINUTES });
          ws.close(4402, "minutes used up");
          close();
        });
      } else {
        // A call nobody can be billed for doesn't start.
        send({ type: "error", error: "Sign in again to start a demo call." });
        return ws.close(1008, "no owner");
      }
      const [booking, custom, crm, promptWithKnowledge] = await Promise.all([
        bookingTools(owner.userId, owner.agentId),
        customTools(owner.userId, owner.agentId),
        crmTools(owner.userId, owner.agentId).catch(() => undefined),
        withKnowledge(agentPrompt?.slice(0, MAX_PROMPT_CHARS), owner.userId, owner.agentId),
      ]);
      if (ws.readyState !== WebSocket.OPEN) return;
      const tools = mergeTools(mergeTools(booking, custom), crm);
      session = new VoiceSession(
        "browser",
        {
          sendAudio: (chunk) => ws.readyState === WebSocket.OPEN && ws.send(chunk),
          sendClear: () => send({ type: "clear" }),
          sendEvent: send,
        },
        `browser-${crypto.randomUUID().slice(0, 8)}`,
        model,
        promptWithKnowledge,
        voice,
        tools,
      );
      send({ type: "ready", model, voice: voice ?? config.ttsModel });
      session.start();
    };

    const close = () => {
      const s = session;
      session = null;
      const deducted = billing?.stop();
      if (!s) return void this.ctx.waitUntil(Promise.resolve(deducted));
      s.stop();
      if (owner && s.transcript.length) {
        const endedAt = new Date();
        const recording = s.recordingWav();
        const who = owner;
        this.ctx.waitUntil(
          Promise.all([
            deducted,
            (recording ? uploadRecording(who, recording) : Promise.resolve(undefined)).then((providerCallId) =>
              saveCallLog({ owner: who, direction: "demo", status: "completed", startedAt: s.startedAt, endedAt, transcript: s.transcript, providerCallId }),
            ),
          ]),
        );
      } else this.ctx.waitUntil(Promise.resolve(deducted));
    };

    if (!waitForConfig) void begin();
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return session?.handleCallerAudio(Buffer.from(e.data as ArrayBuffer));
      if (session || configuring) return;
      let cfg: any;
      try { cfg = JSON.parse(e.data); } catch { return ws.close(1008, "bad config message"); }
      configuring = true; // audio arriving while the voice is checked is dropped (session not up yet)
      // Through the proxy only the agent id comes from the client; locally the app names the user too.
      owner = owner ? parseOwner({ userId: owner.userId, agentId: cfg.agentId }) : parseOwner(cfg);
      resolveVoice(cfg.voice).then((voice) => { if (ws.readyState === WebSocket.OPEN) void begin(typeof cfg.systemPrompt === "string" ? cfg.systemPrompt : undefined, voice); });
    });
    ws.addEventListener("close", close);
    ws.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client });
  }
}
