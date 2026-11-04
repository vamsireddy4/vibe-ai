import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { MessageCircleMore } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { getVibePath } from "@/lib/vibe-routes";
import { matchesSearch } from "@/lib/utils";

type Conversation = { id: string; contact_name: string; phone_number: string; last_message_text: string | null; last_message_at: string | null; unread_count: number };

/** WhatsApp conversations, newest first (History page). Opening one goes to WhatsApp Chats. */
export default function WhatsAppHistory({ search = "", status = "all" }: { search?: string; status?: string }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("whatsapp_conversations")
      .select("id, contact_name, phone_number, last_message_text, last_message_at, unread_count")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(200) // ponytail: first 200 conversations; paginate if accounts get bigger
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setRows((data as Conversation[]) ?? []);
      });
  }, []);

  if (!rows) return <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>;

  const shown = rows.filter((c) => (status !== "unread" || c.unread_count > 0) && matchesSearch(search, [c.contact_name, c.phone_number, c.last_message_text]));

  if (!shown.length) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <MessageCircleMore className="mb-4 h-12 w-12 text-muted-foreground" />
          <h3 className="mb-1 text-lg font-semibold">{error ? "Couldn't load WhatsApp history" : rows.length ? "No conversations match" : "No WhatsApp conversations yet"}</h3>
          <p className="text-sm text-muted-foreground">{error ?? "Conversations appear here once you send or receive WhatsApp messages."}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {shown.map((c) => (
        <Card key={c.id} className="transition-colors hover:border-primary/40">
          <button
            type="button"
            onClick={() => navigate(getVibePath("whatsapp", "chats"))}
            className="flex w-full items-center gap-4 p-4 text-left"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted"><MessageCircleMore className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{c.contact_name || c.phone_number}</span>
                <span className="font-mono text-xs text-muted-foreground">{c.phone_number}</span>
                {c.unread_count > 0 && <span className="rounded-full bg-foreground px-2 py-0.5 text-xs text-background">{c.unread_count} new</span>}
              </span>
              <span className="mt-0.5 block truncate text-sm text-muted-foreground">{c.last_message_text || "No messages"}</span>
            </span>
            {c.last_message_at && <span className="shrink-0 text-xs text-muted-foreground">{format(new Date(c.last_message_at), "d MMM yyyy, H:mm")}</span>}
          </button>
        </Card>
      ))}
    </div>
  );
}
