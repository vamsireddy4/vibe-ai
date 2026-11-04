/**
 * Voice campaigns on Cloudflare: one CampaignRun Durable Object per campaign dials its contacts one at a
 * time (an alarm per call, so it keeps going with the browser and laptop closed). Each call is a normal
 * dialed call (CallRoom), so the Meta agent, minutes, hang-up and call logs all work the same as Outbound Call.
 *
 * POST /campaigns/run {campaign_id, contact_ids?, agent_id?, from?, userId}  (userId is set by the signed-in proxy)
 *   agent_id / from: run with this agent / only this number instead of the campaign's own (Front's picks).
 *   -> {queued, skipped_dnc}  and the calls start right away.
 */
import { DurableObject } from "cloudflare:workers";
import { allowance } from "./billing.js";

type Env = { CALLS: DurableObjectNamespace; CAMPAIGNS: DurableObjectNamespace };
type Contact = { id: string; phone_number: string; first_name?: string | null; child_names?: string | null; venue_name?: string | null };
type Phone = { provider: string; phone_number: string; telnyx_api_key?: string | null; telnyx_connection_id?: string | null; twilio_account_sid?: string | null; twilio_auth_token?: string | null };
type Run = {
  campaignId: string; userId: string; agentId: string; model?: string | null; systemPrompt?: string | null; voice?: string | null;
  phones: Phone[]; queue: Contact[]; delayMs: number; round: number; nextPhone: number; made: number; initiated: number; base: string;
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function db() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "") ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    get: async (path: string) => {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers: h });
      return r.ok ? ((await r.json()) as any[]) : [];
    },
    patch: (path: string, body: object) => fetch(`${url}/rest/v1/${path}`, { method: "PATCH", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify(body) }),
    post: (path: string, body: object) => fetch(`${url}/rest/v1/${path}`, { method: "POST", headers: { ...h, Prefer: "return=minimal" }, body: JSON.stringify(body) }),
  };
}

/** Load and check the campaign (it must be the caller's), then hand it to that campaign's runner. */
export async function startCampaign(body: any, env: Env, base: string): Promise<Response> {
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const campaignId = typeof body?.campaign_id === "string" ? body.campaign_id : "";
  if (!userId) return json(401, { error: "Sign in again to run campaigns." });
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return json(400, { error: "campaign_id is required" });
  const d = db();
  const mine = `user_id=eq.${encodeURIComponent(userId)}`;

  const [campaign] = await d.get(`campaigns?select=*&id=eq.${campaignId}&${mine}&limit=1`);
  if (!campaign) return json(404, { error: "Campaign not found" });
  const agentId = typeof body.agent_id === "string" && /^[0-9a-f-]{36}$/i.test(body.agent_id) ? body.agent_id : campaign.agent_id;
  const [agent] = agentId ? await d.get(`agents?select=id,model,system_prompt,voice&id=eq.${agentId}&${mine}&limit=1`) : [];
  if (!agent) return json(400, { error: "Pick an agent for this campaign first." });

  const linked = await d.get(`campaign_phone_configs?select=sort_order,phone_configs(*)&campaign_id=eq.${campaignId}&${mine}&order=sort_order.asc`);
  let phones: Phone[] = linked.map((l) => l.phone_configs).filter(Boolean);
  if (!phones.length && campaign.phone_config_id) phones = await d.get(`phone_configs?select=*&id=eq.${campaign.phone_config_id}&${mine}`);
  // A number picked in Front: only that one (it must be the caller's own).
  if (typeof body.from === "string" && body.from) phones = await d.get(`phone_configs?select=*&phone_number=eq.${encodeURIComponent(body.from)}&${mine}&limit=1`);
  phones = phones.filter((p) => p.provider === "twilio" || p.provider === "telnyx");
  if (!phones.length) return json(400, { error: "Add a Twilio or Telnyx number to this campaign first." });

  const ids = Array.isArray(body.contact_ids) ? body.contact_ids.filter((x: unknown) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)) : [];
  const contacts: Contact[] = await d.get(`contacts?select=*&campaign_id=eq.${campaignId}${ids.length ? `&id=in.(${ids.join(",")})` : ""}&order=created_at.asc`);
  if (!contacts.length) return json(400, { error: "No contacts found for this campaign" });
  const dnc = new Set((await d.get(`do_not_call?select=phone_number&${mine}`)).map((r) => r.phone_number));
  const queue = contacts.filter((c) => c.phone_number && !dnc.has(c.phone_number));
  if (!queue.length) return json(400, { error: "Every selected contact is on your do-not-call list." });

  const allowed = await allowance(userId);
  if ("error" in allowed) return json(402, { error: allowed.error });

  const run: Run = {
    campaignId, userId, agentId: agent.id, model: agent.model, systemPrompt: agent.system_prompt, voice: agent.voice,
    phones, queue, delayMs: Math.max(5, Number(campaign.delay_seconds) || 30) * 1000, round: campaign.round || 1,
    nextPhone: 0, made: 0, initiated: 0, base,
  };
  const r = await env.CAMPAIGNS.get(env.CAMPAIGNS.idFromName(campaignId)).fetch("https://campaign/start", { method: "POST", body: JSON.stringify(run) });
  if (!r.ok) return r;
  await d.patch(`campaigns?id=eq.${campaignId}`, { status: "active", total_contacts: queue.length, calls_made: 0 });
  return json(200, { queued: queue.length, skipped_dnc: contacts.length - queue.length, delay_seconds: run.delayMs / 1000 });
}

