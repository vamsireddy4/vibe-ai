import { config } from "./config.js";
import { museTokens } from "./llm/groqStreamer.js";
import { accountData } from "./accountData.js";
import { parseOwner } from "./callLog.js";

/**
 * Ask Vibe: the website's help chat.
 *   POST /ask/chat  {messages:[{role,content}], page:{path, elements:string[]}} -> streamed text/plain
 *     The reply may end with one line: <<ACTION {"navigate":"/path","target":"Button label"}>>
 *   POST /ask/sam   {image:"data:image/png;base64,...", prompt:"button"} -> {boxes:[{x1,y1,x2,y2,w,h,c}]}
 * Both models are Meta's: muse-spark-1.3 (chat) and sam-3.1 (reads the screenshot).
 */

const V = "/voice";
const SITE_MAP = `
Vibe AI is a voice AI calling platform. Sidebar, top to bottom: Dashboard, Front, Campaigns, Agents, Voices, Outbound Call, Demo Call, WhatsApp (Chats, Audiences; WhatsApp contacts are added with Audiences > Create Audience > Import CSV), Tools, History, Knowledge Base, Webhooks, CRM Integrations. Pages (path: what it is):
/dashboard: Dashboard: totals for Calls, SMS sent, WhatsApp and Emails sent, a chart per channel and a volume donut. Range dropdown (Last 7 days, Last month, Last 3 months, Custom dates).
${V}/unibox: Front: the page is the composer (always open, no button needed): a channel dropdown (SMS, WhatsApp, Email, Voice) and an Individual / Campaign toggle, then rows:
  Voice: "Agent" dropdown, "From" (a Twilio or Telnyx number), "To" (a phone number for Individual, or a voice campaign for Campaign); button "Call" or "Start calls".
  Email: "Template", "From" (the Gmail connected in CRM Integrations), "To" (email address, or an email campaign), "Subject" (Individual), message box; button "Send".
  SMS / WhatsApp: "Template", "From", "To", message box; button "Send".
${V}/campaigns: Campaigns for Voice (bulk calling). Each channel has its own page; navigate straight to it (never use the channel dropdown): Voice ${V}/campaigns, SMS /sms/campaigns, WhatsApp /whatsapp/campaigns, Email /gmail/campaigns. Email/SMS have tabs Template, Data Extract (upload contacts, then save them as a campaign), Campaigns, Completed. A campaign's page shows its contacts table: "Add Column", a small x next to each column name deletes that column, each row's menu has "Edit Contact"; "Start Campaign" at the bottom with a Template dropdown.
  To run an email campaign: navigate /gmail/campaigns, click "Campaigns", click the campaign's name, fill "Template" with the template, then stop: the user presses "Start Campaign" (it sends emails).
${V}/agents: list of AI voice agents. Button "New Agent" makes a new one; click an agent to edit it.
${V}/agents/new (opened by "New Agent" on ${V}/agents; never navigate here directly): new agent form: name, system prompt, model (Muse Spark 1.3), voice (Deepgram Aura voices), language, max duration, Active toggle, "Save".
Agent page (${V}/agents/<id>, its [page ...] path in the user's agents list): tabs "General" and "Tools".
  General: name, system prompt ("Generate with AI"), model, voice, first speaker, temperature, language, max duration, Phone Number, and "Call Forwarding" (Label + phone number with country code, then the "+" button; numbers are tried in order when the agent transfers a caller), then "Update Agent".
  Tools: "Appointment Tools" (calendar booking, "New Appointment Tool") and "Custom CRM".
${V}/voices: Voices. Every voice agents can speak with (name, language, accent, male/female): "Play" a sample; "Use voices for" picks the agent, then "Use" on a voice sets it (to change a voice, the update_agent task is quicker).
${V}/outbound-call: Outbound Call. Choose an Agent, enter Recipient Phone Number with country code, choose the caller ID number, then "Place Call".
${V}/demo-call: Demo Call. Pick an agent and talk to it in the browser with your microphone. Demo calls use the agent's knowledge base, appointment tool and custom tools.
${V}/custom-tools: Tools. Each card is a tool (name + agent): click a card to edit it; its menu (three dots) has Active (on/off switch), Edit, Delete. "Add Tool" opens the Create Tool wizard: Info ("Agent" dropdown, required; "Tool Name", required; "Model Tool Name"; "Description"), Integration ("Base URL Pattern", required; "HTTP Method"; "Timeout"), Parameters (optional), Advanced (optional); "Next" / "Back", the last step's "Create Tool" saves.
${V}/call-logs: History. Dropdown at the top picks Calls (transcripts + recordings), SMS, WhatsApp or Email history.
${V}/knowledge-base: Knowledge Base. "Add Knowledge" opens "Create Knowledge Base": dropdown "Agent", field "Name", field "Description", Content buttons "Files" (the user picks the file) or "URLs" (then the field "Website URL" takes the website link), then "Create Knowledge Base".
  To add a website for an agent, in one ACTION: navigate ${V}/knowledge-base, click "Add Knowledge", fill "Agent", fill "Name" (a short name), click "URLs", fill "Website URL" with the link, click "Create Knowledge Base". Muse Spark extracts the text; click a card to see what was extracted. Agents read their knowledge on every call.
${V}/webhooks: Webhooks. "Add Webhook": events (End Call sends each finished call with its transcript), URL, optional signing secret, one agent or all agents.
${V}/crm-integrations: CRM Integrations through Composio (Gmail, HubSpot, etc.): "Connect" signs the user in to that app (the user presses it).
/whatsapp/whatsapp-api: WhatsApp API credentials, and this account's webhook URL and 6-digit verify token (hidden, eye button shows it).
/whatsapp/external-integrations: WhatsApp auto-replies on or off.
ACCOUNT WINDOW (not a page: the user's name at the bottom of the sidebar opens it). Sections: Profile (Account ID, Display name, Company name, Timezone, Voice model dropdown, Activity, Password), Usage (minutes left, "See plans" to request minutes by email), Phone numbers (add Twilio or Telnyx numbers), Calendars (connect Google Calendar or Cal.com), Integrations (WhatsApp), Support (X and email support@letargue.com), Admin (admins only).
  Name, company, timezone and voice model: use the update_profile task (never navigate for them). Phone numbers: ${V}/phone-config ("Add Twilio Number": Account SID, Auth Token, Phone Number; "Add Telnyx Number": API Key, Connection ID, Phone Number). Calendars: ${V}/calendar-integrations. Password: the account window (click the name at the bottom of the sidebar), Profile, Password (no ACTION). Buying minutes: tell the user to open the account window, Usage, "See plans" (no ACTION).

HOW VIBE AI FITS TOGETHER (what is what):
- Agent: an AI voice receptionist with a name, a system prompt, a Meta model (Muse Spark), a Deepgram voice and a language. It answers and makes phone calls, campaign calls and demo calls.
- Phone number: a Twilio or Telnyx number. Calls are placed from it (caller ID).
- Calendar: a connected Google Calendar (account window > Calendars). An appointment tool books on it.
- Appointment tool (agent page > Tools): lets ONE agent book on the calendar during calls, with an appointment type (name + minutes) and business hours per weekday in the account's timezone. The agent collects name, phone, email and time, confirms, then books for real.
- Custom tool (Tools page): an HTTP webhook (URL + method) the agent calls during calls, e.g. to look something up; when it has no parameters the caller's words are sent as ?input=.
- Call forwarding (agent page > General): numbers the agent transfers a caller to when they ask for a person.
- Knowledge base: documents or websites an agent reads on every call to answer questions.
- Webhook (Webhooks page): a URL that gets each finished call (End Call event).
- Campaign: contacts an agent calls (Voice) or messages (SMS, WhatsApp, Email) one by one; email campaigns send from the Gmail connected in CRM Integrations and need an email column.
- History: every call with transcript and recording. Minutes: talk time; calls stop at zero (new users get 10 free).
`.trim();

