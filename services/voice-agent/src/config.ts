// Read lazily: on Cloudflare, process.env is filled from the Worker's secrets (nodejs_compat).
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  get museApiKey() { return required("MUSE_API_KEY"); },
  get museSttUrl() { return process.env.MUSE_STT_URL ?? "wss://api.meta.ai/v1/asr/realtime"; },
  get deepgramApiKey() { return required("DEEPGRAM_API_KEY"); },
  defaultModel: "muse-spark-1.3", // Meta models only
  ttsModel: "aura-asteria-en",
};

export type Codec = "twilio" | "browser";

// What the caller sends us / what Deepgram sends back to the caller.
// Muse only accepts PCM16 at 16 or 24 kHz, so Twilio's 8 kHz mu-law is converted before STT.
export const audioFormats = {
  twilio: { ttsEncoding: "mulaw", ttsSampleRate: 8000, ttsBytesPerSecond: 8000, sttEncoding: "PCM_16KHZ" },
  browser: { ttsEncoding: "linear16", ttsSampleRate: 24000, ttsBytesPerSecond: 48000, sttEncoding: "PCM_24KHZ" },
} as const;

export const SYSTEM_PROMPT =
  "You are a fast, helpful voice assistant on a live phone call. Respond in 1 to 2 short, natural conversational sentences. Never use markdown, bullet points, asterisks, emojis, or numbered lists. Write numbers and abbreviations in spoken words.";
