<p align="center">
  <img src="https://res.cloudinary.com/dj9ecbykc/image/upload/e_trim/v1793716012/Vibe_AI_Minimalist_Logo_kbzcfe.png" alt="Vibe AI" width="260">
</p>

<p align="center">
  <strong>AI voice agents that call, answer, book and follow up for your business.</strong><br>
  Powered by Meta Muse Spark. Live at <a href="https://vibe-ai-911.pages.dev">vibe-ai-911.pages.dev</a>.
</p>

---

## What Vibe AI is

Vibe AI lets a business create AI phone agents in minutes. An agent has a voice, a personality (its prompt), your company's knowledge and a set of tools. It can then:

- **Call people:** one number at a time, or a whole list as a campaign.
- **Hold a real conversation:** it listens, answers questions from your knowledge base, and speaks naturally.
- **Do the work during the call:** book an appointment on your calendar, look up or save a record in your CRM, call your own API, or transfer the caller to a person.
- **Report back:** every call is saved with its recording, transcript and an AI summary, and can trigger your webhooks.

Calls, SMS, WhatsApp and email all run from one workspace, and **Ask Vibe**, the built-in assistant, can find anything or do a task for you ("create an agent for my dental clinic", "call +91… with the booking agent", "which voice does my support agent use?").

## Features

| Area | What you can do |
|---|---|
| **Agents** | Create agents with a prompt (or "Generate with AI"), language, first speaker, temperature, max call length and a phone number. |
| **Voices** | Browse 100+ voices, filter by language, accent and gender, play samples, and pick one for each agent. |
| **Calls** | Outbound calls over Twilio or Telnyx, plus browser **Demo Calls** to test an agent with your microphone. |
| **Campaigns** | Voice, email, SMS and WhatsApp campaigns: clean a CSV with AI, run the campaign, track outcomes, retry the missed contacts. |
| **Front** | One composer to send an SMS, WhatsApp message or email, or place a call, to one person or a whole campaign. |
| **Knowledge Base** | Add files, website URLs or text. The agent reads them on every call. |
| **Tools** | Appointment booking (Google Calendar or Cal.com), custom HTTP tools (e.g. n8n), CRM apps through Composio, and call forwarding to people. |
| **History** | Every call, SMS, WhatsApp message and email, with recordings, transcripts and AI call summaries. |
| **Webhooks** | Signed `call.ended` events to your own URL (HMAC-SHA256). |
| **Ask Vibe** | A chat assistant that knows your account and can drive the app for you, asking before it presses anything that sends, calls or deletes. |

## Meta models

All AI in Vibe AI runs on Meta's models through the Meta Model API.

| Model | Used for |
|---|---|
| `muse-spark-1.3` / `muse-spark-1.3-contributor` | The agent's brain on calls, Ask Vibe, prompt writing, call summaries, CSV and knowledge extraction |
| Muse Voice Transcribe (realtime) | Speech-to-text during calls |
| `sam-3.1` | Ask Vibe reading the screen to find buttons |

Voices (text-to-speech) come from Deepgram Aura.

## How it works

```
Browser (React app on Cloudflare Pages)
   │  Clerk sign-in
   ├── /fn/*            Pages Functions: the app's server actions (Supabase edge functions ported to Cloudflare)
   ├── /voice-agent/*   Pages Function proxy (checks the Clerk session) ─┐
   └── Supabase         Postgres with row-level security on the Clerk user │
                                                                           ▼
                            vibe-voice Cloudflare Worker (Durable Objects)
                            ├── CallRoom      one live call: Twilio/Telnyx media ⇄ Muse STT → Muse Spark → TTS
                            ├── CampaignRun   dials a campaign's contacts one by one
                            └── /ask/*        Ask Vibe, analysis, prompt writer (Muse Spark, SAM 3.1)
```

During a call, the agent's tools (booking, custom HTTP tools, CRM apps, transfer) and its knowledge are loaded for that agent only. When the call ends it is saved to History and your webhooks fire.

## Project layout

```
src/                     React app (Vite, TypeScript, Tailwind, shadcn/ui)
  pages/                 one file per page (Agents, Voices, Campaigns, Front, History, ...)
  components/            shared UI, Ask Vibe, Profile window, agent tabs, campaign tabs
  lib/                   app logic (Ask Vibe tasks, Muse analysis, CSV parsing, call placing, ...)
functions/               Cloudflare Pages Functions (server side of the website)
server/                  server code shared by the Pages Functions (Composio, edge-function shim)
services/voice-agent/    the vibe-voice Worker: live calls, campaigns, Ask Vibe
supabase/                SQL schema, policies and the edge functions ported to /fn
scripts/build-edge.mjs   ports the reviewed Supabase edge functions to Cloudflare at build time
```

## Run it locally

Requirements: Node 20+, a Supabase project, a Clerk app, and a Meta Model API key.

```sh
npm install
npm run dev                      # website on http://localhost:5173

cd services/voice-agent
npm install
npm run dev                      # voice agent on http://localhost:8787
```

### Environment

Website (`.env`, never committed):

```
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_PROJECT_ID=
VITE_CLERK_PUBLISHABLE_KEY=
VITE_VOICE_AGENT_URL=            # optional; defaults to /voice-agent on the same site
VITE_ADMIN_EMAIL=
```

Server secrets (Cloudflare Pages and Worker secrets, or `services/voice-agent/.dev.vars` locally; never `VITE_`):

```
MUSE_API_KEY=                    # Meta Model API
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CLERK_SECRET_KEY=
AGENT_PROXY_KEY=                 # shared by the Pages proxy and the Worker
DEEPGRAM_API_KEY=                # voices
COMPOSIO_API_KEY=                # Gmail, Google Calendar and CRM apps
PUBLIC_URL=                      # the Worker's public URL, for Twilio/Telnyx callbacks
```

## Checks

```sh
npx tsc --noEmit -p tsconfig.app.json     # type check
npm test                                  # unit tests (vitest)
npm run lint
cd services/voice-agent && npm run check  # voice agent self-check
```

## Deploy

```sh
npm run build && npx wrangler pages deploy dist --project-name vibe-ai --branch main
cd services/voice-agent && npx wrangler deploy
```

## Security

- Every page except the landing page needs a Clerk sign-in, and every server route checks it.
- Supabase row-level security keeps each user's agents, calls and contacts to themselves.
- API keys stay on the server. The browser and the Ask Vibe model never see them.
- Twilio callbacks are signature-checked, and webhooks are signed.
- Ask Vibe never presses pay, buy, checkout or sign-out, and asks before anything that sends, calls or deletes.
