import { useEffect, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Call = { direction: string; caller_number: string | null; twilio_call_sid: string | null };

/**
 * Plays a call's recording. The voice agent writes where it lives into twilio_call_sid:
 * - "telnyx:<call_control_id>": phone calls, fetched live from Telnyx (we don't store them;
 *   Telnyx's download links expire after ~10 minutes, so we ask for a fresh one).
 * - "CA<32 hex>": Twilio phone calls (plain CallSid), fetched live from Twilio with the user's own
 *   credentials; the MP3 needs auth too, so it's downloaded and played from a local blob URL.
 * - "storage:<path>": browser demo calls (no provider to keep them), in the private
 *   call-recordings bucket; RLS lets each user read only their own folder.
 */
export default function CallRecording({ call }: { call: Call }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "none" | "error"; url?: string; message?: string }>({ status: "idle" });
  const callControlId = call.twilio_call_sid?.startsWith("telnyx:") ? call.twilio_call_sid.slice("telnyx:".length) : null;
  const storagePath = call.twilio_call_sid?.startsWith("storage:") ? call.twilio_call_sid.slice("storage:".length) : null;
  const twilioSid = /^CA[0-9a-f]{32}$/i.test(call.twilio_call_sid ?? "") ? call.twilio_call_sid : null;
  const provider = callControlId ? "Telnyx" : "Twilio";

  useEffect(() => {
    if (!twilioSid) return;
    let cancelled = false;
    let blobUrl = "";
    setState({ status: "loading" });
    (async () => {
      // The user's own Twilio credentials (RLS): the number that placed the call, else any Twilio number.
      const { data: configs } = await supabase.from("phone_configs").select("phone_number, twilio_account_sid, twilio_auth_token").eq("provider", "twilio");
      const cfg = configs?.find((c) => c.phone_number === call.caller_number && c.twilio_auth_token) ?? configs?.find((c) => c.twilio_account_sid && c.twilio_auth_token);
      if (!cfg?.twilio_account_sid || !cfg.twilio_auth_token) throw new Error("No Twilio credentials found in Phone numbers.");
      const auth = { Authorization: `Basic ${btoa(`${cfg.twilio_account_sid}:${cfg.twilio_auth_token}`)}` };
      const base = `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_account_sid}`;
      const res = await fetch(`${base}/Recordings.json?CallSid=${twilioSid}`, { headers: auth });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || `Twilio HTTP ${res.status}`);
      const rec = (body.recordings ?? []).find((r: any) => r.status === "completed");
      if (!rec) return !cancelled && setState({ status: "none" });
      const audio = await fetch(`${base}/Recordings/${rec.sid}.mp3`, { headers: auth });
      if (!audio.ok) throw new Error(`Twilio HTTP ${audio.status}`);
      blobUrl = URL.createObjectURL(await audio.blob());
      if (!cancelled) setState({ status: "ready", url: blobUrl });
    })().catch((e: Error) => !cancelled && setState({ status: "error", message: e.message }));
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [twilioSid, call.caller_number]);

  useEffect(() => {
    if (!storagePath) return;
    let cancelled = false;
    setState({ status: "loading" });
    supabase.storage.from("call-recordings").createSignedUrl(storagePath, 3600).then(({ data, error }) => {
      if (cancelled) return;
      setState(data?.signedUrl ? { status: "ready", url: data.signedUrl } : { status: "error", message: error?.message ?? "Recording not found." });
    });
    return () => { cancelled = true; };
  }, [storagePath]);

  useEffect(() => {
    if (!callControlId) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      // The user's own Telnyx key (RLS): the number that placed the call, else any Telnyx number.
      const { data: configs } = await supabase.from("phone_configs").select("phone_number, telnyx_api_key").eq("provider", "telnyx");
      const key = (configs?.find((c) => c.phone_number === call.caller_number) ?? configs?.find((c) => c.telnyx_api_key))?.telnyx_api_key;
      if (!key) throw new Error("No Telnyx API key found in Phone Integration.");
      const res = await fetch(`https://api.telnyx.com/v2/recordings?filter[call_control_id]=${encodeURIComponent(callControlId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.errors?.[0]?.detail || `Telnyx HTTP ${res.status}`);
      const rec = (body.data ?? []).find((r: any) => r.download_urls?.mp3 || r.download_urls?.wav);
      if (cancelled) return;
      setState(rec ? { status: "ready", url: rec.download_urls.mp3 ?? rec.download_urls.wav } : { status: "none" });
    })().catch((e: Error) => !cancelled && setState({ status: "error", message: e.message }));
    return () => { cancelled = true; };
  }, [callControlId, call.caller_number]);

  if (!callControlId && !storagePath && !twilioSid) {
    return call.direction === "demo" ? null : (
      <p className="text-xs text-muted-foreground">No recording for this call.</p>
    );
  }

  return (
    <div>
      <p className="text-sm font-medium mb-2 flex items-center gap-1.5"><Mic className="h-4 w-4 text-primary" /> Recording</p>
      {state.status === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {storagePath ? "Loading recording…" : `Fetching from ${provider}…`}</p>
      )}
      {state.status === "ready" && <audio controls preload="metadata" src={state.url} className="w-full" aria-label="Call recording" />}
      {state.status === "none" && <p className="text-sm text-muted-foreground">{provider} has no recording for this call yet. It can take a minute after the call ends.</p>}
      {state.status === "error" && <p className="text-sm text-destructive">Couldn't load the recording: {state.message}</p>}
    </div>
  );
}
