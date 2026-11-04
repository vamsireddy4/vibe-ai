import { describe, expect, it } from "vitest";
import { boxToViewport, isForbiddenButton, isRiskyButton, isSecretField, labelScore, splitReply, userGave } from "@/lib/ask-vibe";

/** Tasks the parser keeps from one ACTION holding `t`. */
const tasks = (t: object) => splitReply(`ok <<ACTION ${JSON.stringify({ navigate: "", steps: [], tasks: [t] })}>>`).action?.tasks ?? [];

describe("ask vibe helpers", () => {
  it("splits reply text from the action steps, even mid-stream", () => {
    const raw = 'Opening the Telnyx form for you.\n<<ACTION {"navigate":"/voice/phone-config","steps":[{"do":"click","target":"Add Telnyx Number"},{"do":"ask","target":"API Key"}]}>>';
    expect(splitReply(raw)).toEqual({
      text: "Opening the Telnyx form for you.",
      action: { navigate: "/voice/phone-config", steps: [{ do: "click", target: "Add Telnyx Number" }, { do: "ask", target: "API Key" }], tasks: [], more: false },
    });
    expect(splitReply("Go there.\n<<ACT")).toEqual({ text: "Go there.", action: null });
  });

  it("keeps fills with values, asks without one, and rejects navigation outside the app", () => {
    const r = splitReply('x <<ACTION {"navigate":"https://evil.example","steps":[{"do":"fill","target":"API Key","value":"KEY123"},{"do":"fill","target":"Name"},{"do":"rm","target":"x"}]}>>');
    expect(r.action).toEqual({ navigate: "", steps: [{ do: "fill", target: "API Key", value: "KEY123" }, { do: "ask", target: "Name" }], tasks: [], more: false });
  });

  it("fills a secret only with a value the user typed", () => {
    expect(userGave("KEY123abc", ["here is my key KEY123abc"])).toBe(true);
    expect(userGave("KEY999", ["here is my key KEY123abc"])).toBe(false); // model-invented
    expect(userGave("abc", ["abc"])).toBe(false); // too short to be a real value
  });

  it("keeps going only when the model asks to, and never after a call", () => {
    expect(splitReply('ok <<ACTION {"navigate":"/voice/outbound-call","steps":[],"continue":true}>>').action?.more).toBe(true);
    expect(splitReply('ok <<ACTION {"navigate":"/voice/outbound-call","steps":[]}>>').action?.more).toBe(false);
    expect(splitReply('ok <<ACTION {"navigate":"","steps":[],"continue":true,"task":{"type":"outbound_call","agent":"A","to":"+15551234567","from":""}}>>').action?.more).toBe(false);
  });

  it("flags risky buttons and secret fields", () => {
    expect(isRiskyButton("Connect Telnyx")).toBe(true);
    expect(isRiskyButton("Delete agent")).toBe(true);
    expect(isRiskyButton("Add Telnyx Number")).toBe(false);
    expect(isRiskyButton("Create Agent")).toBe(false);
    expect(isSecretField("Auth Token")).toBe(true);
    expect(isSecretField("Phone Number")).toBe(false);
  });

  it("never lets Ask Vibe press payment or sign-out buttons, even after confirm", () => {
    for (const b of ["Pay now", "Buy minutes", "Checkout", "Sign out", "Log out"]) expect(isForbiddenButton(b)).toBe(true);
    for (const b of ["Send", "Start Campaign", "Delete agent", "Connect", "Place Call"]) expect(isForbiddenButton(b)).toBe(false);
  });

  it("matches on-screen labels and maps SAM boxes to the viewport", () => {
    expect(labelScore("Create Agent", "create agent")).toBe(1);
    expect(labelScore("Add Telnyx Number", "Telnyx")).toBeGreaterThan(0.3);
    expect(labelScore("Delete", "Create Agent")).toBe(0);
    expect(boxToViewport({ x1: 100, y1: 50, x2: 300, y2: 150, w: 2000, h: 1000 }, 1000, 500)).toEqual({ left: 50, top: 25, width: 100, height: 50 });
  });

  it("parses the core tasks and drops incomplete ones", () => {
    expect(tasks({ type: "create_agent", name: "Clinic", system_prompt: "Books checkups", language: "te" })).toEqual([{ type: "create_agent", name: "Clinic", system_prompt: "Books checkups", language: "te" }]);
    expect(tasks({ type: "create_agent", name: "Clinic" })).toEqual([]); // no prompt
    expect(tasks({ type: "outbound_call", agent: "A", to: "+1 555 123 4567", from: "" })).toEqual([{ type: "outbound_call", agent: "A", to: "+15551234567", from: "" }]);
    expect(tasks({ type: "outbound_call", agent: "A", to: "12345" })).toEqual([]); // not E.164
    expect(tasks({ type: "add_booking", agent: "A", days: ["Monday", "Funday"], start: "09:00", end: "18:00" })).toEqual([
      { type: "add_booking", agent: "A", appointment: "Appointment", duration: 30, days: ["Monday"], start: "09:00", end: "18:00" },
    ]);
    expect(tasks({ type: "add_booking", agent: "A", days: ["Monday"], start: "18:00", end: "09:00" })).toEqual([]); // end before start
  });

  it("parses the profile, forwarding, tool and webhook tasks and rejects bad values", () => {
    expect(tasks({ type: "update_profile", timezone: "Asia/Kolkata", voice_model: "muse-spark-1.3-contributor" })).toEqual([
      { type: "update_profile", timezone: "Asia/Kolkata", voice_model: "muse-spark-1.3-contributor" },
    ]);
    expect(tasks({ type: "update_profile", timezone: "Mars/Base", voice_model: "gpt-4" })).toEqual([]); // nothing valid left
    expect(tasks({ type: "add_forwarding", agent: "Sales", number: "+91 98765 43210" })).toEqual([{ type: "add_forwarding", agent: "Sales", number: "+919876543210", label: "" }]);
    expect(tasks({ type: "add_forwarding", agent: "Sales", number: "98765" })).toEqual([]);
    expect(tasks({ type: "create_tool", agent: "A", name: "lookup serial!", url: "https://x.test/serial", method: "post" })).toEqual([
      { type: "create_tool", agent: "A", name: "lookupserial", description: "", url: "https://x.test/serial", method: "POST" },
    ]);
    expect(tasks({ type: "create_tool", agent: "A", name: "t", url: "http://insecure.test" })).toEqual([]); // https only
    expect(tasks({ type: "add_webhook", url: "https://hooks.test/n8n" })).toEqual([{ type: "add_webhook", url: "https://hooks.test/n8n", agent: "" }]);
    expect(tasks({ type: "add_webhook", url: "javascript:alert(1)" })).toEqual([]);
  });

  it("parses tool on/off; there is no Analysis AI task any more", () => {
    expect(tasks({ type: "set_tool_active", tool: "fxbcSerialLookup", active: false })).toEqual([{ type: "set_tool_active", tool: "fxbcSerialLookup", active: false }]);
    expect(tasks({ type: "set_tool_active", tool: "x", active: "no" })).toEqual([]);
    expect(tasks({ type: "set_analysis_ai", provider: "gemini", model: "x" })).toEqual([]); // removed: analysis runs on Muse Spark
  });

  it("parses agent updates and needs at least one change", () => {
    expect(tasks({ type: "update_agent", agent: "General Assistant", voice_gender: "male" })).toEqual([{ type: "update_agent", agent: "General Assistant", voice_gender: "masculine" }]);
    expect(tasks({ type: "update_agent", agent: "A", voice: "aura-2-fabian-de", active: false })).toEqual([{ type: "update_agent", agent: "A", voice: "aura-2-fabian-de", active: false }]);
    expect(tasks({ type: "update_agent", agent: "A", voice: "elevenlabs-x" })).toEqual([]); // not a Deepgram voice, nothing left
  });

  it("parses compose_message, checks the recipient per channel, and sends only when asked", () => {
    expect(tasks({ type: "compose_message", channel: "email", to: "a@b.co", subject: "Hi", message: "Hello" })).toEqual([
      { type: "compose_message", channel: "email", to: "a@b.co", subject: "Hi", message: "Hello", agent: "", send: false },
    ]);
    expect(tasks({ type: "compose_message", channel: "email", to: "a@b.co", send: true })[0]).toMatchObject({ send: true });
    expect(tasks({ type: "compose_message", channel: "email", to: "a@b.co", send: "yes" })[0]).toMatchObject({ send: false }); // only a real true
    expect(tasks({ type: "compose_message", channel: "sms", to: "+1 555 000 9999", message: "x" })[0]).toMatchObject({ to: "+15550009999" });
    expect(tasks({ type: "compose_message", channel: "email", to: "not-an-email" })).toEqual([]);
    expect(tasks({ type: "compose_message", channel: "fax", to: "+15550009999" })).toEqual([]);
  });

  it("parses start_campaign: voice needs a name, email also a template", () => {
    expect(tasks({ type: "start_campaign", channel: "voice", campaign: "test" })).toEqual([{ type: "start_campaign", channel: "voice", campaign: "test", template: "" }]);
    expect(tasks({ type: "start_campaign", channel: "email", campaign: "test", template: "welcome" })[0]).toMatchObject({ template: "welcome" });
    expect(tasks({ type: "start_campaign", channel: "email", campaign: "test" })).toEqual([]);
    expect(tasks({ type: "start_campaign", channel: "sms", campaign: "test", template: "x" })).toEqual([]);
  });

  it("drops the model's glued repeat sentence but keeps normal ones", () => {
    expect(splitReply('Opening the Campaigns tab.Opening the Campaigns tab for you.\n<<ACTION {"navigate":"","steps":[]}>>').text).toBe("Opening the Campaigns tab.");
    expect(splitReply("Done. Two sentences are fine.").text).toBe("Done. Two sentences are fine.");
    expect(splitReply("Open app.vibe.ai to sign in.").text).toBe("Open app.vibe.ai to sign in."); // lowercase after the dot: untouched
  });
});
