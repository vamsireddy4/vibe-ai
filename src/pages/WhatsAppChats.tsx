import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MessageCircleMore, MoreHorizontal, Search, Send, Smile, CheckCheck } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { getErrorMessage, isEdgeFunctionUnavailable, extractEdgeFunctionError } from "@/lib/edge-functions";
import { supportsWhatsappTable } from "@/lib/whatsapp-compat";

type Message = {
  id: string;
  body: string;
  time: string;
  sentAt?: string;
  outgoing?: boolean;
  date?: string;
  status?: "sent" | "delivered" | "read" | "failed";
};

type Conversation = {
  id: string;
  name: string;
  phone: string;
  message: string;
  time: string;
  avatarLabel: string;
  source?: "conversation" | "campaign-recipient";
  fallbackMessages?: Message[];
};

type ConversationRow = {
  id: string;
  contact_name: string;
  phone_number: string;
  last_message_text: string | null;
  last_message_at: string | null;
};

type MessageRow = {
  id: string;
  body: string;
  direction: "inbound" | "outbound";
  status: "sent" | "delivered" | "read" | "failed";
  sent_at: string;
};

type ContactRow = {
  id: string;
  name: string | null;
  phone_number: string;
  created_at?: string | null;
};

type CampaignOutcomeRow = {
  contact_id?: string | null;
  phone_number?: string | null;
  status?: string | null;
  error?: string | null;
  provider_message_id?: string | null;
  message_text?: string | null;
  rendered_message?: string | null;
};

type LocalCampaignRow = {
  id: string;
  name: string;
  template_id?: string | null;
  template_name?: string | null;
  template_structure?: {
    previewBody?: string | null;
  } | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  outcomes?: CampaignOutcomeRow[] | null;
};

type LocalAudienceContactRow = {
  id: string;
  name: string;
  phone: string;
};

type LocalTemplateRow = {
  id: string;
  name?: string | null;
  normalized_name?: string | null;
  body?: string | null;
  template_name?: string | null;
  body_text?: string | null;
  content?: string | null;
};

const shouldUseLocalCampaignBackend = () =>
  typeof window !== "undefined" && /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname);

