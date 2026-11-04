import { useLocation, useNavigate } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getVibePath, getVibeSpaceFromPath, type VibeSpace } from "@/lib/vibe-routes";

const CHANNELS: [VibeSpace, string][] = [["voice", "Voice"], ["sms", "SMS"], ["whatsapp", "WhatsApp"], ["gmail", "Email"]];

/** One Campaigns page for every channel: switches to that channel's campaigns. */
export default function ChannelSelect({ page }: { page: "campaigns" }) {
  const navigate = useNavigate();
  const channel = getVibeSpaceFromPath(useLocation().pathname);
  return (
    <Select value={channel} onValueChange={(v) => navigate(getVibePath(v as VibeSpace, page))}>
      <SelectTrigger className="h-10 w-40 shrink-0" aria-label="Campaign channel">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHANNELS.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
