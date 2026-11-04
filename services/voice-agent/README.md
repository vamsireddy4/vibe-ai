# voice-agent

Low-latency voice pipeline: Meta `muse-voice-transcribe-1.0` (STT) → Groq `llama-3.1-8b-instant` (LLM) → Deepgram Aura (TTS), over WebSockets.

```sh
cp .env.example .env   # fill in MUSE_API_KEY, GROQ_API_KEY, DEEPGRAM_API_KEY
npm install
npm run dev            # ws://localhost:8787/ws/call
npm run check          # chunker + mu-law self-check, no keys needed
```

## Endpoint `/ws/call`

| `?codec=` | Caller → server | Server → caller |
|---|---|---|
| `browser` (default) | binary PCM16 mono **24 kHz** | binary PCM16 24 kHz, plus JSON text: `partial`, `final`, `reply`, `latency`, `clear` |
| `twilio` | Twilio Media Streams JSON (mu-law 8 kHz) | Twilio `media` + `clear` events |

Browser clients must keep sending audio (silence included) the whole call; Muse closes a stream that goes quiet.
On a `{"type":"clear"}` event, stop playback and drop buffered audio (barge-in).

## Per turn

1. Muse (ENDPOINTING mode) emits partials and a `speechComplete` final. Muse decides end of speech on the server, so the ~250 ms silence threshold can't be set from here.
2. On the final transcript, Groq (`GROQ_MODEL`, default `qwen/qwen3.8-27b` with reasoning off) streams the reply. The first 3 complete words go to Deepgram right away; after that each phrase (punctuation + ≥15 chars). Every chunk is sent as `Speak` + `Flush`. The Groq connection is pre-warmed on connect, when the user starts talking, and after a barge-in.
3. Deepgram audio is forwarded to the caller as-is (no transcoding).
4. Barge-in: a partial of 3+ words while the agent is talking (or its audio is still playing) aborts Groq, sends Deepgram `Clear`, and tells the caller to clear.

Logs per turn: `llm TTFT`, `first audio byte … after final transcript`, `turn audio complete`.
