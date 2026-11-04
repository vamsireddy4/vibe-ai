import { audioFormats, type Codec } from "../config.js";
import { DeepgramTTS } from "../tts/deepgramClient.js";
import { GroqStreamer, type AgentTools } from "../llm/groqStreamer.js";
import { MuseTranscriber } from "../stt/museTranscriber.js";
import { mixPcm16, mulaw8kToPcm16k, wav, type Clip } from "../audio.js";
import type { TranscriptLine } from "../callLog.js";
import { Draft, sameRequest } from "./draft.js";

/** How the session talks back to the caller; the server fills this per transport. */
export interface CallerTransport {
  sendAudio(chunk: Buffer): void; // raw TTS audio in the codec's format
  sendClear(): void; // stop playing whatever is buffered on the caller side
  sendEvent?(event: object): void; // optional transcript/latency events (browser only)
}

const BARGE_IN_MIN_WORDS = 3; // "partial speech event (>2 words)"
const DRAFT_PAUSE_MS = 450; // caller paused this long mid-turn: start thinking on what they said so far
// ponytail: recording is held in memory (~5.8 MB/min at 24 kHz, both sides); capped to fit a Durable
// Object's 128 MB with the mixdown. Longer calls keep going, the recording just stops at 5 minutes.
const MAX_RECORDING_MS = 5 * 60_000;
/** One call: STT -> LLM -> TTS with barge-in and latency logging. */
export class VoiceSession {
  private stt: MuseTranscriber;
  private tts: DeepgramTTS;
  private llm: GroqStreamer;
  private format;

  private abortController: AbortController | null = null;
  private turn = 0;
  private generating = false; // LLM/TTS still producing audio for this turn
  private llmDone = false;
  private pendingFlushes = 0; // one Flush per phrase; turn audio is done when all come back
  private playbackEndsAt = 0; // when the caller finishes playing what we've sent (ms)
  // Thinking while the caller talks (see draft.ts): at most one draft at a time.
  private draft: Draft | null = null;
  private livePartial = "";
  private draftTimer: ReturnType<typeof setTimeout> | undefined;

  /** What was said, for the call log. Replies cut off by barge-in are left out. */
  readonly transcript: TranscriptLine[] = [];
  readonly startedAt = new Date();
  private t0 = performance.now();
  // Browser calls only (phone calls are recorded by Telnyx): caller + agent audio, mixed on close.
  private clips: { caller: Clip[]; agent: Clip[] } | null;
  private callerAt = -1; // byte offset of the next caller chunk in the recording

  // Latency marks for the current turn (performance.now()).
  private tFinal = 0;
  private tFirstToken = 0;
  private tFirstAudio = 0;

  constructor(private codec: Codec, private caller: CallerTransport, private id: string, model?: string, agentPrompt?: string, voice?: string, tools?: AgentTools) {
    this.llm = new GroqStreamer(model, agentPrompt, tools);
    this.format = audioFormats[codec];
    this.stt = new MuseTranscriber(this.format.sttEncoding);
    this.tts = new DeepgramTTS(this.format.ttsEncoding, this.format.ttsSampleRate, voice);
    this.clips = codec === "browser" ? { caller: [], agent: [] } : null;
  }

  /** Byte offset in the recording for a moment `t` (performance.now()). Both directions are 24 kHz PCM16. */
  private recAt(t: number) {
    return Math.round(((t - this.t0) / 1000) * this.format.ttsSampleRate) * 2;
  }

  private record(who: "caller" | "agent", at: number, pcm: Buffer) {
    if (this.clips && at < this.recAt(this.t0 + MAX_RECORDING_MS)) this.clips[who].push({ at, pcm });
  }

  /** The call as a WAV file (browser calls), or null when there is nothing to save. */
  recordingWav(): Buffer | null {
    const clips = this.clips ? [...this.clips.caller, ...this.clips.agent] : [];
    return clips.length ? wav(mixPcm16(clips), this.format.ttsSampleRate) : null;
  }

