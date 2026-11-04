import { getClerkToken } from "@/integrations/supabase/client";

export type DemoCallStatus = "disconnected" | "disconnecting" | "connecting" | "listening" | "thinking" | "speaking";

export type DemoTranscriptItem = {
  ordinal: number;
  text: string;
  speaker: string;
  isFinal: boolean;
  medium: string;
};

export type DemoCallJoinConfig = { model: string; systemPrompt?: string | null; voice?: string | null; userId?: string; agentId?: string };

const VOICE_AGENT_URL = import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`;
const META_RATE = 24000; // voice agent browser codec: PCM16 mono 24 kHz both ways

// Mic -> PCM16 frames of 80 ms (1920 samples at 24 kHz), sent continuously, silence included.
const PCM16_WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1920); this.n = 0; }
  process([input]) {
    const ch = input[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);`;

/**
 * Meta agents: talks to services/voice-agent over one WebSocket
 * (Meta Muse Voice Transcribe -> Muse Spark -> Deepgram voice). No edge function involved.
 */
class MetaVoiceAgentRuntime {
  private transcripts: DemoTranscriptItem[] = [];
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private playing = new Set<AudioBufferSourceNode>();
  private nextPlayTime = 0;
  private oddByte: number | null = null;
  private mutedMic = false;
  private mutedSpeaker = false;
  private thinking = false;
  private ended = false;

  constructor(
    private readonly config: DemoCallJoinConfig,
    private readonly callbacks: DemoCallServiceOptions,
  ) {}

  get status(): DemoCallStatus {
    if (this.ended) return "disconnected";
    if (this.ctx && this.nextPlayTime > this.ctx.currentTime) return "speaking";
    return this.thinking ? "thinking" : "listening";
  }
  get isMicMuted() { return this.mutedMic; }
  get isSpeakerMuted() { return this.mutedSpeaker; }
  getTranscripts() { return [...this.transcripts]; }

  private emit() {
    this.callbacks.onStatusChange?.(this.status);
    this.callbacks.onTranscriptsChange?.(this.getTranscripts());
  }

  private push(speaker: "user" | "agent", text: string) {
    this.transcripts.push({ ordinal: this.transcripts.length, text, speaker, isFinal: true, medium: "voice" });
  }

  async join() {
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: META_RATE });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    const url = URL.createObjectURL(new Blob([PCM16_WORKLET], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.worklet = new AudioWorkletNode(this.ctx, "pcm16");
    this.ctx.createMediaStreamSource(this.mic).connect(this.worklet);

    // The token lets the deployed app's proxy check who is calling (the voice agent meters their minutes).
    const token = (await getClerkToken()) ?? "";
    const wsUrl = `${VOICE_AGENT_URL.replace(/^http/, "ws")}/ws/call?codec=browser&config=1&model=${encodeURIComponent(this.config.model)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Could not reach the voice agent at ${VOICE_AGENT_URL}. Start it with npm run dev in services/voice-agent.`));
    });
    ws.send(JSON.stringify({ systemPrompt: this.config.systemPrompt || "", voice: this.config.voice || undefined, userId: this.config.userId, agentId: this.config.agentId }));
    // Wait for the agent to accept the call (it refuses when the minutes are used up).
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const ev = JSON.parse(e.data);
        if (ev.type === "ready") resolve();
        else if (ev.type === "error") reject(new Error(ev.error || "The call could not start."));
      };
      ws.onclose = () => reject(new Error("The voice agent closed the call before it started."));
    });
    this.worklet.port.onmessage = (e) => {
      if (!this.mutedMic && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return this.play(e.data as ArrayBuffer);
      const ev = JSON.parse(e.data);
      if (ev.type === "final") { this.push("user", ev.text); this.thinking = true; }
      else if (ev.type === "reply") { this.push("agent", ev.text); this.thinking = false; }
      else if (ev.type === "latency") this.thinking = false;
      else if (ev.type === "clear") this.stopPlayback();
      else if (ev.type === "ended") return this.callbacks.onRuntimeError?.(ev.reason || "The call ended.");
      else return;
      this.emit();
    };
    ws.onclose = () => { if (!this.ended) void this.leave(); };
    this.emit();
  }

  private play(data: ArrayBuffer) {
    if (!this.ctx || !this.gain) return;
    let bytes = new Uint8Array(data);
    if (this.oddByte !== null) {
      const b = new Uint8Array(bytes.length + 1);
      b[0] = this.oddByte; b.set(bytes, 1); bytes = b; this.oddByte = null;
    }
    if (bytes.length % 2) { this.oddByte = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
    if (!bytes.length) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const buffer = this.ctx.createBuffer(1, pcm.length, META_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const wasSpeaking = this.status === "speaking";
    this.nextPlayTime = Math.max(this.nextPlayTime, this.ctx.currentTime + 0.02);
    src.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.playing.add(src);
    src.onended = () => { this.playing.delete(src); if (this.playing.size === 0) this.emit(); };
    if (!wasSpeaking) this.emit();
  }

  private stopPlayback() {
    for (const src of this.playing) { try { src.stop(); } catch { /* already stopped */ } }
    this.playing.clear();
    this.nextPlayTime = 0;
    this.oddByte = null;
  }

  async leave() {
    this.ended = true;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) { this.ws.onclose = null; this.ws.close(); }
    this.ws = null;
    this.stopPlayback();
    this.worklet?.disconnect();
    this.mic?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.emit();
  }

  toggleMic() { this.mutedMic = !this.mutedMic; }
  toggleSpeaker() {
    this.mutedSpeaker = !this.mutedSpeaker;
    if (this.gain) this.gain.gain.value = this.mutedSpeaker ? 0 : 1;
  }
}
type DemoCallServiceOptions = {
  onStatusChange?: (status: DemoCallStatus) => void;
  onTranscriptsChange?: (transcripts: DemoTranscriptItem[]) => void;
  onRuntimeError?: (message: string) => void;
};

export class DemoCallService {
  private runtime: MetaVoiceAgentRuntime | null = null;

  constructor(private readonly options: DemoCallServiceOptions = {}) {}

  async join(config: DemoCallJoinConfig) {
    // End a lingering previous call first instead of blocking the new one.
    if (this.runtime) await this.leave();
    const runtime = new MetaVoiceAgentRuntime(config, this.options);
    try {
      await runtime.join();
      this.runtime = runtime;
    } catch (error) {
      await runtime.leave().catch(() => undefined);
      throw error;
    }
  }

  async leave() {
    const runtime = this.runtime;
    if (!runtime) return;
    // Clear the ref before teardown so a throw can't leave the service stuck "in a call".
    this.runtime = null;
    try {
      await runtime.leave();
      this.options.onTranscriptsChange?.(runtime.getTranscripts());
    } catch {
      // Teardown failure shouldn't block future calls.
    }
  }

  toggleMic() {
    if (!this.runtime) return;
    this.runtime.toggleMic();
    this.options.onStatusChange?.(this.runtime.status);
  }

  toggleSpeaker() {
    if (!this.runtime) return;
    this.runtime.toggleSpeaker();
    this.options.onStatusChange?.(this.runtime.status);
  }

  getStatus(): DemoCallStatus { return this.runtime?.status ?? "disconnected"; }
  getTranscripts(): DemoTranscriptItem[] { return this.runtime?.getTranscripts() ?? []; }
  get isMicMuted() { return this.runtime?.isMicMuted ?? false; }
  get isSpeakerMuted() { return this.runtime?.isSpeakerMuted ?? false; }
}