export class CampaignRun extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const running = await this.ctx.storage.get<Run>("run");
    if (running?.queue.length) return json(409, { error: "This campaign is already calling. Wait for it to finish." });
    await this.ctx.storage.put("run", await req.json());
    await this.ctx.storage.setAlarm(Date.now());
    return json(200, { ok: true });
  }

  /** One call per alarm, then wait the campaign's delay before the next. */
  async alarm() {
    const run = await this.ctx.storage.get<Run>("run");
    if (!run) return;
    const d = db();
    const contact = run.queue.shift();
    if (!contact) return this.finish(run);

    // Out of minutes: pause the campaign instead of dialing.
    const allowed = await allowance(run.userId);
    if ("error" in allowed) {
      await d.patch(`campaigns?id=eq.${run.campaignId}`, { status: "paused" });
      return void (await this.ctx.storage.deleteAll());
    }

    const phone = run.phones[run.nextPhone % run.phones.length]; // round-robin
    run.nextPhone++;
    // ponytail: no per-number locking; numbers rotate round-robin and calls are spaced by the campaign delay.
    const id = crypto.randomUUID();
    const dial = await this.env.CALLS.get(this.env.CALLS.idFromName(id)).fetch(
      `https://call/dial?provider=${phone.provider}&id=${id}&base=${encodeURIComponent(run.base)}`,
      {
        method: "POST",
        body: JSON.stringify({
          apiKey: phone.telnyx_api_key, connectionId: phone.telnyx_connection_id,
          accountSid: phone.twilio_account_sid, authToken: phone.twilio_auth_token,
          from: phone.phone_number, to: contact.phone_number.replace(/[^\d+]/g, ""),
          model: run.model, systemPrompt: run.systemPrompt, voice: run.voice,
          userId: run.userId, agentId: run.agentId,
          campaign: { id: run.campaignId, contactId: contact.id, round: run.round },
        }),
      },
    ).catch((e) => json(502, { error: String(e) }));
    const ok = dial.ok;
    if (ok) run.initiated++;
    else console.warn(`[campaign ${run.campaignId.slice(0, 8)}] call to ${contact.phone_number} failed: ${await dial.text()}`);
    run.made++;

    await Promise.all([
      d.post("call_outcomes", {
        user_id: run.userId, campaign_id: run.campaignId, contact_id: contact.id, phone_number: contact.phone_number,
        parent_name: contact.first_name ?? null, child_names: contact.child_names ?? null, venue_name: contact.venue_name ?? null,
        outcome: ok ? "PENDING" : "FAILED", attempt_number: run.round,
      }),
      d.patch(`campaigns?id=eq.${run.campaignId}`, { calls_made: run.made }),
    ]);

    if (!run.queue.length) return this.finish(run);
    await this.ctx.storage.put("run", run);
    await this.ctx.storage.setAlarm(Date.now() + run.delayMs);
  }

  private async finish(run: Run) {
    await db().patch(`campaigns?id=eq.${run.campaignId}`, { status: run.initiated ? "completed" : "failed" });
    await this.ctx.storage.deleteAll();
  }
}
