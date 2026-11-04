# Vibe AI

Local development:

```sh
npm install
npm run dev
```

Environment:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_GEMINI_API_KEY`
- `ULTRAVOX_API_KEY`
- `GEMINI_API_KEY`
- `SARVAM_API_KEY`

Stack:

- Vite
- React
- TypeScript
- Tailwind CSS
- Supabase
- Gemini

Prototype services:

- `services/pipecat-sarvam` contains an isolated Pipecat + Sarvam voice-agent prototype used for latency experiments without changing the live call path.
