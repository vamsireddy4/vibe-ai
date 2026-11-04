import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MoreVertical, Pencil, Search, Trash2, Users } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { supportsWhatsappTable } from "@/lib/whatsapp-compat";
import { parseContactsCsv } from "@/lib/contacts-csv";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type AudienceCardRecord = {
  id: string;
  name: string;
  description: string;
  tag: string;
  members: number;
  contactIds: string[];
};

type AudienceContactRecord = { id: string; name: string; phone: string };

const getLocalAudienceStorageKey = (userId: string) => `whatsapp-local-audiences:${userId}`;
const isLocalDevBrowser =
  typeof window !== "undefined" && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
const isMissingTableError = (error: any) => {
  const code = String(error?.code ?? "").trim();
  const message = String(error?.message ?? "").toLowerCase();
  return code === "PGRST205" || code === "42P01" || message.includes("schema cache") || message.includes("does not exist");
};

export default function WhatsAppAudiences() {
  const { user } = useAuth();
  const { toast } = useToast();
  const whatsappAudienceBackendReady =
    supportsWhatsappTable("whatsapp_audiences") &&
    supportsWhatsappTable("whatsapp_audience_contacts") &&
    supportsWhatsappTable("whatsapp_contacts");
  const audienceSegmentFallbackMode = !whatsappAudienceBackendReady;
  const [loadWarning] = useState(
    !whatsappAudienceBackendReady
      ? "WhatsApp audience tables are not deployed in production yet. Using contacts only fallback mode."
      : null,
  );
  const [selectedAudienceId, setSelectedAudienceId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [audienceName, setAudienceName] = useState("");
  const [description, setDescription] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [localAudiences, setLocalAudiences] = useState<AudienceCardRecord[]>([]);
  const [editingAudienceId, setEditingAudienceId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || typeof window === "undefined" || !audienceSegmentFallbackMode) return;

    try {
      const stored = window.localStorage.getItem(getLocalAudienceStorageKey(user.id));
      if (!stored) {
        setLocalAudiences([]);
        return;
      }

      const parsed = JSON.parse(stored);
      setLocalAudiences(Array.isArray(parsed) ? parsed : []);
    } catch {
      setLocalAudiences([]);
    }
  }, [user?.id, audienceSegmentFallbackMode]);

  useEffect(() => {
    if (!user?.id || typeof window === "undefined" || !audienceSegmentFallbackMode) return;
    window.localStorage.setItem(getLocalAudienceStorageKey(user.id), JSON.stringify(localAudiences));
  }, [localAudiences, user?.id, audienceSegmentFallbackMode]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["whatsapp-audiences", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<{
      audiences: AudienceCardRecord[];
      contacts: AudienceContactRecord[];
      audienceSource: "whatsapp" | "db" | "local";
    }> => {
      if (!whatsappAudienceBackendReady) {
        if (isLocalDevBrowser) {
          const response = await fetch(`/api/local/whatsapp-audience-segments?userId=${encodeURIComponent(user!.id)}`);
          if (response.ok) {
            return response.json();
          }
        }

        const contactsResult = await supabase
          .from("contacts")
          .select("id, first_name, phone_number")
          .eq("user_id", user!.id)
          .order("created_at", { ascending: false });

        if (contactsResult.error) throw contactsResult.error;

        const contacts = (contactsResult.data ?? []).map((contact) => ({
          id: contact.id,
          name: contact.first_name?.trim() || contact.phone_number,
          phone: contact.phone_number,
        }));

        const [segmentsResult, segmentContactsResult] = await Promise.all([
          (supabase as any)
            .from("audience_segments")
            .select("*")
            .eq("user_id", user!.id)
            .order("created_at", { ascending: false }),
          (supabase as any)
            .from("audience_segment_contacts")
            .select("audience_id, contact_id")
            .eq("user_id", user!.id),
        ]);

        if (segmentsResult.error || segmentContactsResult.error) {
          return {
            audiences: [],
            contacts,
            audienceSource: "local",
          };
        }

        const contactIdsByAudience = new Map<string, string[]>();
        for (const row of segmentContactsResult.data ?? []) {
          const current = contactIdsByAudience.get(row.audience_id) ?? [];
          current.push(row.contact_id);
          contactIdsByAudience.set(row.audience_id, current);
        }

        return {
          audiences: (segmentsResult.data ?? []).map((audience: any) => {
            const contactIds = contactIdsByAudience.get(audience.id) ?? [];
            return {
              id: audience.id,
              name: audience.name,
              description: audience.description ?? "",
              tag: audience.tag ?? "WhatsApp Segment",
              members: contactIds.length,
              contactIds,
            };
          }),
          contacts,
          audienceSource: "db",
        };
      }

      const [audiencesResult, audienceContactsResult, contactsResult] = await Promise.all([
        (supabase as any).from("whatsapp_audiences").select("*").eq("user_id", user!.id).order("created_at", { ascending: false }),
        (supabase as any).from("whatsapp_audience_contacts").select("audience_id, contact_id").eq("user_id", user!.id),
        (supabase as any)
          .from("whatsapp_contacts")
          .select("id, name, phone_number")
          .eq("user_id", user!.id)
          .order("created_at", { ascending: false }),
      ]);

      if (audiencesResult.error) throw audiencesResult.error;
      if (audienceContactsResult.error) throw audienceContactsResult.error;
      if (contactsResult.error) throw contactsResult.error;

      const contacts = (contactsResult.data ?? []).map((contact) => ({
        id: contact.id,
        name: contact.name?.trim() || contact.phone_number,
        phone: contact.phone_number,
      }));

      const contactIdsByAudience = new Map<string, string[]>();
      for (const row of audienceContactsResult.data ?? []) {
        const current = contactIdsByAudience.get(row.audience_id) ?? [];
        current.push(row.contact_id);
        contactIdsByAudience.set(row.audience_id, current);
      }

      const audiences = (audiencesResult.data ?? []).map((audience: any) => {
        const contactIds = contactIdsByAudience.get(audience.id) ?? [];
        return {
          id: audience.id,
          name: audience.name,
          description: audience.description ?? "",
          tag: "WhatsApp Segment",
          members: contactIds.length,
          contactIds,
        };
      });

      return { audiences, contacts, audienceSource: "whatsapp" };
    },
  });

  const audiences = data?.audienceSource === "local" ? localAudiences : (data?.audiences ?? []);
  const contacts = data?.contacts ?? [];

  const filteredContacts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return contacts;

    return contacts.filter((contact) =>
      `${contact.name} ${contact.phone}`.toLowerCase().includes(query),
    );
  }, [contacts, searchQuery]);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const importCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // the same file can be picked again
    if (!file || !user) return;
    setImporting(true);
    try {
      const { contacts: rows, error } = parseContactsCsv(await file.text());
      if (error) throw new Error(error);
      const { data: saved, error: saveError } = await (supabase as any)
        .from("whatsapp_contacts")
        .upsert(
          rows.map((c) => ({ user_id: user.id, name: c.name, phone_number: c.phone, email: c.email ?? null, metadata: c.email ? { email: c.email } : {} })),
          { onConflict: "user_id,phone_number" },
        )
        .select("id");
      if (saveError) throw saveError;
      await refetch();
      const ids: string[] = (saved ?? []).map((r: { id: string }) => r.id);
      setSelectedContactIds((current) => [...new Set([...current, ...ids])]);
      toast({ title: "Contacts imported", description: `${ids.length} contact(s) saved to WhatsApp contacts and selected for this audience.` });
    } catch (e) {
      toast({ title: "Couldn't import the CSV", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const selectedAudience = useMemo(
    () => audiences.find((audience) => audience.id === selectedAudienceId) ?? null,
    [audiences, selectedAudienceId],
  );
  const editingAudience = useMemo(
    () => audiences.find((audience) => audience.id === editingAudienceId) ?? null,
    [audiences, editingAudienceId],
  );

  const usingLocalAudienceSource = data?.audienceSource === "local";

  const toggleContact = (contactId: string) => {
    setSelectedContactIds((current) =>
      current.includes(contactId) ? current.filter((id) => id !== contactId) : [...current, contactId],
    );
  };

  const resetForm = () => {
    setAudienceName("");
    setDescription("");
    setSearchQuery("");
    setSelectedContactIds([]);
    setEditingAudienceId(null);
  };

  const openCreateDialog = () => {
    resetForm();
    setCreateDialogOpen(true);
  };

  const openEditDialog = (audience: AudienceCardRecord) => {
    setEditingAudienceId(audience.id);
    setAudienceName(audience.name);
    setDescription(audience.description);
    setSearchQuery("");
    setSelectedContactIds([...audience.contactIds]);
    setCreateDialogOpen(true);
  };

  const handleDeleteAudience = (audience: AudienceCardRecord) => {
    void (async () => {
      if (!user?.id) return;

      if (usingLocalAudienceSource) {
        setLocalAudiences((current) => current.filter((item) => item.id !== audience.id));
        if (selectedAudienceId === audience.id) setSelectedAudienceId(null);
        toast({
          title: "Audience deleted",
          description: "Removed from local fallback storage.",
        });
        return;
      }

      const isWhatsappSource = data?.audienceSource === "whatsapp";

      if (!isWhatsappSource && isLocalDevBrowser) {
        const response = await fetch("/api/local/whatsapp-audience-segments", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: user.id,
            audienceId: audience.id,
          }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          toast({
            title: "Unable to delete audience",
            description: String(payload?.error || "Unknown server error."),
            variant: "destructive",
          });
          return;
        }

        if (selectedAudienceId === audience.id) setSelectedAudienceId(null);
        await refetch();
        toast({
          title: "Audience deleted",
          description: "Removed from the database.",
        });
        return;
      }

      const audienceTable = isWhatsappSource ? "whatsapp_audiences" : "audience_segments";
      const audienceContactsTable = isWhatsappSource ? "whatsapp_audience_contacts" : "audience_segment_contacts";

      const { error: unlinkError } = await (supabase as any)
        .from(audienceContactsTable)
        .delete()
        .eq("user_id", user.id)
        .eq("audience_id", audience.id);

      if (unlinkError) {
        toast({
          title: "Unable to delete audience",
          description: unlinkError.message,
          variant: "destructive",
        });
        return;
      }

      const { error: deleteError } = await (supabase as any)
        .from(audienceTable)
        .delete()
        .eq("user_id", user.id)
        .eq("id", audience.id);

      if (deleteError) {
        toast({
          title: "Unable to delete audience",
          description: deleteError.message,
          variant: "destructive",
        });
        return;
      }

      if (selectedAudienceId === audience.id) setSelectedAudienceId(null);
      await refetch();
      toast({
        title: "Audience deleted",
        description: "Removed from the database.",
      });
    })();
  };

  const handleCreateAudience = () => {
    void (async () => {
      const trimmedName = audienceName.trim();
      if (!trimmedName || !user?.id) return;
      const isEditing = !!editingAudienceId;

      if (!whatsappAudienceBackendReady) {
        if (usingLocalAudienceSource) {
          const nextAudience: AudienceCardRecord = {
            id: editingAudienceId ?? crypto.randomUUID(),
            name: trimmedName,
            description: description.trim(),
            tag: "WhatsApp Segment",
            members: selectedContactIds.length,
            contactIds: [...selectedContactIds],
          };

          setLocalAudiences((current) =>
            isEditing
              ? current.map((audience) => (audience.id === nextAudience.id ? nextAudience : audience))
              : [nextAudience, ...current],
          );
          setSelectedAudienceId(nextAudience.id);
          setCreateDialogOpen(false);
          resetForm();
          toast({
            title: isEditing ? "Audience updated" : "Audience created",
            description: "Saved to local fallback storage.",
          });
          return;
        }

        setCreating(true);
        if (isLocalDevBrowser) {
          const response = await fetch("/api/local/whatsapp-audience-segments", {
            method: isEditing ? "PATCH" : "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: user.id,
              audienceId: editingAudienceId,
              name: trimmedName,
              description: description.trim(),
              contactIds: selectedContactIds,
            }),
          });

          const payload = await response.json().catch(() => ({}));
          setCreating(false);

          if (!response.ok) {
            toast({
              title: isEditing ? "Unable to update audience" : "Unable to create audience",
              description: String(payload?.error || "Unknown server error."),
              variant: "destructive",
            });
            return;
          }

          void refetch();
          if (payload?.id) setSelectedAudienceId(String(payload.id));
          setCreateDialogOpen(false);
          resetForm();
          toast({
            title: isEditing ? "Audience updated" : "Audience created",
            description: "Saved to the database.",
          });
          return;
        }

        let audienceRow: { id: string } | null = null;
        let audienceError: any = null;

        if (isEditing) {
          const result = await (supabase as any)
            .from("audience_segments")
            .update({
              name: trimmedName,
              description: description.trim(),
              tag: "WhatsApp Segment",
            })
            .eq("user_id", user.id)
            .eq("id", editingAudienceId)
            .select("id")
            .single();
          audienceRow = result.data ?? null;
          audienceError = result.error;
        } else {
          const result = await (supabase as any)
            .from("audience_segments")
            .insert({
              user_id: user.id,
              name: trimmedName,
              description: description.trim(),
              tag: "WhatsApp Segment",
            })
            .select("id")
            .single();
          audienceRow = result.data ?? null;
          audienceError = result.error;
        }

        if (!audienceError && audienceRow) {
          if (isEditing) {
            const { error: deleteLinksError } = await (supabase as any)
              .from("audience_segment_contacts")
              .delete()
              .eq("user_id", user.id)
              .eq("audience_id", audienceRow.id);

            if (deleteLinksError) {
              setCreating(false);
              toast({
                title: "Audience updated, but contacts were not refreshed",
                description: deleteLinksError.message,
                variant: "destructive",
              });
              return;
            }
          }

          if (selectedContactIds.length > 0) {
            const { error: linkError } = await (supabase as any).from("audience_segment_contacts").insert(
              selectedContactIds.map((contactId) => ({
                user_id: user.id,
                audience_id: audienceRow.id,
                contact_id: contactId,
              })),
            );

            if (linkError) {
              setCreating(false);
              toast({
                title: isEditing ? "Audience updated, but contacts were not linked" : "Audience created, but contacts were not linked",
                description: linkError.message,
                variant: "destructive",
              });
              return;
            }
          }

          setCreating(false);
          void refetch();
          setSelectedAudienceId(audienceRow.id);
          setCreateDialogOpen(false);
          resetForm();
          toast({
            title: isEditing ? "Audience updated" : "Audience created",
            description: "Saved to the database.",
          });
          return;
        }

        if (isMissingTableError(audienceError)) {
          const localAudience: AudienceCardRecord = {
            id: crypto.randomUUID(),
            name: trimmedName,
            description: description.trim(),
            tag: "WhatsApp Segment",
            members: selectedContactIds.length,
            contactIds: [...selectedContactIds],
          };

          setLocalAudiences((current) => [localAudience, ...current]);
          setSelectedAudienceId(localAudience.id);
          setCreateDialogOpen(false);
          resetForm();
          toast({
            title: isEditing ? "Audience updated" : "Audience created",
            description: "Audience fallback tables are not deployed yet, so this was saved locally for now.",
          });
          return;
        }

        setCreating(false);
        toast({
          title: "Unable to create audience",
          description: audienceError?.message ?? "Unknown database error.",
          variant: "destructive",
        });
        return;
      }

      setCreating(true);
      let audienceRow: { id: string } | null = null;
      let audienceError: any = null;

      if (isEditing) {
        const result = await (supabase as any)
          .from("whatsapp_audiences")
          .update({
            name: trimmedName,
            description: description.trim(),
          })
          .eq("user_id", user.id)
          .eq("id", editingAudienceId)
          .select("id")
          .single();
        audienceRow = result.data ?? null;
        audienceError = result.error;
      } else {
        const result = await (supabase as any)
          .from("whatsapp_audiences")
          .insert({
            user_id: user.id,
            name: trimmedName,
            description: description.trim(),
          })
          .select("id")
          .single();
        audienceRow = result.data ?? null;
        audienceError = result.error;
      }

      if (audienceError) {
        setCreating(false);
        toast({
          title: "Unable to create audience",
          description: audienceError.message,
          variant: "destructive",
        });
        return;
      }

      if (isEditing) {
        const { error: deleteLinksError } = await (supabase as any)
          .from("whatsapp_audience_contacts")
          .delete()
          .eq("user_id", user.id)
          .eq("audience_id", audienceRow.id);

        if (deleteLinksError) {
          setCreating(false);
          toast({
            title: "Audience updated, but contacts were not refreshed",
            description: deleteLinksError.message,
            variant: "destructive",
          });
          return;
        }
      }

      if (selectedContactIds.length > 0) {
        const { error: linkError } = await (supabase as any).from("whatsapp_audience_contacts").insert(
          selectedContactIds.map((contactId) => ({
            user_id: user.id,
            audience_id: audienceRow.id,
            contact_id: contactId,
          })),
        );

        if (linkError) {
          setCreating(false);
          toast({
            title: isEditing ? "Audience updated, but contacts were not linked" : "Audience created, but contacts were not linked",
            description: linkError.message,
            variant: "destructive",
          });
          return;
        }
      }

      setCreating(false);
      void refetch();
      setSelectedAudienceId(audienceRow.id);
      setCreateDialogOpen(false);
      resetForm();
      toast({
        title: isEditing ? "Audience updated" : "Audience created",
        description: "Saved to the database.",
      });
    })();
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 text-[#111827]">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-[2.15rem] font-bold tracking-tight text-[#111827]">Audiences</h1>
            <p className="mt-1 text-[13px] font-medium text-[#6b7280] md:text-[14px]">
              Create segments to target specific groups of contacts
            </p>
          </div>

          <Button
            onClick={openCreateDialog}
            className="h-11 rounded-[15px] bg-[#171717] px-6 text-[15px] font-semibold text-white shadow-[0_10px_20px_rgba(23,23,23,0.15)] hover:bg-[#171717]"
          >
            Create Audience
          </Button>
        </div>

        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {audiences.length ? (
            audiences.map((audience) => (
              <div
                key={audience.id}
                onClick={() => setSelectedAudienceId(audience.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedAudienceId(audience.id);
                  }
                }}
                role="button"
                tabIndex={0}
                className={`max-w-[430px] rounded-[20px] border bg-white px-6 py-6 text-left shadow-[0_6px_24px_rgba(15,23,42,0.05)] transition-all ${
                  selectedAudienceId === audience.id ? "border-[#e4e4e7]" : "border-[#f4f4f5] hover:border-[#e4e4e7]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <h2 className="text-[17px] font-bold tracking-tight text-[#111827]">{audience.name}</h2>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
                      <div
                        role="button"
                        tabIndex={0}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[#111827] transition-colors hover:bg-[#fafafa]"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditDialog(audience);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-[#ef4444] focus:text-[#ef4444]"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteAudience(audience);
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {audience.description ? (
                  <p className="mt-4 line-clamp-2 text-[14px] leading-6 text-[#6b7280]">{audience.description}</p>
                ) : (
                  <div className="mt-5 h-[34px]" />
                )}

                <div className="mt-6 flex items-center gap-2.5 text-[14px] font-medium text-[#6b7280]">
                  <Users className="h-4 w-4" />
                  <span>{audience.members} members</span>
                </div>
              </div>
            ))
          ) : (
            <div className="max-w-[430px] rounded-[20px] border border-[#f4f4f5] bg-white px-6 py-8 text-left shadow-[0_6px_24px_rgba(15,23,42,0.05)]">
              <h2 className="text-[17px] font-bold tracking-tight text-[#111827]">
                {isLoading ? "Loading audiences..." : "No audiences yet"}
              </h2>
              <p className="mt-3 text-[14px] leading-6 text-[#6b7280]">
                {isLoading
                  ? "Fetching your WhatsApp audience segments."
                  : "Create your first audience segment and it will appear here."}
              </p>
            </div>
          )}
        </div>

        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden border-[#d8dbe4] bg-white p-0 shadow-2xl sm:max-w-[760px]">
            <DialogHeader className="border-b border-[#e6e9f0] px-7 py-5">
              <DialogTitle className="text-[18px] font-semibold tracking-tight text-[#111827]">
                {editingAudience ? "Edit Audience" : "Create Audience"}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {editingAudience ? "Edit a WhatsApp audience by updating its contacts." : "Create a WhatsApp audience by selecting contacts."}
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              <div className="space-y-6">
                <div className="space-y-2.5">
                  <label className="text-[14px] font-semibold text-[#364152]">
                    Audience Name <span className="text-[#111827]">*</span>
                  </label>
                  <Input
                    value={audienceName}
                    onChange={(event) => setAudienceName(event.target.value)}
                    placeholder="e.g., Downtown Residents"
                    className="h-12 rounded-[14px] border-[#cfd5df] px-6 text-[15px] placeholder:text-[#98a2b3]"
                  />
                </div>

                <div className="space-y-2.5">
                  <label className="text-[14px] font-semibold text-[#364152]">Description</label>
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Brief description of this audience segment"
                    className="min-h-[98px] rounded-[14px] border-[#cfd5df] px-6 py-4 text-[15px] placeholder:text-[#98a2b3]"
                  />
                </div>

                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[14px] font-semibold text-[#364152]">Audience List</h3>
                      <p className="mt-1.5 text-[13px] text-[#667085]">
                        Select contacts ({selectedContactIds.length} selected)
                      </p>
                    </div>

                    <div className="flex items-center gap-3 text-[13px] font-semibold text-[#2563eb]">
                      <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={importCsv} aria-label="Choose a CSV file of contacts" />
                      <button type="button" onClick={() => csvInputRef.current?.click()} disabled={importing}>
                        {importing ? "Importing…" : "Import CSV"}
                      </button>
                    </div>
                  </div>

                  <div className="relative">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-[#98a2b3]" />
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search contacts..."
                      className="h-12 rounded-[14px] border-[#cfd5df] pl-14 pr-5 text-[15px] placeholder:text-[#98a2b3]"
                    />
                  </div>

                  <div className="rounded-[14px] border border-[#cfd5df] bg-white px-4 py-3.5">
                    {filteredContacts.length ? (
                      <div className="space-y-4">
                        {filteredContacts.map((contact) => (
                          <label key={contact.id} className="flex items-start gap-3">
                            <Checkbox
                              checked={selectedContactIds.includes(contact.id)}
                              onCheckedChange={() => toggleContact(contact.id)}
                              className="mt-0.5 h-5 w-5 rounded-[4px] border-[#7b7f87]"
                            />
                            <div className="space-y-1">
                              <div className="text-[13px] font-semibold text-[#111827]">{contact.name}</div>
                              <div className="text-[13px] text-[#667085]">{contact.phone}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="py-4 text-center">
                        <p className="text-[13px] font-semibold text-[#111827]">No contacts available</p>
                        <p className="mt-1 text-[13px] text-[#667085]">
                          Connect real contacts to build audiences from this dialog.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex items-center gap-3 border-t border-[#e6e9f0] bg-white px-7 py-4">
              <Button
                onClick={handleCreateAudience}
                disabled={creating}
                className="h-[44px] rounded-[13px] bg-[#171717] px-6 text-[14px] font-semibold text-white hover:bg-[#171717]"
              >
                {creating ? (editingAudience ? "Saving..." : "Creating...") : editingAudience ? "Save Changes" : "Create Audience"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
                className="h-[44px] rounded-[13px] border-[#cfd5df] px-5 text-[14px] font-semibold text-[#344054]"
              >
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(selectedAudience)} onOpenChange={(open) => !open && setSelectedAudienceId(null)}>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-[#d8dbe4] bg-white p-0 shadow-2xl sm:max-w-[620px]">
            <DialogHeader className="border-b border-[#e6e9f0] px-7 py-5">
              <DialogTitle className="text-[18px] font-semibold tracking-tight text-[#111827]">
                {selectedAudience?.name ?? "Audience Details"}
              </DialogTitle>
              <DialogDescription className="sr-only">Audience details and selected contacts.</DialogDescription>
            </DialogHeader>

            {selectedAudience ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex rounded-full bg-[#171717] px-3 py-1.5 text-[13px] font-medium text-white shadow-[0_8px_16px_rgba(23,23,23,0.14)]">
                      {selectedAudience.tag}
                    </div>
                    <div className="flex items-center gap-2 text-[14px] font-medium text-[#6b7280]">
                      <Users className="h-4 w-4" />
                      <span>{selectedAudience.members} members</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8b84a1]">Description</div>
                    <div className="rounded-[14px] border border-[#f4f4f5] bg-[#fafafa] px-4 py-3 text-[14px] leading-6 text-[#6b7280]">
                      {selectedAudience.description || "No description added."}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8b84a1]">Contacts</div>
                    <div className="space-y-3">
                      {contacts.filter((contact) => selectedAudience.contactIds.includes(contact.id)).length ? (
                        contacts
                          .filter((contact) => selectedAudience.contactIds.includes(contact.id))
                          .map((contact) => (
                            <div
                              key={contact.id}
                              className="rounded-[14px] border border-[#f4f4f5] bg-white px-4 py-3"
                            >
                              <div className="text-[14px] font-semibold text-[#111827]">{contact.name}</div>
                              <div className="mt-1 text-[13px] text-[#6b7280]">{contact.phone}</div>
                            </div>
                          ))
                      ) : (
                        <div className="rounded-[14px] border border-[#f4f4f5] bg-white px-4 py-4 text-[13px] text-[#6b7280]">
                          No linked contacts yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