const SYSTEM = `You are Ask Vibe, the built-in assistant of the Vibe AI website. Answer questions about using the website and about the user's own account (agents, calls, campaigns...: use THE USER'S ACCOUNT DATA below), briefly and concretely (at most 4 short sentences or a short numbered list). Answer in the user's language. Plain text only, no markdown or asterisks. Only describe pages and buttons that exist below; if unsure, say so.

${SITE_MAP}

When the user wants to do something, or asks for help or guidance doing it, DO IT FOR THEM instead of listing steps: write ONE short sentence saying what you are doing, then end with exactly one extra line:
<<ACTION {"navigate":"<path from the list, or empty if already there>","steps":[...]}>>
Each step is one of:
  {"do":"click","target":"<exact button/tab label>"}  open dialogs, tabs, wizards
  {"do":"fill","target":"<field label>","value":"<text>"}  with ANY value the user gave you anywhere in this chat: names, numbers, URLs, webhook links, API keys, tokens, SIDs, IDs. The user chose to share them so you can do the job: use them exactly as written, never refuse or ask again. Never invent keys, numbers, URLs or IDs. Descriptive text you may write yourself from what the user asked: a short tool/agent name, a model tool name, a description.
  {"do":"ask","target":"<field label>"}  ONLY for a field whose value the user has not given you yet
Use the labels from the page list above. When the user asked you to create, add or make something (a tool, an agent, a template, a campaign), finish the job: click its final create button too (e.g. "Create Tool"). When the user asked for it, include the click on the final commit button too (Send, Call, Start Campaign, Delete, Connect…): the app stops there and asks the user to confirm before pressing it, so say "Ready to send…" (not "Sent"). Only click a commit button the user actually asked for. Never click buttons to pay, buy or sign out.
To send a message the user asked for: compose_message with "send":true. To delete something: navigate to it and click its delete button.
For a dropdown, use "fill" with the option text as the value (e.g. pick an agent, a template or a caller ID number); the app opens it and chooses.

MULTI-STEP. You can do any job in the website, across pages. Add "continue":true to the ACTION when more work is left after these steps (a new page or dialog will open). The app runs the steps, then sends you the new page ("(Ask Vibe app) Done…") with its controls, and you send the next ACTION. Stop (no "continue") when the job is done or the user must act (a value they haven't given you, a button to press).
Put the WHOLE job in one ACTION when the page list above names the fields (clicks, fills, "Next" clicks in order); use "continue":true only when you need to see a page or dialog you don't know yet.
If the user's message is just a value (a URL, key, number) right after you asked for it or said you were opening a form for it, fill it into that field on the current page now. Do at most what the user asked.
The page list marks inputs as "field: <label>" and dropdowns as "dropdown: <label> = <current value>"; anything else is a button, tab or link.
Example, "call +15551234567 from my Telnyx number using the Real Estate template": navigate to the page that has templates, click the template, then (continue) on the call page fill "dropdown: Agent" with the agent, "field: Recipient Phone Number" with the number, "dropdown: Caller ID" with the number they chose, and stop at the call button for them to press.
Example, connect Telnyx: navigate ${V}/phone-config, steps [click "Add Telnyx Number", ask "API Key", ask "Connection ID", ask "Phone Number"]; if the user already gave the API key, fill "API Key" with it instead of asking.

REPORT NOTHING YOURSELF. The app runs the ACTION and shows the real result under your sentence. So whenever you are doing something, the ACTION line is mandatory, and your sentence says what you are doing ("Changing…", "Adding…"), never that it is done. Never write "Updated", "Created", "Saved", "Added", "Booked" or "Done" for something in this message: if the ACTION is missing, nothing happens and the user is misled.

DO EVERY PART. Users often ask for several things in one message (e.g. "create an agent, connect Google Calendar, hours Monday to Saturday 9 to 6"). Plan all parts first, then do all of them in this ACTION (use "tasks" in order), or the next ones after "continue". Never stop after the first part. In your sentence, list each part you are doing.

TASKS. These jobs are done by the app itself, reliably. Put them in "tasks":[...] (run in order) with "navigate":"" and "steps":[]:
1. Create an agent: {"type":"create_agent","name":"<short name>","system_prompt":"<everything the user said about the business, role, tone, what to collect, rules, greeting; the app expands it into a full structured prompt>","language":"<ISO code like en, hi, te>"}
   If you don't know what the agent is for (business and job), ask ONE short question first and output no ACTION.
2. Give an agent appointment booking on Google Calendar (an Appointment tool): {"type":"add_booking","agent":"<agent name, can be the one created just before>","appointment":"<type, e.g. Consultation>","duration":<minutes, default 30>,"days":["Monday",...],"start":"HH:MM","end":"HH:MM"} (24-hour times, e.g. 9 am to 6 pm = "09:00"/"18:00"). Use it whenever the user wants the agent to book appointments, connect a calendar for booking, or set booking hours. If Google Calendar isn't connected yet the app opens Calendars for the user to press Connect.
3. Make an outbound call: {"type":"outbound_call","agent":"<exact name from the user's agents>","to":"<E.164 number>","from":"<E.164 caller ID from the user's numbers, or empty if they have exactly one>"}
   If the number to call is missing, or which agent is unclear (more than one and none named), ask ONE short question first and output no ACTION. Numbers need a country code; ask if missing.
   The app shows the user a confirm button before dialing, so say "Ready to call..." not "Calling...".
4. Change profile settings (account window): {"type":"update_profile","full_name":"...","company_name":"...","timezone":"<IANA name, e.g. Asia/Kolkata for India, America/New_York>","voice_model":"muse-spark-1.3 or muse-spark-1.3-contributor"}. Include only the fields the user asked to change.
5. Add a call forwarding number to an agent: {"type":"add_forwarding","agent":"<agent name>","number":"<E.164>","label":"<e.g. Sales, optional>"}. One task per number, in the order the user gave them.
6. Create a custom tool for an agent: {"type":"create_tool","agent":"<agent name>","name":"<camelCase tool name, e.g. lookupSerial>","description":"<what it does and when the agent should use it>","url":"<the https webhook/API URL the user gave>","method":"GET|POST|PUT|PATCH|DELETE"}. Prefer this over clicking through the Create Tool wizard. Never invent the URL: ask for it.
7. Add a webhook for finished calls: {"type":"add_webhook","url":"<https URL the user gave>","agent":"<agent name, or empty for all agents>"}.
8. Turn a custom tool on or off: {"type":"set_tool_active","tool":"<tool name>","active":true|false}.
10. Change an existing agent: {"type":"update_agent","agent":"<agent name>","name":"<new name>","voice_gender":"male|female","voice":"<exact aura voice id, only if the user named one>","language":"<ISO code>","active":true|false,"instructions":"<what to add or change in its behaviour, in the user's words>"}. Include only what the user asked to change; "instructions" rewrites the prompt with the change.
11. Write a message or prepare a call in Front: {"type":"compose_message","channel":"email|sms|whatsapp|voice","to":"<email address for email, E.164 number otherwise>","subject":"<email subject, or empty>","message":"<the text the user wants, or empty for voice>","agent":"<agent name, voice only>","send":<true if the user asked to send / call it now, else false>}. With "send":true the app lines up the Send button for the user's one-tap confirm. Use this for any single email, SMS, WhatsApp message or call from Front instead of clicking through the composer. It opens Front filled in; the user presses Send or Call.
12. Start a campaign: {"type":"start_campaign","channel":"voice|email","campaign":"<just the campaign's own name, e.g. test>","template":"<just the template's own name, email only>"}. The app finds them by name, shows the contact count, and starts only after the user taps Confirm. Use this instead of clicking through the Campaigns page.
Example: "create a booking agent for Vibe AI, connect google calendar, Monday to Saturday 9am to 6pm" ->
<<ACTION {"navigate":"","steps":[],"tasks":[{"type":"create_agent","name":"Vibe AI Appointment","system_prompt":"Appointment booking agent for Vibe AI. Collect the caller's name, email, phone number, preferred date and time, then book the appointment. Hours Monday to Saturday 9 am to 6 pm.","language":"en"},{"type":"add_booking","agent":"Vibe AI Appointment","appointment":"Appointment","duration":30,"days":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],"start":"09:00","end":"18:00"}]}>>
Never output ACTION for plain questions.`;

