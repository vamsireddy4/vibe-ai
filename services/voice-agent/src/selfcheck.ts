// Runnable check for the pure logic: `npm run check`. No API keys needed.
import assert from "node:assert/strict";
import { mixPcm16, mulaw8kToPcm16k, wav } from "./audio.js";
import { sign } from "./callLog.js";
import { dialStep, nextStep } from "./forwarding.js";

process.env.GROQ_API_KEY ??= "x";
process.env.DEEPGRAM_API_KEY ??= "x";
process.env.MUSE_API_KEY ??= "x";
const { takePhrase } = await import("./llm/groqStreamer.js");

// First chunk: 3 complete words, no punctuation needed. The growing last word is held back.
assert.equal(takePhrase("Two plus", true), null, "only 1 complete word");
assert.equal(takePhrase("Two plus two", true), null, "'two' may still be growing");
assert.deepEqual(takePhrase("Two plus two equals", true), ["Two plus two", " equals"]);
assert.equal(takePhrase("Sure thing, I", true), null, "only 2 complete words");
assert.deepEqual(takePhrase("Sure thing, I can", true), ["Sure thing, I", " can"]);
assert.deepEqual(takePhrase("Yes, it is four.", true), ["Yes, it is four.", ""]);
// Later chunks: punctuation AND >= 15 chars.
assert.equal(takePhrase(" equals four", false), null, "no punctuation yet");
assert.equal(takePhrase(" so, yes", false), null, "'so,' is under 15 chars");
assert.deepEqual(takePhrase(" equals four, of course. And", false), ["equals four, of course.", " And"]);

// mu-law: 0xFF and 0x7F are both silence; 0x00 is max negative, 0x80 max positive.
const pcm = mulaw8kToPcm16k(Buffer.from([0xff, 0x7f, 0x00, 0x80]));
assert.equal(pcm.length, 16, "8 kHz -> 16 kHz doubles samples, 2 bytes each");
assert.equal(pcm.readInt16LE(0), 0);
assert.equal(pcm.readInt16LE(8), -32124);
assert.equal(pcm.readInt16LE(12), 32124);
assert.equal(pcm.readInt16LE(10), 0, "interpolated midpoint between -32124 and 32124");

// Recording mix: clips land at their byte offset, overlaps add, sums clip at int16.
const i16 = (...v: number[]) => Buffer.from(new Int16Array(v).buffer);
const mixed = mixPcm16([{ at: 0, pcm: i16(100, 30000, 5) }, { at: 2, pcm: i16(30000, -7, 9) }]);
assert.deepEqual([...new Int16Array(mixed.buffer, mixed.byteOffset, mixed.length / 2)], [100, 32767, -2, 9]);
assert.equal(wav(mixed, 24000).length, 44 + 8);

console.log("selfcheck ok");

// SAM 3.1 output text -> pixel boxes (format from dev.meta.ai/docs/sam/reading-segmentation).
const { parseSamBoxes } = await import("./askVibe.js");
assert.deepEqual(
  parseSamBoxes("<0f>0<|box;x1=440;y1=120;x2=570;y2=170;w=600;h=300;c=0.83|><|mask;x=0;y=0;data=51,131,!abc|>,2<|box;x1=1;y1=2;x2=3;y2=4;w=600;h=300|><|mask;x=0;y=0;data=1,1,!a|>"),
  [{ x1: 440, y1: 120, x2: 570, y2: 170, w: 600, h: 300, c: 0.83 }, { x1: 1, y1: 2, x2: 3, y2: 4, w: 600, h: 300, c: null }],
);
assert.deepEqual(parseSamBoxes(""), [], "zero matches is normal");
console.log("sam parse ok");

// Call log owner: only well-formed Clerk user ids / agent uuids from the client are used.
const { parseOwner } = await import("./callLog.js");
assert.deepEqual(parseOwner({ userId: "user_3LXtLullILzcZQn7twMc57V30kh", agentId: "d1357440-b44c-4dad-97fa-97b4a7e4af5c" }), { userId: "user_3LXtLullILzcZQn7twMc57V30kh", agentId: "d1357440-b44c-4dad-97fa-97b4a7e4af5c" });
assert.deepEqual(parseOwner({ userId: "user_3LXtLullILzcZQn7twMc57V30kh", agentId: "'; drop table" }), { userId: "user_3LXtLullILzcZQn7twMc57V30kh" });
assert.equal(parseOwner({ userId: "admin" }), null);
assert.equal(parseOwner(null), null);
console.log("call owner ok");

// Thinking while the caller talks: a draft is used only when the final transcript asks the same thing.
const { sameRequest } = await import("./session/draft.js");
assert.ok(sameRequest("I'm having an issue with my printer", "I'm having an issue with my printer."), "punctuation only");
assert.ok(sameRequest("hello what is two plus two", "Hello, what is two plus two?"), "casing/punctuation");
assert.ok(!sameRequest("I want to book", "I want to book an appointment for Friday at 3"), "caller said more: redo");
assert.ok(!sameRequest("cancel my order", "track my order"), "different request");
assert.ok(!sameRequest("", "hello"), "nothing heard yet");
assert.ok(!sameRequest("Hi I am having an issue with my", "Hi, I am having an issue with my printer."), "missing last word: redo");
console.log("draft match ok");

