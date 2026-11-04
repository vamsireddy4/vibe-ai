import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCall, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Tables } from "@/integrations/supabase/types";
import { getErrorMessage } from "@/lib/edge-functions";
import { usePersistentState } from "@/hooks/usePersistentState";
import { ADMIN_EMAIL } from "@/lib/constants";
import { useLiveMinuteBalance } from "@/hooks/useLiveMinuteBalance";
import { canPlaceMetaTelnyxCall, placeMetaTelnyxCall } from "@/lib/outbound-call";

function dedupePhoneConfigs(
  configs: Tables<"phone_configs">[],
  preferredId?: string,
) {
  const deduped = new Map<string, Tables<"phone_configs">>();

  for (const config of configs) {
    const key = [
      String(config.phone_number || "").trim(),
      String(config.provider || "").trim().toLowerCase(),
      String(config.channel || "").trim().toLowerCase(),
    ].join("::");

    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, config);
      continue;
    }

    if (preferredId && config.id === preferredId) {
      deduped.set(key, config);
    }
  }

  return Array.from(deduped.values());
}

export default function OutboundCall() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [agents, setAgents] = useState<Tables<"agents">[]>([]);
  const [phoneConfigs, setPhoneConfigs] = useState<Tables<"phone_configs">[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = usePersistentState("outbound-call-form", {
    agent_id: "",
    recipient_number: "",
    phone_config_id: "",
  });
  const isAdmin = user?.email === ADMIN_EMAIL;
  const { availableSeconds, liveAvailableSeconds, activeCall } = useLiveMinuteBalance(user?.id, isAdmin);

  useEffect(() => {
    if (!user) return;

    supabase.from("agents").select("*").eq("is_active", true).then(({ data }) => setAgents(data || []));
    supabase
      .from("phone_configs")
      .select("*")
      .eq("is_active", true)
      .then(({ data }) =>
        setPhoneConfigs(
          dedupePhoneConfigs(
            (data || []).filter((config: any) => config.channel !== "sms"),
            form.phone_config_id,
          ),
        ),
      );
  }, [user, form.phone_config_id]);

  const selectedAgent = agents.find((a) => a.id === form.agent_id);
  const selectedPhoneConfig = phoneConfigs.find((pc) => pc.id === form.phone_config_id);

  const handleCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!isAdmin && (availableSeconds ?? 0) <= 0) {
      toast({ title: "Error", description: "Your free minutes are used up. Add minutes to keep making calls.", variant: "destructive" });
      return;
    }
    if (!canPlaceMetaTelnyxCall(selectedAgent, selectedPhoneConfig)) {
      toast({ title: "Error", description: "Calls need a Twilio or Telnyx number (Phone numbers).", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      await placeMetaTelnyxCall(selectedAgent!, selectedPhoneConfig!, form.recipient_number, user.id);
      toast({ title: "Call initiated!", description: "Your phone should ring in a few seconds." });
      setForm({ ...form, recipient_number: "" });
    } catch (error) {
      toast({ title: "Error", description: getErrorMessage(error), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Outbound Call</h1>
          <p className="text-muted-foreground mt-1">Make an AI-powered outbound call.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PhoneCall className="h-5 w-5" />
              Place a Call
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCall} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="outbound-agent">Agent</Label>
                <Select value={form.agent_id} onValueChange={(val) => setForm({ ...form, agent_id: val })}>
                  <SelectTrigger id="outbound-agent"><SelectValue placeholder="Select an agent" /></SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="outbound-recipient">Recipient Phone Number</Label>
                <Input
                  id="outbound-recipient"
                  value={form.recipient_number}
                  onChange={(e) => setForm({ ...form, recipient_number: e.target.value })}
                  placeholder="+15551234567"
                  required
                />
                <p className="text-xs text-muted-foreground">Include country code (e.g. +1 for US)</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="outbound-caller-id">Phone Number (Caller ID)</Label>
                <Select value={form.phone_config_id} onValueChange={(val) => setForm({ ...form, phone_config_id: val })}>
                  <SelectTrigger id="outbound-caller-id"><SelectValue placeholder="Select a phone number" /></SelectTrigger>
                  <SelectContent>
                    {phoneConfigs.map((pc) => (
                      <SelectItem key={pc.id} value={pc.id}>
                        {pc.phone_number} {pc.friendly_name ? `(${pc.friendly_name})` : ""} — {pc.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={loading || !form.agent_id || !form.phone_config_id || (!isAdmin && (availableSeconds ?? 0) <= 0)}>
                {loading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Placing Call...</>
                ) : (
                  <><PhoneCall className="h-4 w-4 mr-2" />Place Call</>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
