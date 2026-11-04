import { EventEmitter } from "node:events";
import { config } from "../config.js";

const MAX_BACKLOG_MS = 4000; // Muse closes with 1008 past ~5s of backlog.

/**
 * Streaming connector for Meta muse-voice-transcribe-1.0 (wss /v1/asr/realtime, ENDPOINTING mode).
 * Protocol: https://dev.meta.ai/docs/speech-to-text
 * Events: "partial" (text), "final" (text, turnId), "speechStart", "speechEnd" (talking stopped; final text follows), "error".
 *
 * Audio must arrive at roughly real time (callers stream live, so we forward as it comes).
 * Keep sending silence during pauses or Muse closes the stream.
 * Standard WebSocket API, so it runs on Cloudflare Workers as well as Node.
 */
export class MuseTranscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private queue: Buffer[] = [];
  private queuedBytes = 0;

  constructor(private encoding: "PCM_16KHZ" | "PCM_24KHZ", private keywords: string[] = []) {
    super();
  }

  private get bytesPerMs() {
    return this.encoding === "PCM_24KHZ" ? 48 : 32;
  }

  connect() {
    this.ready = false;
    const ws = new WebSocket(config.museSttUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      // Auth travels in the handshake frame; Muse ignores the HTTP Authorization header.
      ws.send(
        JSON.stringify({
          authorization: { accessToken: `Bearer ${config.museApiKey}` },
          model: "muse-voice-transcribe-1.0",
          audioEncoding: this.encoding,
          mode: "ENDPOINTING",
          partialMode: "CUMULATIVE",
          emitAudioProgress: false,
          ...(this.keywords.length ? { keywords: this.keywords } : {}),
        }),
      );
    });

    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data);
      if (!msg.type && msg.sessionId) {
        // Handshake ack: now audio may flow.
        this.ready = true;
        for (const chunk of this.queue.splice(0)) ws.send(chunk);
        this.queuedBytes = 0;
        return;
      }
      switch (msg.type) {
        case "transcript":
          if (!msg.final && msg.transcript) this.emit("partial", msg.transcript as string);
          break;
        case "speechStart":
          this.emit("speechStart");
          break;
        case "speechEnd":
          this.emit("speechEnd");
          break;
        case "speechComplete":
          if (msg.transcript?.trim()) this.emit("final", msg.transcript.trim() as string, msg.turnId as number);
          break;
        case "error":
          this.emit("error", new Error(`[muse] ${msg.message}`));
          break;
      }
    });

    ws.addEventListener("error", () => this.emit("error", new Error("[muse] socket error")));

    ws.addEventListener("close", ({ code, reason }) => {
      this.ready = false;
      if (this.closed) return;
      // 1008 = bad config/pacing: retrying the same way fails again.
      if (code === 1008) {
        this.emit("error", new Error(`[muse] closed 1008: ${reason}`));
        return;
      }
      // 1011 (incl. max session duration) / 1013 (rate limit): new session after a short backoff.
      const delay = code === 1013 ? 2000 : 250;
      console.warn(`[muse] closed (${code}), reconnecting in ${delay}ms`);
      setTimeout(() => !this.closed && this.connect(), delay);
    });
  }

  /** PCM16 mono little-endian at the configured rate. */
  sendAudio(pcm: Buffer) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
      return;
    }
    // Before the handshake ack: buffer, dropping the oldest audio past the backlog limit.
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
    while (this.queuedBytes > MAX_BACKLOG_MS * this.bytesPerMs && this.queue.length) {
      this.queuedBytes -= this.queue.shift()!.length;
    }
  }

  close() {
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "endStream" }));
      setTimeout(() => this.ws?.close(), 1000);
    } else {
      this.ws?.close();
    }
  }
}
