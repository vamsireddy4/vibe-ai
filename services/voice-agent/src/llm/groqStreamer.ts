import { config, SYSTEM_PROMPT } from "../config.js";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Tools the agent may call mid-call (e.g. booking). `run` returns the text result the model reads back. */
export type AgentTools = { defs: object[]; prompt: string; run: (name: string, args: any) => Promise<string> };

const PUNCTUATION = /[.,!?;:—]/;
const FIRST_CHUNK_MIN_WORDS = 3;
const MIN_PHRASE_CHARS = 15;
const MAX_TURNS = 10;

/**
 * Two-stage chunker. Returns [phrase, rest] to speak now, or null to keep buffering.
 * - First chunk of a turn: as soon as 3 complete words exist (no punctuation needed),
 *   so Deepgram can start synthesizing immediately.
 * - Later chunks: up to the last punctuation mark, once that is >= 15 chars (natural prosody).
 */
export function takePhrase(buffer: string, isFirstChunk: boolean): [string, string] | null {
  if (isFirstChunk) {
    // A word is complete once whitespace or punctuation follows it; Groq tokens usually
    // start with a space, so the last word in the buffer may still be growing.
    const cut = Math.max(buffer.search(/\s\S*$/), lastPunctuation(buffer) + 1);
    const complete = buffer.slice(0, cut);
    if (cut > 0 && complete.trim().split(/\s+/).length >= FIRST_CHUNK_MIN_WORDS) {
      return [complete.trim(), buffer.slice(cut)];
    }
    // Short answers ("Sure, four.") still go out at their punctuation.
  }
  const i = lastPunctuation(buffer);
  if (i < 0) return null;
  const phrase = buffer.slice(0, i + 1).trim();
  return phrase.length >= MIN_PHRASE_CHARS ? [phrase, buffer.slice(i + 1)] : null;
}

function lastPunctuation(buffer: string): number {
  for (let i = buffer.length - 1; i >= 0; i--) if (PUNCTUATION.test(buffer[i])) return i;
  return -1;
}

/** Meta Muse models, served by the Meta Model API instead of Groq. */
export const META_CHAT_MODELS = ["muse-spark-1.3", "muse-spark-1.3-contributor"];

/** The caller picks the model; anything that isn't a Meta chat model falls back to the default. */
export const resolveModel = (requested: unknown) => (typeof requested === "string" && META_CHAT_MODELS.includes(requested) ? requested : config.defaultModel);

/** Stream content tokens from Meta's OpenAI-compatible chat endpoint (SSE). */
export type MuseUsage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };

export async function* museTokens(body: object, signal: AbortSignal, onUsage?: (u: MuseUsage) => void, onToolCalls?: (calls: ToolCall[]) => void): AsyncGenerator<string> {
  const calls: ToolCall[] = []; // streamed in pieces: id/name first, then the arguments JSON in fragments
  const res = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.museApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Muse ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let pending = ""; // SSE lines can be split across network chunks
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.usage) onUsage?.(chunk.usage); // last chunk when stream_options.include_usage is set
      for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) yield token;
    }
  }
  if (calls.length) onToolCalls?.(calls.filter(Boolean));
}

/** One call's conversation with Muse Spark (the class name predates the move off Groq). */
export class GroqStreamer {
  private history: Message[] = [];
  private lastWarm = 0;

  private systemPrompt: string;