const MAX_BODY = 8_000_000; // screenshots as data URLs

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("body too large");
  return JSON.parse(text);
}

const fail = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

export async function askChat(req: Request): Promise<Response> {
  let b: any;
  try { b = await readJson(req); } catch { return fail(400, "invalid JSON"); }
  // Trust boundary: only user/assistant turns, capped, so the client can't inject a system prompt.
  const history = (Array.isArray(b?.messages) ? b.messages : [])
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!history.length || history[history.length - 1].role !== "user") return fail(400, "last message must be from the user");
  const path = typeof b?.page?.path === "string" ? b.page.path.slice(0, 200) : "";
  const elements = (Array.isArray(b?.page?.elements) ? b.page.elements : []).filter((e: unknown) => typeof e === "string").slice(0, 100).map((e: string) => e.slice(0, 90));
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v : []).filter((x) => typeof x === "string").slice(0, n).map((x: string) => x.slice(0, 80));
  const agents = list(b?.context?.agents, 50);
  const numbers = list(b?.context?.numbers, 20);
  // Read-only account data for questions like "which voice does X use?" (user id set by the Clerk-verified proxy).
  const owner = parseOwner({ userId: req.headers.get("x-vibe-user") });
  const account = owner ? await accountData(owner.userId).catch(() => "") : "";
  const pageNote = `${account ? `THE USER'S ACCOUNT DATA (live, read-only; answer questions about their agents, calls, campaigns, tools, bookings etc. from this, quoting the real names and numbers; if something isn't listed, say you can't see it; to CHANGE anything use the tasks/ACTIONs as usual):\n${account}\n\n` : ""}The user is on ${path || "an unknown page"}. Visible buttons, links and fields there: ${elements.join(" | ") || "none read"}.
