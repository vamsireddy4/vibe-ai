// Meta provider: services/voice-agent (Meta Muse Voice Transcribe for speech-to-text).
// Meta's Model API has no text-to-speech, so the voice is Deepgram Aura.
export const DEFAULT_META_MODEL = "muse-spark-1.3";
export const DEFAULT_META_VOICE = "aura-asteria-en";
export const META_MODELS = [
  { value: "muse-spark-1.3", label: "Muse Spark 1.3" },
  { value: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 (Contributor mode)" },
];
export const META_VOICES = [
  { value: "aura-asteria-en", label: "Asteria (Deepgram Aura, English). Meta has no hosted voice model" },
];