function formatTime(value: string | null) {
  if (!value) return "";

  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatDatePill(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function normalizeTemplateLookupName(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function renderFallbackTemplateBody(body: string, contactName: string) {
  const trimmedName = contactName.trim();
  const firstName = trimmedName.split(/\s+/)[0] || trimmedName || "there";
  const fullName = trimmedName || firstName;

  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, fullName)
    .replace(/\{\s*name\s*\}/gi, fullName)
    .replace(/\{\{\s*phone_number\s*\}\}/gi, "your number")
    .replace(/\{\{\s*email\s*\}\}/gi, "your email");
}

function normalizeConversationPhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function isMissingWhatsappTableError(error: unknown) {
  const message = String((error as { message?: string } | null)?.message || "").toLowerCase();
  return (
    message.includes("does not exist") ||
    message.includes("relation") ||
    message.includes("schema cache") ||
    message.includes("could not find the table")
  );
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    name: row.contact_name,
    phone: row.phone_number,
    message: row.last_message_text ?? "",
    time: formatTime(row.last_message_at),
    avatarLabel: row.contact_name.trim().charAt(0).toUpperCase(),
  };
}

function mapContactToConversation(row: ContactRow): Conversation {
  const name = String(row.name || row.phone_number || "").trim() || row.phone_number;
  return {
    id: `contact-${row.id}`,
    name,
    phone: row.phone_number,
    message: "",
    time: "",
    avatarLabel: name.trim().charAt(0).toUpperCase() || "#",
  };
}

function mergeConversationsWithContacts(conversations: Conversation[], contacts: ContactRow[]) {
  const merged = [...conversations];
  const seenPhones = new Set(
    conversations.map((conversation) => normalizeConversationPhone(conversation.phone)).filter(Boolean),
  );

  for (const contact of contacts) {
    const normalizedPhone = normalizeConversationPhone(contact.phone_number);
    if (!normalizedPhone || seenPhones.has(normalizedPhone)) continue;
    merged.push(mapContactToConversation(contact));
    seenPhones.add(normalizedPhone);
  }

  return merged;
}

function createFallbackMessage(
  conversationId: string,
  messageBody: string,
  timestamp: string,
  status: "sent" | "delivered" | "read" | "failed",
) {
  return mapMessages([
    {
      id: `${conversationId}-${timestamp}`,
      body: messageBody,
      direction: "outbound",
      status,
      sent_at: timestamp,
    },
  ]);
}

function mapMessages(rows: MessageRow[]): Message[] {
  let previousDate = "";

  return rows.map((row) => {
    const currentDate = new Date(row.sent_at).toDateString();
    const message: Message = {
      id: row.id,
      body: row.body,
      time: formatTime(row.sent_at),
      sentAt: row.sent_at,
      outgoing: row.direction === "outbound",
      status: row.status,
    };

    if (currentDate !== previousDate) {
      message.date = formatDatePill(row.sent_at);
      previousDate = currentDate;
    }

    return message;
  });
}

function DatePill({ children }: { children: string }) {
  return (
    <div className="flex justify-center py-5">
      <div className="rounded-full bg-[#dff2ff] px-4 py-1.5 text-[13px] font-medium text-[#4b5563] shadow-sm">
        {children}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isOutgoing = Boolean(message.outgoing);
  const statusColor =
    message.status === "read"
      ? "text-[#2563eb]"
      : message.status === "failed"
        ? "text-[#dc2626]"
        : "text-[#98a2b3]";

  return (
    <div className={`flex ${isOutgoing ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "relative max-w-[340px] rounded-[16px] px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.08)]",
          isOutgoing ? "bg-[#d8ffc9]" : "bg-white",
        ].join(" ")}
      >
        {isOutgoing ? (
          <span className="absolute right-0 top-0 h-0 w-0 border-l-[14px] border-t-[14px] border-l-transparent border-t-[#edfddf]" />
        ) : (
          <span className="absolute left-0 top-0 h-0 w-0 -translate-x-[12px] border-r-[14px] border-t-[14px] border-r-white border-t-transparent" />
        )}

        <div className={`whitespace-pre-line text-[14px] leading-8 ${isOutgoing ? "text-[#10223d]" : "text-[#0f172a]"}`}>
          {message.body}
        </div>

        <div className="mt-1.5 flex items-center justify-end gap-1 text-[12px] text-[#98a2b3]">
          <span>{message.time}</span>
          {isOutgoing ? <CheckCheck className={`h-4 w-4 ${statusColor}`} /> : null}
        </div>
      </div>
    </div>
  );
}

export default function WhatsAppChats() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canUseWhatsappChatTables =
    supportsWhatsappTable("whatsapp_conversations") && supportsWhatsappTable("whatsapp_messages");
  const [loadWarning] = useState(
    !canUseWhatsappChatTables
      ? "WhatsApp chat tables are not deployed in production yet. This page is in read-only fallback mode."
      : null,
  );
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [fallbackMessagesByConversation, setFallbackMessagesByConversation] = useState<Record<string, Message[]>>({});
  const [actionConversationId, setActionConversationId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState<Conversation | null>(null);
  const [hiddenConversationIds, setHiddenConversationIds] = useState<string[]>([]);
  const longPressTimeoutRef = useRef<number | null>(null);

  const { data: conversations = [], isLoading: conversationsLoading } = useQuery({
    queryKey: ["whatsapp-conversations", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<Conversation[]> => {
      const buildFallbackConversations = (
        campaigns: LocalCampaignRow[],
        contacts: LocalAudienceContactRow[],
        templates: LocalTemplateRow[],
        conversationRows: ConversationRow[] = [],
      ) => {
        const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
        const templateBodyById = new Map(
          templates.map((template) => [
            template.id,
            String(template.body ?? template.body_text ?? template.content ?? "").trim(),
          ]),
        );
        const templateBodyByName = new Map(
          templates.map((template) => [
            normalizeTemplateLookupName(template.normalized_name ?? template.name ?? template.template_name),
            String(template.body ?? template.body_text ?? template.content ?? "").trim(),
          ]),
        );

        const recipients = new Map<string, Conversation>();

        campaigns.forEach((campaign) => {
          const outcomes = Array.isArray(campaign.outcomes) ? campaign.outcomes : [];
          const baseTimestamp = campaign.completed_at || campaign.started_at || campaign.created_at || new Date().toISOString();

          outcomes.forEach((outcome, index) => {
            const phone = String(outcome.phone_number || contactById.get(String(outcome.contact_id || ""))?.phone || "").trim();
            if (!phone) return;

            const normalizedPhone = normalizeConversationPhone(phone);
            if (!normalizedPhone) return;

            const contact = contactById.get(String(outcome.contact_id || ""));
            const name = String(contact?.name || phone).trim() || phone;
            const status = String(outcome.status || "sent").toLowerCase() === "failed" ? "failed" : "sent";
            const conversationId = `campaign-${normalizedPhone.replace(/[^\d+]/g, "")}`;
            const rawFallbackBody =
              String(
                outcome.message_text ||
                  outcome.rendered_message ||
                  (campaign.template_id ? templateBodyById.get(campaign.template_id) : "") ||
                  templateBodyByName.get(normalizeTemplateLookupName(campaign.template_name)) ||
                  campaign.template_structure?.previewBody ||
                  "",
              ).trim() || `${campaign.name} campaign sent`;
            const fallbackBody = renderFallbackTemplateBody(rawFallbackBody, name);
            const fallbackMessages = createFallbackMessage(
              `${conversationId}-${index}`,
              fallbackBody,
              baseTimestamp,
              status as "sent" | "failed",
            );

            const existing = recipients.get(normalizedPhone);
            if (!existing || new Date(baseTimestamp).getTime() > new Date(existing.fallbackMessages?.[0]?.sentAt || "1970-01-01").getTime()) {
              recipients.set(normalizedPhone, {
                id: conversationId,
                name,
                phone: normalizedPhone,
                message: fallbackMessages[fallbackMessages.length - 1]?.body ?? "Campaign sent",
                time: formatTime(baseTimestamp),
                avatarLabel: name.trim().charAt(0).toUpperCase() || "#",
                source: "campaign-recipient",
                fallbackMessages,
              });
            }
          });
        });

        const fallbackByPhone = recipients;
        const mergedConversations: Conversation[] = [];

        for (const row of conversationRows) {
          const mapped = mapConversation(row);
          const normalizedPhone = normalizeConversationPhone(mapped.phone);
          const fallback = fallbackByPhone.get(normalizedPhone);

          mergedConversations.push({
            ...mapped,
            fallbackMessages: fallback?.fallbackMessages,
          });

          if (fallback) {
            fallbackByPhone.delete(normalizedPhone);
          }
        }

        mergedConversations.push(...Array.from(fallbackByPhone.values()));
        return mergedConversations;
      };

      if (shouldUseLocalCampaignBackend()) {
        const useWhatsappTemplates = supportsWhatsappTable("whatsapp_templates");
        const [campaignsResponse, audiencesResponse, templatesResult, conversationResult, contactsResult] = await Promise.all([
          fetch(`/api/local/whatsapp-campaigns?userId=${encodeURIComponent(user!.id)}`),
          fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`),
          useWhatsappTemplates
            ? (supabase as any)
                .from("whatsapp_templates")
                .select("id, name, normalized_name, body")
                .eq("user_id", user!.id)
            : (supabase as any)
                .from("Templates")
                .select("id, template_name, body_text, content")
                .eq("user_email", user!.email ?? ""),
          canUseWhatsappChatTables
            ? (supabase as any)
                .from("whatsapp_conversations")
                .select("id, contact_name, phone_number, last_message_text, last_message_at")
                .eq("user_id", user!.id)
                .order("last_message_at", { ascending: false, nullsFirst: false })
            : Promise.resolve({ data: [], error: null }),
          (supabase as any)
            .from("whatsapp_contacts")
            .select("id, name, phone_number, created_at")
            .eq("user_id", user!.id)
            .order("created_at", { ascending: false, nullsFirst: false }),
        ]);

        const campaignsPayload = campaignsResponse.ok ? await campaignsResponse.json().catch(() => null) : null;
        const audiencesPayload = audiencesResponse.ok ? await audiencesResponse.json().catch(() => null) : null;

        const campaigns = Array.isArray(campaignsPayload?.campaigns) ? (campaignsPayload.campaigns as LocalCampaignRow[]) : [];
        const contacts = Array.isArray(audiencesPayload?.contacts) ? (audiencesPayload.contacts as LocalAudienceContactRow[]) : [];
        const templates = Array.isArray(templatesResult?.data) ? (templatesResult.data as LocalTemplateRow[]) : [];

        if (conversationResult.error && !isMissingWhatsappTableError(conversationResult.error)) {
          throw conversationResult.error;
        }
        if (contactsResult.error && !isMissingWhatsappTableError(contactsResult.error)) {
          throw contactsResult.error;
        }

        const fallbackConversations = buildFallbackConversations(
          campaigns,
          contacts,
          templates,
          (conversationResult.error ? [] : conversationResult.data ?? []) as ConversationRow[],
        );
        return mergeConversationsWithContacts(
          fallbackConversations,
          (contactsResult.error ? [] : contactsResult.data ?? []) as ContactRow[],
        );
      }

      if (!canUseWhatsappChatTables) {
        const useWhatsappTemplates = supportsWhatsappTable("whatsapp_templates");
        const [templatesResult, contactsResult, audienceSegmentsResult, audienceSegmentContactsResult, campaignsResult] = await Promise.all([
          useWhatsappTemplates
            ? (supabase as any)
                .from("whatsapp_templates")
                .select("id, name, normalized_name, body")
                .eq("user_id", user!.id)
            : (supabase as any)
                .from("Templates")
                .select("id, template_name, body_text, content")
                .eq("user_email", user!.email ?? ""),
          supabase
            .from("contacts")
            .select("id, first_name, phone_number")
            .eq("user_id", user!.id)
            .order("created_at", { ascending: false }),
          (supabase as any).from("audience_segments").select("id, name").eq("user_id", user!.id).order("created_at", { ascending: false }),
          (supabase as any).from("audience_segment_contacts").select("audience_id, contact_id").eq("user_id", user!.id),
          (supabase as any).from("audience_campaigns").select("*").eq("user_id", user!.id).order("created_at", { ascending: false }),
        ]);

        if (templatesResult.error) throw templatesResult.error;
        if (contactsResult.error) throw contactsResult.error;
        if (audienceSegmentsResult.error && !isMissingWhatsappTableError(audienceSegmentsResult.error)) throw audienceSegmentsResult.error;
        if (audienceSegmentContactsResult.error && !isMissingWhatsappTableError(audienceSegmentContactsResult.error)) throw audienceSegmentContactsResult.error;
        if (campaignsResult.error && !isMissingWhatsappTableError(campaignsResult.error)) throw campaignsResult.error;

        const contactBase = Array.isArray(contactsResult.data)
          ? contactsResult.data.map((contact: any) => ({
              id: String(contact.id),
              name: String(contact.first_name || contact.phone_number || "").trim(),
              phone: String(contact.phone_number || "").trim(),
            }))
          : [];
        const contactsById = new Map(contactBase.map((contact) => [contact.id, contact]));

        if (!audienceSegmentContactsResult.error && Array.isArray(audienceSegmentContactsResult.data)) {
          for (const row of audienceSegmentContactsResult.data as Array<{ contact_id?: string | null }>) {
            const contactId = String(row.contact_id || "").trim();
            if (!contactId || contactsById.has(contactId)) continue;
          }
        }

        return buildFallbackConversations(
          Array.isArray(campaignsResult.data) ? (campaignsResult.data as LocalCampaignRow[]) : [],
          contactBase,
          Array.isArray(templatesResult.data) ? (templatesResult.data as LocalTemplateRow[]) : [],
          [],
        );
      }

      const [conversationResult, contactsResult] = await Promise.all([
        (supabase as any)
          .from("whatsapp_conversations")
          .select("id, contact_name, phone_number, last_message_text, last_message_at")
          .eq("user_id", user!.id)
          .order("last_message_at", { ascending: false, nullsFirst: false }),
        (supabase as any)
          .from("whatsapp_contacts")
          .select("id, name, phone_number, created_at")
          .eq("user_id", user!.id)
          .order("created_at", { ascending: false, nullsFirst: false }),
      ]);

      if (conversationResult.error) throw conversationResult.error;
      if (contactsResult.error && !isMissingWhatsappTableError(contactsResult.error)) throw contactsResult.error;

      return mergeConversationsWithContacts(
        (conversationResult.data ?? []).map(mapConversation),
        (contactsResult.error ? [] : contactsResult.data ?? []) as ContactRow[],
      );
    },
  });

  const filteredConversations = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const visibleConversations = conversations.filter((conversation) => !hiddenConversationIds.includes(conversation.id));
    if (!normalized) return visibleConversations;
    return visibleConversations.filter(
      (conversation) =>
        conversation.name.toLowerCase().includes(normalized) ||
        conversation.phone.includes(normalized) ||
        conversation.message.toLowerCase().includes(normalized),
    );
  }, [conversations, hiddenConversationIds, query]);

  const clearLongPressTimer = () => {
    if (longPressTimeoutRef.current) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  const startLongPress = (conversation: Conversation) => {
    clearLongPressTimer();
    longPressTimeoutRef.current = window.setTimeout(() => {
      setActionConversationId(conversation.id);
    }, 550);
  };

  const openDeleteDialog = (conversation: Conversation) => {
    clearLongPressTimer();
    setActionConversationId(conversation.id);
    setDeletingConversation(conversation);
    setDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setDeletingConversation(null);
  };

  useEffect(() => {
    if (!selectedConversationId) return;

    const conversationStillExists = conversations.some((conversation) => conversation.id === selectedConversationId);
    if (!conversationStillExists) {
      setSelectedConversationId(null);
      setDraftMessage("");
    }
  }, [conversations, selectedConversationId]);

  useEffect(() => {
    return () => {
      clearLongPressTimer();
    };
  }, []);

  const selectedConversation =
    filteredConversations.find((conversation) => conversation.id === selectedConversationId) ??
    conversations.find((conversation) => conversation.id === selectedConversationId) ??
    null;

  const isContactOnlySelectedConversation = Boolean(selectedConversation?.id.startsWith("contact-"));

  const fallbackSelectedMessages = useMemo(() => {
    if (!selectedConversation) return [];
    return [
      ...(selectedConversation.fallbackMessages ?? []),
      ...(fallbackMessagesByConversation[selectedConversation.id] ?? []),
    ];
  }, [fallbackMessagesByConversation, selectedConversation]);

  const { data: selectedMessages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ["whatsapp-messages", selectedConversationId],
    enabled:
      !!selectedConversationId &&
      canUseWhatsappChatTables &&
      selectedConversation?.source !== "campaign-recipient" &&
      !isContactOnlySelectedConversation,
    queryFn: async (): Promise<Message[]> => {
      if (!canUseWhatsappChatTables) {
        return [];
      }

      const { data, error } = await (supabase as any)
        .from("whatsapp_messages")
        .select("id, body, direction, status, sent_at")
        .eq("conversation_id", selectedConversationId)
        .order("sent_at", { ascending: true });

      if (error) throw error;
      return mapMessages(data ?? []);
    },
  });

  const displayedMessages = useMemo(() => {
    const merged = [...fallbackSelectedMessages, ...selectedMessages];
    merged.sort((left, right) => new Date(left.sentAt || 0).getTime() - new Date(right.sentAt || 0).getTime());

    let previousDate = "";
    return merged.map((message) => {
      const currentDate = message.sentAt ? new Date(message.sentAt).toDateString() : "";
      const nextMessage: Message = { ...message };
      if (currentDate && currentDate !== previousDate) {
        nextMessage.date = formatDatePill(message.sentAt!);
        previousDate = currentDate;
      } else {
        delete nextMessage.date;
      }
      return nextMessage;
    });
  }, [fallbackSelectedMessages, selectedMessages]);

  useEffect(() => {
    if (!selectedConversationId || !canUseWhatsappChatTables) return;
    if (selectedConversationId.startsWith("contact-")) return;

    const channel = supabase
      .channel(`whatsapp-messages-${selectedConversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "whatsapp_messages",
          filter: `conversation_id=eq.${selectedConversationId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["whatsapp-messages", selectedConversationId] });
          void queryClient.invalidateQueries({ queryKey: ["whatsapp-conversations", user?.id] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [canUseWhatsappChatTables, queryClient, selectedConversationId, user?.id]);

  const handleSendMessage = async () => {
    if (!selectedConversation || !draftMessage.trim() || !user?.id) return;

    const messageBody = draftMessage.trim();
    setDraftMessage("");

    // Every chat sends by phone number: the function finds or creates the conversation and saves the message,
    // so contacts and campaign recipients without a saved conversation work too.
    {
      try {
        let payload: any = null;

        try {
          const { data, error } = await supabase.functions.invoke("send-whatsapp-direct-message", {
            body: {
              phoneNumber: selectedConversation.phone,
              contactName: selectedConversation.name,
              message: messageBody,
            },
          });

          if (error) {
            if (!isEdgeFunctionUnavailable(error)) {
              // Show the function's own reason (e.g. Meta's error), not "non-2xx status code".
              throw new Error((await extractEdgeFunctionError(error)) || getErrorMessage(error, "Unable to send WhatsApp message"));
            }
          } else {
            payload = data;
          }
        } catch (edgeError) {
          if (!(edgeError instanceof Error) || !isEdgeFunctionUnavailable(edgeError)) {
            throw edgeError;
          }
        }

        if (!payload) {
          const response = await fetch("/api/local/send-whatsapp-direct-message", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user.id,
              phoneNumber: selectedConversation.phone,
              contactName: selectedConversation.name,
              message: messageBody,
            }),
          });

          payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(String(payload?.error || "Unable to send WhatsApp message"));
          }
        }

        const sentAt = String(payload?.sentAt || new Date().toISOString());
        const localMessage = mapMessages([
          {
            id: String(payload?.messageId || `${selectedConversation.id}-${sentAt}`),
            body: messageBody,
            direction: "outbound",
            status: "sent",
            sent_at: sentAt,
          },
        ]);

        setFallbackMessagesByConversation((current) => ({
          ...current,
          [selectedConversation.id]: [...(current[selectedConversation.id] ?? []), ...localMessage],
        }));

        void queryClient.invalidateQueries({ queryKey: ["whatsapp-conversations", user.id] });

        const nextConversationId = String(payload?.conversationId || "").trim();
        if (nextConversationId) {
          setSelectedConversationId(nextConversationId);
          void queryClient.invalidateQueries({ queryKey: ["whatsapp-messages", nextConversationId] });
        }
        return;
      } catch (error) {
        setDraftMessage(messageBody);
        toast({
          title: "Unable to send message",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
        return;
      }
    }
  };

  const handleDeleteConversation = async () => {
    if (!user?.id || !deletingConversation) return;

    try {
      const isContactOnlyConversation = deletingConversation.id.startsWith("contact-");

      if (isContactOnlyConversation) {
        const contactId = deletingConversation.id.replace(/^contact-/, "");
        const { error } = await (supabase as any)
          .from("whatsapp_contacts")
          .delete()
          .eq("id", contactId)
          .eq("user_id", user.id);

        if (error) throw error;
      } else {
        const { error: messageDeleteError } = await (supabase as any)
          .from("whatsapp_messages")
          .delete()
          .eq("conversation_id", deletingConversation.id)
          .eq("user_id", user.id);

        if (messageDeleteError) throw messageDeleteError;

        const { error: conversationDeleteError } = await (supabase as any)
          .from("whatsapp_conversations")
          .delete()
          .eq("id", deletingConversation.id)
          .eq("user_id", user.id);

        if (conversationDeleteError) throw conversationDeleteError;
      }

      setFallbackMessagesByConversation((current) => {
        const next = { ...current };
        delete next[deletingConversation.id];
        return next;
      });

      if (selectedConversationId === deletingConversation.id) {
        setSelectedConversationId(null);
        setDraftMessage("");
      }

      setHiddenConversationIds((current) => [...current, deletingConversation.id]);
      setActionConversationId(null);
      closeDeleteDialog();
      void queryClient.invalidateQueries({ queryKey: ["whatsapp-conversations", user.id] });
      toast({
        title: "Chat deleted",
        description: `${deletingConversation.name} has been removed from Chats.`,
      });
    } catch (error) {
      toast({
        title: "Unable to delete chat",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  return (
    <DashboardLayout>
      <div className="grid h-full min-h-0 grid-cols-[440px_minmax(0,1fr)] overflow-hidden bg-white">
        <div className="flex min-h-0 flex-col border-r border-[#dfe4eb] bg-white">
          <div className="flex h-[78px] shrink-0 flex-col justify-center px-6">
            <h1 className="text-[1.9rem] font-bold tracking-tight text-[#111827]">Chats</h1>
            <p className="mt-0.5 whitespace-nowrap text-[14px] font-medium text-[#7b7690]">
              Manage your WhatsApp conversations and customer messages.
            </p>
          </div>

          <div className="min-h-0 flex-1">
            <div className="border-b border-[#eef2f7] px-4 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-[#9ca3af]" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search or start new chat"
                  aria-label="Search chats"
                  className="h-[46px] rounded-2xl border-none bg-[#f1f3f6] pl-12 pr-4 text-[14px] text-[#374151] shadow-none placeholder:text-[#9ca3af]"
                />
              </div>
            </div>

            <div>
              {filteredConversations.length ? (
                filteredConversations.map((conversation) => {
                  const active = conversation.id === selectedConversationId;

                  return (
                    <div
                      key={conversation.id}
                      onClick={() => setSelectedConversationId(conversation.id)}
                      onMouseDown={() => startLongPress(conversation)}
                      onMouseUp={clearLongPressTimer}
                      onMouseLeave={clearLongPressTimer}
                      onTouchStart={() => startLongPress(conversation)}
                      onTouchEnd={clearLongPressTimer}
                      onTouchCancel={clearLongPressTimer}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setActionConversationId(conversation.id);
                      }}
                      className={[
                        "grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-start gap-1 border-b border-[#eef2f7] px-6 py-4 text-left transition-colors",
                        active ? "bg-[#f9fafb]" : "hover:bg-[#fafafa]",
                      ].join(" ")}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedConversationId(conversation.id);
                        }
                      }}
                    >
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#171717,#171717)] text-[15px] font-bold text-white">
                        {conversation.avatarLabel}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[16px] font-semibold text-[#111827]">{conversation.name}</div>
                        <div className="truncate text-[14px] text-[#6b7280]">{conversation.message}</div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        {actionConversationId === conversation.id ? (
                          <>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDeleteDialog(conversation);
                              }}
                              className="rounded-full bg-[#fee2e2] px-3 py-1 text-[12px] font-semibold text-[#dc2626] transition-colors hover:bg-[#fecaca]"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setActionConversationId(null);
                              }}
                              className="rounded-full px-2 py-1 text-[12px] font-semibold text-[#9ca3af] transition-colors hover:bg-[#f3f4f6] hover:text-[#6b7280]"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <div className="pt-1 text-[13px] font-semibold text-[#9ca3af]">{conversation.time}</div>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="px-6 py-10 text-center">
                  <p className="text-[15px] font-semibold text-[#111827]">
                    {conversationsLoading ? "Loading conversations..." : "No conversations yet"}
                  </p>
                  <p className="mt-2 text-[13px] text-[#9ca3af]">
                    {conversationsLoading
                      ? "Fetching your WhatsApp conversations."
                      : "WhatsApp conversations will appear here once they are created."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {selectedConversation ? (
          <div className="flex min-h-0 flex-col bg-[#efe8dc]">
            <div className="flex h-[74px] shrink-0 items-center justify-between border-b border-[#d9dde4] bg-[#f8fafc] px-5">
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,#171717,#171717)] text-[15px] font-bold text-white">
                  {selectedConversation.avatarLabel}
                </div>
                <div>
                  <div className="text-[16px] font-bold text-[#111827]">{selectedConversation.name}</div>
                  <div className="text-[13px] text-[#667085]">{selectedConversation.phone}</div>
                </div>
              </div>

              <button
                type="button"
                aria-label="More chat actions"
                className="flex h-10 w-10 items-center justify-center rounded-full text-[#667085] transition-colors hover:bg-[#eef2f7]"
              >
                <MoreHorizontal className="h-6 w-6" />
              </button>
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
              style={{
                backgroundColor: "#efe8dc",
                backgroundImage:
                  "linear-gradient(rgba(201, 183, 160, 0.22) 1px, transparent 1px), linear-gradient(90deg, rgba(201, 183, 160, 0.22) 1px, transparent 1px)",
                backgroundSize: "76px 76px",
              }}
            >
              <div className="space-y-2">
                {messagesLoading ? (
                  <div className="py-10 text-center text-[13px] text-[#667085]">Loading conversation...</div>
                ) : (
                  displayedMessages.map((message) => (
                    <div key={message.id}>
                      {message.date ? <DatePill>{message.date}</DatePill> : null}
                      <MessageBubble message={message} />
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-[#dfe4eb] bg-[#f8fafc] px-5 py-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Insert emoji"
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[#6b7280] transition-colors hover:bg-[#eef2f7]"
                >
                  <Smile className="h-5 w-5" />
                </button>

                <div className="flex-1 rounded-full bg-white px-5 shadow-[inset_0_0_0_1px_#e5e7eb]">
                  <input
                    type="text"
                    value={draftMessage}
                    onChange={(event) => setDraftMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder="Type a message"
                    aria-label="Message"
                    className="h-[48px] w-full bg-transparent text-[14px] text-[#111827] outline-none placeholder:text-[#9ca3af]"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleSendMessage}
                  aria-label="Send message"
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-[linear-gradient(135deg,#171717,#171717)] text-white shadow-none transition-colors hover:bg-[linear-gradient(135deg,#171717,#171717)]"
                >
                  <Send className="h-5 w-5 fill-current" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center bg-[#f4f7fb] px-8 text-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
              <MessageCircleMore className="h-10 w-10 text-[#4cad88]" />
            </div>
            <h2 className="mt-8 text-[22px] font-medium tracking-tight text-[#4b5563]">WhatsApp Business</h2>
            <p className="mt-4 max-w-[480px] text-[13px] leading-6 text-[#9ca3af]">
              Select a conversation from the left to start messaging your customers in real time.
            </p>
            <div className="mt-7 flex items-center gap-2 text-[13px] text-[#9ca3af]">
              <Lock className="h-5 w-5 text-[#b4bdca]" />
              <span>End-to-end encrypted</span>
            </div>
          </div>
        )}
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => (!open ? closeDeleteDialog() : setDeleteDialogOpen(true))}>
        <AlertDialogContent className="sm:max-w-[430px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove {deletingConversation?.name || "this chat"} from the Chats list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={closeDeleteDialog}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteConversation();
              }}
              className="bg-[#dc2626] text-white hover:bg-[#b91c1c]"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