  /** Call on connect: pre-warms Deepgram + Muse before the caller speaks. */
  start() {
    this.tts.connect();
    this.stt.connect();
    this.llm.warm();
    this.log(`started (llm ${this.llm.model})`);

    this.tts.on("audio", (chunk: Buffer) => this.onTtsAudio(chunk));
    this.tts.on("flushed", () => {
      this.pendingFlushes = Math.max(0, this.pendingFlushes - 1);
      this.finishTurnIfDone();
    });
    this.tts.on("error", (err) => console.error(`[${this.id}] tts error`, err.message));

    this.stt.on("partial", (text: string) => {
      this.caller.sendEvent?.({ type: "partial", text });
      this.livePartial = text;
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => this.startDraft(), DRAFT_PAUSE_MS);
      if (this.isAgentSpeaking() && text.trim().split(/\s+/).length >= BARGE_IN_MIN_WORDS) {
        this.bargeIn(`user said "${text}"`);
      }
    });
    // Re-warm Groq while the user talks, so the TLS connection is fresh when the turn ends.
    this.stt.on("speechStart", () => this.llm.warm());
    // Talking stopped: the final text is still being post-processed, so start thinking now.
    this.stt.on("speechEnd", () => { this.log("speech end"); clearTimeout(this.draftTimer); this.startDraft(); });
    this.stt.on("final", (text: string) => this.onFinalTranscript(text));
    this.stt.on("error", (err) => console.error(`[${this.id}] stt error`, err.message));
  }

  /** Caller audio: Twilio mu-law 8 kHz, or browser PCM16 24 kHz. */
  handleCallerAudio(chunk: Buffer) {
    this.stt.sendAudio(this.codec === "twilio" ? mulaw8kToPcm16k(chunk) : chunk);
    if (this.clips) {
      // Caller audio is a continuous live stream: lay chunks end to end from the first one.
      if (this.callerAt < 0) this.callerAt = this.recAt(performance.now());
      this.record("caller", this.callerAt, chunk);
      this.callerAt += chunk.length;
    }
  }

  /** Start a silent draft reply to what the caller has said so far (skipped while the last reply is still coming). */
  private startDraft() {
    const text = this.livePartial.trim();
    // No drafts with tools: a draft can't run a tool call (e.g. booking) safely before the caller finished.
    if (text.split(/\s+/).length < 2 || this.generating || this.llm.hasTools) return;
    if (this.draft && sameRequest(this.draft.text, text) && sameRequest(text, this.draft.text)) return; // already on it
    this.draft?.abort();
    this.draft = new Draft(text, (signal) => this.llm.tokens(text, signal));
    this.log(`draft started: "${text}"`);
  }

  private isAgentSpeaking() {
    return this.generating || performance.now() < this.playbackEndsAt;
  }

  private bargeIn(reason: string) {
    this.log(`barge-in: ${reason}`);
    this.abortController?.abort();
    this.abortController = null;
    this.llm.warm(); // aborting the stream closes its connection; reopen it before the next turn
    this.tts.clear();
    this.caller.sendClear();
    // The caller's player drops what it hadn't played yet; cut the recording the same way.
    const now = this.recAt(performance.now());
    for (const c of this.clips?.agent ?? []) if (c.at + c.pcm.length > now) c.pcm = c.pcm.subarray(0, Math.max(0, now - c.at));
    this.generating = false;
    this.pendingFlushes = 0;
    this.playbackEndsAt = 0;
  }

  private finishTurnIfDone() {
    if (this.generating && this.llmDone && this.pendingFlushes === 0) {
      this.generating = false;
      this.log(`turn audio complete, total ${ms(performance.now() - this.tFinal)}`);
    }
  }

  private async onFinalTranscript(text: string) {
    // A new user turn while the agent is still talking interrupts it.
    if (this.isAgentSpeaking()) this.bargeIn("new final transcript");

    const turn = ++this.turn;
    // Use the draft if it answered the same request; otherwise throw it away and think from the final text.
    clearTimeout(this.draftTimer);
    this.livePartial = "";
    const draft = this.draft && sameRequest(this.draft.text, text) ? this.draft : null;
    if (this.draft && !draft) this.draft.abort();
    this.draft = null;
    this.log(draft ? `using draft from "${draft.text}"` : "no matching draft, thinking now");
    const controller = draft?.controller ?? new AbortController();
    this.abortController = controller;
    this.generating = true;
    this.llmDone = false;
    this.pendingFlushes = 0;
    this.tFinal = performance.now();
    this.tFirstToken = 0;
    this.tFirstAudio = 0;
    this.log(`user: "${text}"`);
    this.transcript.push({ role: "user", text, timestamp: new Date().toISOString() });
    this.caller.sendEvent?.({ type: "final", text });

    try {
      const { text: reply, aborted } = await this.llm.reply(
        text,
        controller.signal,
        (phrase) => {
          if (turn !== this.turn) return;
          this.tts.speak(phrase);
          this.tts.flush(); // flush each phrase so Deepgram starts synthesizing immediately
          this.pendingFlushes++;
        },
        () => {
          this.tFirstToken = performance.now();
          this.log(`llm TTFT ${ms(this.tFirstToken - this.tFinal)}`);
        },
        draft?.replay(),
      );
      if (turn !== this.turn || aborted) return;
      this.llmDone = true;
      this.finishTurnIfDone();
      this.log(`agent: "${reply.trim()}"`);
      this.transcript.push({ role: "agent", text: reply.trim(), timestamp: new Date().toISOString() });
      this.caller.sendEvent?.({ type: "reply", text: reply.trim() });
    } catch (err) {
      this.generating = false;
      console.error(`[${this.id}] llm error`, (err as Error).message);
    }
  }

  private onTtsAudio(chunk: Buffer) {
    if (!this.abortController) return; // late audio from a turn that was cut off
    const now = performance.now();
    if (!this.tFirstAudio && this.tFinal) {
      this.tFirstAudio = now;
      const latency = this.tFirstAudio - this.tFinal;
      this.log(`first audio byte ${ms(latency)} after final transcript (TTFT ${ms(this.tFirstToken - this.tFinal)})`);
      this.caller.sendEvent?.({ type: "latency", firstAudioMs: Math.round(latency) });
    }
    const chunkMs = (chunk.length / this.format.ttsBytesPerSecond) * 1000;
    const playsAt = Math.max(now, this.playbackEndsAt);
    this.record("agent", this.recAt(playsAt), chunk);
    this.playbackEndsAt = playsAt + chunkMs;
    this.caller.sendAudio(chunk);
  }

  stop() {
    clearTimeout(this.draftTimer);
    this.draft?.abort();
    this.abortController?.abort();
    this.stt.close();
    this.tts.close();
    this.log("session closed");
  }

  private log(msg: string) {
    console.log(`[${this.id} +${((performance.now() - this.t0) / 1000).toFixed(2)}s] ${msg}`);
  }
}

const ms = (n: number) => `${Math.round(n)}ms`;