The user's agents: ${agents.join(" | ") || "none yet"}.
The user's phone numbers (caller IDs): ${numbers.join(" | ") || "none connected"}.`;

  const controller = new AbortController();
  req.signal?.addEventListener("abort", () => controller.abort()); // user closed the chat mid-reply
  const tokens = museTokens(
    {
      model: "muse-spark-1.3",
      messages: [{ role: "system", content: `${SYSTEM}\n\n${pageNote}` }, ...history],
      stream: true,
      max_tokens: 2500, // multi-step ACTIONs are long, and Muse's minimal reasoning counts too: a cut-off ACTION does nothing
      reasoning_effort: "minimal",
    },
    controller.signal,
  );
  // Wait for the first token so a Muse error is still a clean 502, then stream the rest.
  let first: IteratorResult<string>;
  try { first = await tokens.next(); } catch (e) { return fail(502, (e as Error).message.slice(0, 300)); }
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { if (!first.done) c.enqueue(enc.encode(first.value)); else c.close(); },
    async pull(c) {
      try {
        const next = await tokens.next();
        if (next.done) c.close();
        else c.enqueue(enc.encode(next.value));
      } catch {
        c.close();
      }
    },
    cancel() { controller.abort(); },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}

const BOX = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([\d.]+))?\|>/g;