// Booking: refuse past times and times outside business hours (in the business's own timezone).
const { slotProblem } = await import("./booking.js");
const hours = { Monday: { start: "09:00", end: "17:00", enabled: true }, Sunday: { start: "09:00", end: "17:00", enabled: false } };
const b = { timezone: "Asia/Kolkata", hours, durationMin: 30 };
const now = new Date("2026-11-08T00:00:00+05:30"); // a Sunday
assert.equal(slotProblem(new Date("2026-11-09T10:00:00+05:30"), b, now), null, "Monday 10:00 IST is open");
assert.match(slotProblem(new Date("2026-11-09T16:45:00+05:30"), b, now) ?? "", /business hours/, "ends 17:15, after closing");
assert.match(slotProblem(new Date("2026-11-08T10:00:00+05:30"), b, new Date("2026-11-07T00:00:00+05:30")) ?? "", /business hours/, "Sunday is closed");
assert.match(slotProblem(new Date("2026-11-07T10:00:00+05:30"), b, now) ?? "", /past/, "in the past");
assert.match(slotProblem(new Date("not a date"), b, now) ?? "", /understood/, "bad time");
console.log("booking rules ok");

// Webhook signature: RFC 4231 HMAC-SHA256 test case 2.
assert.equal(await sign("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
console.log("webhook signature ok");

// Call forwarding: ring in order, stop once someone answered, apologize after the last.
const nums = ["+15550000001", "+15550000002"], act = "https://x/calls/twilio/forward/id";
assert.match(dialStep(nums, 0, "+15559999999", act), /<Number>\+15550000001<\/Number>.*|action="https:\/\/x\/calls\/twilio\/forward\/id\?i=0"/s);
assert.match(nextStep(nums, 0, "no-answer", "+1", act), /\+15550000002/, "busy/no answer -> next number");
assert.equal(nextStep(nums, 0, "completed", "+1", act), "<Response><Hangup/></Response>", "answered -> done");
assert.match(nextStep(nums, 1, "busy", "+1", act), /no one is available/, "last number failed -> goodbye");
console.log("call forwarding ok");

// Custom tools: GET with no parameters sends the caller's input as ?input=; POST puts dynamic args in the JSON body.
{
  const { buildRequest } = await import("./customTools.js");
  const get = buildRequest({ name: "lookupSerial", description: null, http_method: "GET", http_url: "https://x.test/serial", http_headers: {}, http_body_template: {}, parameters: [] }, { input: "AB12" });
  assert.equal(get.url, "https://x.test/serial?input=AB12");
  const post = buildRequest({ name: "t", description: null, http_method: "POST", http_url: "https://x.test/u/{id}", http_headers: { "X-Key": "k" }, http_body_template: { src: "vibe", __staticResponse: "ok" },
    parameters: [{ paramType: "dynamic", name: "id", location: "path" }, { paramType: "dynamic", name: "email", location: "body" }] }, { id: "7", email: "a@b.co" });
  assert.equal(post.url, "https://x.test/u/7");
  assert.deepEqual(JSON.parse(String(post.init.body)), { src: "vibe", email: "a@b.co" });
  console.log("custom tools ok");
}

// Booking time: date + wall-clock time in the business's zone -> the right instant.
{
  const { zonedTime } = await import("./booking.js");
  assert.equal(zonedTime("2026-11-05", "11:00", "UTC").toISOString(), "2026-11-05T11:00:00.000Z");
  assert.equal(zonedTime("2026-11-05", "11:00", "Asia/Kolkata").toISOString(), "2026-11-05T05:30:00.000Z");
  assert.equal(zonedTime("2026-07-01", "09:30", "America/New_York").toISOString(), "2026-07-01T13:30:00.000Z", "summer time");
  assert.ok(Number.isNaN(zonedTime("tomorrow", "11am", "UTC").getTime()), "unparsed -> invalid");
  console.log("booking time ok");
}

// CRM tools on calls: no destructive/admin actions; lookups before creates; capped.
{
  const { callSafeTools } = await import("./crmTools.js");
  const picked = callSafeTools(["GOOGLECALENDAR_ACL_DELETE", "GOOGLECALENDAR_CALENDARS_DELETE", "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CALENDAR_LIST_PATCH", "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_PATCH_CALENDAR", "GOOGLECALENDAR_FIND_FREE_SLOTS"].map((slug) => ({ slug })));
  assert.deepEqual(picked.map((t) => t.slug), ["GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CREATE_EVENT"]);
  assert.equal(callSafeTools(Array.from({ length: 20 }, (_, i) => ({ slug: `X_FIND_${i}` }))).length, 8);
  console.log("crm tools ok");
}

// Analysis: web pages become readable text (no scripts/styles/tags).
{
  const { htmlToText } = await import("./analyze.js");
  assert.equal(htmlToText("<html><style>x{}</style><script>alert(1)</script><h1>Clinic</h1><p>Open 9&amp;5</p><div>Call&nbsp;us</div></html>"), "Clinic\nOpen 9&5\nCall us");
  console.log("analysis page text ok");
}

// Ask Vibe account data: real names and agent links in, nothing missing crashes it.
{
  const { formatAccount } = await import("./accountData.js");
  const empty = { list: [], total: 0 };
  const keys = ["agents", "phones", "calls", "campaigns", "gmail", "emailsSent", "whatsapp", "audiences", "tools", "apptTools", "bookings", "calendars", "knowledge", "webhooks", "profile"];
  const d: any = Object.fromEntries(keys.map((k) => [k, empty]));
  d.agents = { list: [{ id: "a1", name: "General Assistant", voice: "aura-2-thalia-en", is_active: true }], total: 1 };
  d.calls = { list: [{ started_at: "2026-11-04T10:00:00Z", direction: "outbound", agent_id: "a1", status: "completed", duration: 95 }], total: 12 };
  const text = formatAccount(d);
  assert.match(text, /General Assistant \[voice aura-2-thalia-en/);
  assert.match(text, /Calls in History: 12 total.*General Assistant, completed, 1m 35s/);
  assert.match(text, /Webhooks \(0\): none/);
  console.log("ask vibe account data ok");
}
