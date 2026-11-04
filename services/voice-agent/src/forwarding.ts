/**
 * Call forwarding (Agent > Call Forwarding). When the agent has forwarding numbers, phone calls get a
 * `transfer_call` tool. Twilio rings the numbers in order (20 s each; busy / no answer moves to the next);
 * Telnyx transfers to the first one.
 */
import type { AgentTools } from "./llm/groqStreamer.js";

const E164 = /^\+[1-9]\d{6,14}$/;

/** The agent's forwarding numbers in priority order (only valid E.164 ones). */
export async function forwardingNumbers(userId: string, agentId?: string): Promise<string[]> {
  if (!agentId) return [];
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const r = await fetch(
    `${url}/rest/v1/call_forwarding_numbers?select=phone_number&agent_id=eq.${encodeURIComponent(agentId)}&user_id=eq.${encodeURIComponent(userId)}&order=priority.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  ).catch(() => null);
  const rows: { phone_number: string }[] = r?.ok ? await r.json() : [];
  return rows.map((x) => x.phone_number.replace(/[^\d+]/g, "")).filter((n) => E164.test(n));
}

/** TwiML for ringing forwarding number i; Twilio posts the result to `action`, which picks the next step. */
export function dialStep(numbers: string[], i: number, callerId: string, action: string): string {
  if (i >= numbers.length) return `<Response><Say>Sorry, no one is available right now. Please try again later. Goodbye.</Say><Hangup/></Response>`;
  return `<Response><Dial timeout="20" answerOnBridge="true" callerId="${callerId}" action="${action}?i=${i}" method="POST"><Number>${numbers[i]}</Number></Dial></Response>`;
}

/** After ringing number i: answered and done -> hang up; otherwise ring the next one. */
export function nextStep(numbers: string[], i: number, dialStatus: string | null, callerId: string, action: string): string {
  return dialStatus === "completed" || dialStatus === "answered" ? "<Response><Hangup/></Response>" : dialStep(numbers, i + 1, callerId, action);
}

export function transferTool(onTransfer: () => void): AgentTools {
  let started = false;
  return {
    defs: [{
      type: "function",
      function: {
        name: "transfer_call",
        description: "Transfer the caller to a human on the team. Use when the caller asks for a person, or you can't help them.",
        parameters: { type: "object", properties: { reason: { type: "string", description: "Why the caller is being transferred" } } },
      },
    }],
    prompt: `TRANSFER. You can transfer the caller to a human with transfer_call. Do it when they ask for a real person, or when you can't help. After calling it, say only: "Connecting you now, please hold." and nothing else.`,
    run: async () => {
      if (started) return "Already transferring.";
      started = true;
      onTransfer();
      return 'Transfer started. Say only: "Connecting you now, please hold."';
    },
  };
}

/** Both tool sets on one call. */
export function mergeTools(a?: AgentTools, b?: AgentTools): AgentTools | undefined {
  if (!a || !b) return a ?? b;
  return {
    defs: [...a.defs, ...b.defs],
    prompt: `${a.prompt}\n\n${b.prompt}`,
    run: (name, args) => (b.defs.some((d: any) => d.function?.name === name) ? b.run(name, args) : a.run(name, args)),
  };
}