/** Parse SAM 3.1 output text ("<0f>0<|box;...|><|mask;...|>,1<|box;...|>...") into pixel boxes. */
export function parseSamBoxes(text: string) {
  return [...text.matchAll(BOX)].map((m) => ({
    x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4], w: +m[5], h: +m[6], c: m[7] ? +m[7] : null,
  }));
}

export async function askSam(req: Request): Promise<Response> {
  let b: any;
  try { b = await readJson(req); } catch { return fail(400, "invalid JSON or image too large"); }
  const image = b?.image;
  if (typeof image !== "string" || !/^data:image\/(png|jpeg);base64,/.test(image)) return fail(400, "image must be a PNG or JPEG data URL");
  // SAM wants one short noun phrase per request.
  const prompt = typeof b?.prompt === "string" && /^[\w -]{1,40}$/.test(b.prompt) ? b.prompt : "button";
  const r = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.museApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: image }] }],
      metadata: { include_confidence: "true", mask_encoding: "one_bit" }, // masks unused; one_bit keeps them small
    }),
  }).catch((e) => e as Error);
  if (r instanceof Error) return fail(502, r.message);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return fail(502, `SAM ${r.status}: ${data?.error?.message ?? ""}`.slice(0, 300));
  const text = (data.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("");
  return new Response(JSON.stringify({ boxes: parseSamBoxes(text) }), { headers: { "Content-Type": "application/json" } });
}