  /** agentPrompt: the agent's own instructions; the spoken-style rules (and any tool rules) are always appended. */
  constructor(readonly model: string = config.defaultModel, agentPrompt?: string, private tools?: AgentTools) {
    const base = agentPrompt?.trim() ? `${agentPrompt.trim()}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT;
    this.systemPrompt = tools ? `${base}\n\n${tools.prompt}` : base;
  }

  get hasTools() {
    return Boolean(this.tools);
  }

  /** Sliding window of the last turns, never starting on an orphaned tool result. */
  private window(messages: Message[]) {
    const w = messages.slice(-MAX_TURNS * 3);
    while (w.length && w[0].role !== "user") w.shift();
    return w;
  }

  /**
   * Open/refresh the TLS connection to Meta without spending tokens, so the first
   * completion of a turn doesn't pay the handshake. Call on connect and when the user starts talking.
   */
  warm() {
    // Throttled, and the body is cancelled: on Cloudflare an unread response keeps its connection open, and a
    // call may only hold 6 at once (STT + TTS + model already use 3), so leaked warm-ups cut the call.
    if (Date.now() - this.lastWarm < 15_000) return;
    this.lastWarm = Date.now();
    fetch("https://api.meta.ai/v1/models", { headers: { Authorization: `Bearer ${config.museApiKey}` } }).then((r) => r.body?.cancel(), () => {});
  }

  /** Token stream for a reply to `userText`, without touching the history (used for drafts and replies). */
  tokens(userText: string, signal: AbortSignal, onToolCalls?: (calls: ToolCall[]) => void, history?: Message[]): AsyncGenerator<string> {
    const messages = history ?? this.window([...this.history, { role: "user" as const, content: userText }]);
    return museTokens(
      {
        model: this.model,
        messages: [{ role: "system" as const, content: this.systemPrompt }, ...messages],
        ...(this.tools ? { tools: this.tools.defs } : {}),
        stream: true,
        temperature: 0.5,
        // Muse Spark always reasons a little ("minimal" is its lowest level; it rejects "none"); those tokens count too.
        max_tokens: 600,
        reasoning_effort: "minimal",
        stream_options: { include_usage: true },
      },
      signal,
      (u) => {
        // Billing check: logged per turn (tokens drive Muse Spark cost).
        console.log(`[usage] muse prompt=${u.prompt_tokens} cached=${u.prompt_tokens_details?.cached_tokens ?? 0} output=${u.completion_tokens} reasoning=${u.completion_tokens_details?.reasoning_tokens ?? 0}`);
      },
      onToolCalls,
    );
  }

  /**
   * Stream a reply to `userText`, calling onPhrase for each speakable chunk as soon as
   * it is ready. Resolves with the full reply (or what was produced before abort).
   * `draft`: tokens already generated while the user was still talking (see VoiceSession).
   */
  async reply(
    userText: string,
    signal: AbortSignal,
    onPhrase: (phrase: string) => void,
    onFirstToken: () => void,
    draft?: AsyncIterable<string>,
  ): Promise<{ text: string; aborted: boolean }> {
    this.history.push({ role: "user", content: userText });
    this.history = this.window(this.history);

    let full = "";
    let buffer = "";
    let isFirstChunk = true;
    let aborted = false;

    try {
      // Up to 3 rounds: the model may call a tool (e.g. book_appointment), read its result, then speak again.
      for (let round = 0; round < 3; round++) {
        let calls: ToolCall[] = [];
        let roundText = "";
        if (round > 0 && full && !/\s$/.test(full)) { full += " "; buffer += " "; } // "...book that." + "Done" -> two sentences
        const tokens = round === 0 && draft ? draft : this.tokens(userText, signal, (c) => (calls = c), this.window(this.history));
        for await (const token of tokens) {
          if (!token) continue;
          if (!full) onFirstToken();
          full += token;
          roundText += token;
          buffer += token;
          const split = takePhrase(buffer, isFirstChunk);
          if (split) {
            onPhrase(split[0]);
            buffer = split[1];
            isFirstChunk = false;
          }
        }
        if (!calls.length || !this.tools) {
          if (roundText.trim()) this.history.push({ role: "assistant", content: roundText.trim() });
          break;
        }
        this.history.push({ role: "assistant", content: roundText.trim() || null, tool_calls: calls });
        for (const c of calls) {
          let args: any = {};
          try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* model sent bad JSON: the tool reports it */ }
          const result = await this.tools.run(c.function.name, args).catch((e: Error) => `Error: ${e.message}`);
          console.log(`[tool] ${c.function.name} -> ${result.slice(0, 160)}`);
          this.history.push({ role: "tool", tool_call_id: c.id, content: result });
        }
        if (signal.aborted) break;
      }
      if (buffer.trim()) onPhrase(buffer.trim());
    } catch (err) {
      if (!signal.aborted) throw err;
      aborted = true;
      // Remember what the agent actually started saying, even if interrupted.
      const last = this.history[this.history.length - 1];
      if (full.trim() && last?.role === "user") this.history.push({ role: "assistant", content: full.trim() });
    }

    return { text: full, aborted };
  }
}
