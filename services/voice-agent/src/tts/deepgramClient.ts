import { EventEmitter } from "node:events";
import { config } from "../config.js";

/**
 * Persistent Deepgram Aura WebSocket. Open it when the call connects so the TLS
 * handshake is paid before the user speaks.
 * Events: "audio" (Buffer), "flushed", "cleared", "error".
 * Standard WebSocket API (auth via the "token" subprotocol, since it can't set headers), so it runs on
 * Cloudflare Workers as well as Node. No protocol pings there: an idle socket that closes just reconnects.
 */
export class DeepgramTTS extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private retries = 0;
  private pending: string[] = [];
  // After Clear, Deepgram can still deliver in-flight audio; drop it until "Cleared".
  private clearing = false;

  constructor(private encoding: string, private sampleRate: number, private voice: string = config.ttsModel) {
    super();
  }

  connect() {
    const url = `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(this.voice)}&encoding=${this.encoding}&sample_rate=${this.sampleRate}`;
    const ws = new WebSocket(url, ["token", config.deepgramApiKey]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retries = 0;
      for (const msg of this.pending.splice(0)) ws.send(msg);
    });

    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        if (!this.clearing) this.emit("audio", Buffer.from(e.data as ArrayBuffer));
        return;
      }
      const msg = JSON.parse(e.data);
      if (msg.type === "Flushed") this.emit("flushed");
      else if (msg.type === "Cleared") {
        this.clearing = false;
        this.emit("cleared");
      } else if (msg.type === "Warning" || msg.type === "Error") console.warn("[deepgram]", msg);
    });

    ws.addEventListener("error", () => this.emit("error", new Error("[deepgram] socket error")));

    ws.addEventListener("close", ({ code }) => {
      if (this.closed) return;
      // Never opened = rejected handshake (bad key): retrying won't help.
      if (code === 1006 && this.retries >= 5) return void (this.closed = true);
      // Reconnect with backoff: 250ms, 500ms, ... capped at 5s.
      const delay = Math.min(250 * 2 ** this.retries++, 5000);
      console.warn(`[deepgram] closed (${code}), reconnecting in ${delay}ms`);
      setTimeout(() => !this.closed && this.connect(), delay);
    });
  }

  private send(msg: object) {
    const text = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.pending.push(text);
  }

  speak(text: string) {
    this.clearing = false;
    this.send({ type: "Speak", text });
  }

  flush() {
    this.send({ type: "Flush" });
  }

  clear() {
    this.clearing = true;
    this.pending = this.pending.filter((m) => !m.includes('"Speak"') && !m.includes('"Flush"'));
    this.send({ type: "Clear" });
  }

  close() {
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Close" }));
    this.ws?.close();
  }
}