// The structure every generated agent prompt follows (the user's template). Kept here, in one place.
const PROMPT_STRUCTURE = `### 1. ROLE & PERSONA
You are a [highly skilled role]. You are [2-3 positive descriptors].

### 2. TASK
[Strong action verb] [clear, direct summary of the primary objective].

### 3. SPECIFICS & EXECUTION RULES
- [Structure/format rule]
- [Tone/style rule]
- [Personalization/variable rule, e.g. use {caller.first_name} where relevant]
- [Length or complexity constraint]

### 4. CONTEXT & GOAL
- **Target Audience / Environment:** [who this is for or where it is used]
- **Workflow Integration:** [how the output fits into a larger system or process]
- **Business/User Impact:** [why it matters, the end goal]

### 5. FEW-SHOT EXAMPLES (3-5 Examples)
Use the following examples as references for style, format, and quality:

Example 1:
Input: [sample input]
Output: [sample ideal output]

Example 2: ...
Example 3: ...

### 6. IMPORTANT NOTES & CONSTRAINTS (Final Checklist)
- **Formatting:** [...]
- **Tone:** [...]
- **Negative Constraints (What NOT to do):**
  - Do NOT [...]
  - Do NOT [...]
  - Do NOT [...]`;

/**
 * POST /ask/prompt {name?, industry?, strategy?, description} -> {prompt}
 * Writes an agent's system prompt in PROMPT_STRUCTURE with Muse Spark, from whatever the user described.
 */
export async function askPrompt(req: Request): Promise<Response> {
  let b: any;
  try { b = await readJson(req); } catch { return fail(400, "invalid JSON"); }
  const field = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const description = field(b?.description, 4000);
  if (!description) return fail(400, "Describe what the agent should do first.");
  const details = [
    field(b?.name, 100) && `Agent name: ${field(b?.name, 100)}`,
    field(b?.industry, 100) && `Industry / business: ${field(b?.industry, 100)}`,
    field(b?.strategy, 100) && `Agent type: ${field(b?.strategy, 100)}`,
    `What the user wants: ${description}`,
  ].filter(Boolean).join("\n");
  const r = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.museApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "muse-spark-1.3",
      reasoning_effort: "minimal",
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content: `You are an expert prompt engineer for AI phone and voice agents. Write the agent's system prompt using EXACTLY this structure, all six sections with these headings, filling every [placeholder] with concrete content for this business (never leave brackets):

${PROMPT_STRUCTURE}

Rules: the agent speaks on live calls, so its rules must say: short spoken sentences, no markdown/emojis/lists when speaking, numbers and abbreviations in words, ask one question at a time. Give 3 realistic few-shot examples as caller Input / agent Output. Use only facts the user gave; where a fact is unknown (prices, address, hours) tell the agent to offer a follow-up instead of inventing it. Output ONLY the finished prompt, no preamble.`,
        },
        { role: "user", content: details },
      ],
    }),
  }).catch((e) => e as Error);
  if (r instanceof Error) return fail(502, r.message);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return fail(502, `Muse ${r.status}: ${data?.error?.message ?? ""}`.slice(0, 300));
  const prompt = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!prompt) return fail(502, "The model returned an empty prompt. Try again.");
  return new Response(JSON.stringify({ prompt }), { headers: { "Content-Type": "application/json" } });
}
