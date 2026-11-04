import { authJsonHeaders } from "@/lib/local-functions";

type CallAgent = { id?: string; ai_provider?: string | null; model?: string | null; system_prompt?: string | null; voice?: string | null };
type CallNumber = {
  provider?: string | null; phone_number?: string | null;
  telnyx_api_key?: string | null; telnyx_connection_id?: string | null;
  twilio_account_sid?: string | null; twilio_auth_token?: string | null;
};

/** Telnyx and Twilio numbers dial through the local voice agent (Meta models run the call). */
export const canPlaceMetaTelnyxCall = (_agent?: CallAgent | null, number?: CallNumber | null) =>
  number?.provider === "telnyx" || number?.provider === "twilio";

/** The local voice agent dials through the number's provider and runs the call. */
// ponytail: no call log or minute deduction on this path yet.
export async function placeMetaTelnyxCall(agent: CallAgent, number: CallNumber, to: string, userId: string) {
  let res: Response;
  try {
    const provider = number.provider === "twilio" ? "twilio" : "telnyx";
    res = await fetch(`${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/calls/${provider}`, {
      method: "POST",
      headers: await authJsonHeaders(),
      body: JSON.stringify({
        apiKey: number.telnyx_api_key,
        connectionId: number.telnyx_connection_id,
        accountSid: number.twilio_account_sid,
        authToken: number.twilio_auth_token,
        from: number.phone_number,
        to: to.replace(/[^\d+]/g, ""),
        model: agent.model,
        systemPrompt: agent.system_prompt,
        voice: agent.voice,
        userId, // the voice agent saves the call to call_logs for this user when it ends
        agentId: agent.id,
      }),
    });
  } catch {
    throw new Error("Could not reach the voice agent. Start it with npm start in services/voice-agent.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Voice agent HTTP ${res.status}`);
  return body as { callControlId?: string };
}

/**
 * Start a voice campaign on the voice agent (Cloudflare): it dials the contacts one at a time with the
 * campaign's delay, even after this page is closed. Resolves with what was queued; throws the agent's error.
 */
export async function runVoiceCampaign(campaignId: string, contactIds?: string[], pick?: { agentId?: string; from?: string }) {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_VOICE_AGENT_URL || `${window.location.origin}/voice-agent`}/campaigns/run`, {
      method: "POST",
      headers: await authJsonHeaders(),
      body: JSON.stringify({
        campaign_id: campaignId,
        ...(contactIds?.length ? { contact_ids: contactIds } : {}),
        ...(pick?.agentId ? { agent_id: pick.agentId } : {}),
        ...(pick?.from ? { from: pick.from } : {}),
      }),
    });
  } catch {
    throw new Error("Could not reach the voice agent.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Voice agent HTTP ${res.status}`);
  return body as { queued: number; skipped_dnc: number; delay_seconds: number };
}
