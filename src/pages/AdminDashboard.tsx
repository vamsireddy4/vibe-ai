import { getClerkToken } from "@/integrations/supabase/client";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Building2, Crown, Search, Trash2, Users, Timer } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_EMAIL } from "@/lib/constants";
import { ALL_VIBE_SPACES, type VibeSpace } from "@/lib/vibe-routes";
import { useLiveMinuteBalance } from "@/hooks/useLiveMinuteBalance";

type AdminClient = {
  user_id: string;
  email: string;
  full_name: string | null;
  company_name: string | null;
  enterprise_interest: boolean;
  available_seconds: number;
  enterprise_rate_per_minute: number | null;
  last_enterprise_amount: number | null;
  last_enterprise_minutes: number | null;
  enabled_spaces: VibeSpace[];
  requested_spaces: VibeSpace[];
  agency_email: string | null;
  agency_code?: string | null;
};

type AgencyGrant = {
  id: string;
  email: string;
  is_active: boolean;
  agency_code?: string;
  granted_by: string;
  created_at: string;
  updated_at: string;
  client_rate_per_minute?: number;
  wholesale_rate_per_minute?: number;
  custom_checkout_url?: string | null;
  payment_instruction?: string | null;
};
const spaceLabels: Record<VibeSpace, string> = {
  voice: "Vibe AI Voice",
  sms: "Vibe AI SMS",
  whatsapp: "Vibe AI WhatsApp",
  gmail: "Vibe AI Email",
};

// Clerk session token (the local admin routes verify it; supabase.auth is off with Clerk).
async function getAccessToken() {
  const accessToken = await getClerkToken();
  if (!accessToken) throw new Error("Your session expired. Please sign in again.");
  return accessToken;
}

async function callAdminFunction<T>(name: string, body?: Record<string, unknown>): Promise<T> {
  if (["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    const localNameMap: Record<string, string> = {
      "admin-list-clients": "admin-list-clients",
      "admin-list-agencies": "admin-list-agencies",
      "admin-upsert-agency-access": "admin-upsert-agency-access",
      "admin-revoke-agency-access": "admin-revoke-agency-access",
      "admin-update-client-enterprise": "admin-update-client-enterprise",
      "admin-dismiss-enterprise": "admin-dismiss-enterprise",
      "admin-update-client-spaces": "admin-update-client-spaces",
    };
    const localName = localNameMap[name];
    if (localName) {
      const accessToken = await getAccessToken().catch(() => null);
      const response = await fetch(`/api/local/${localName}`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
        },
        body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || payload?.details || `Local function ${name} failed`);
      }
      return payload as T;
    }
  }

  const invoke = async (accessToken: string) => {
    // The Edge Functions run on this site's Cloudflare deployment (/fn/<name>), like supabase.functions.invoke.
    const response = await fetch(`${window.location.origin}/fn/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        ...(body ?? {}),
        access_token: accessToken,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  };

  let accessToken = await getAccessToken();
  let { response, payload } = await invoke(accessToken);

  if (response.status === 401) {
    // Clerk tokens are short-lived; getClerkToken() hands out a fresh one.
    accessToken = await getAccessToken();
    ({ response, payload } = await invoke(accessToken));
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.details || `Function ${name} failed`);
  }

  return payload as T;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [dismissingUserId, setDismissingUserId] = useState<string | null>(null);
  const [clientToDismiss, setClientToDismiss] = useState<AdminClient | null>(null);
  const [selectedClient, setSelectedClient] = useState<AdminClient | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"clients" | "enterprise" | "agency">("clients");
  const [clients, setClients] = useState<AdminClient[]>([]);
  const [agencies, setAgencies] = useState<AgencyGrant[]>([]);
  const [agencyEmailDraft, setAgencyEmailDraft] = useState("");
  const [agencyWholesaleRateDraft, setAgencyWholesaleRateDraft] = useState("0.10");
  const [savingAgency, setSavingAgency] = useState(false);
  const [revokingAgencyId, setRevokingAgencyId] = useState<string | null>(null);
  const [spaceDraft, setSpaceDraft] = useState<Record<VibeSpace, boolean>>({
    voice: true,
    sms: true,
    whatsapp: true,
    gmail: true,
  });
  const [drafts, setDrafts] = useState<Record<string, { enterprise_rate_per_minute: string; purchase_amount: string }>>({});
  const [isAgency, setIsAgency] = useState(false);
  const [agencyCode, setAgencyCode] = useState<string | null>(null);
  const [minutesToTransfer, setMinutesToTransfer] = useState("");
  const [agencyMinutesDrafts, setAgencyMinutesDrafts] = useState<Record<string, string>>({});
  const [transferring, setTransferring] = useState(false);
  const [clientAgencyDraft, setClientAgencyDraft] = useState<string>("");

  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  useEffect(() => {
    if (!user?.email || isAdmin) {
      setIsAgency(false);
      return;
    }
    const checkAgency = async () => {
      try {
        const { data, error } = await supabase
          .from("agency_access_grants")
          .select("is_active, agency_code")
          .eq("email", user.email.toLowerCase().trim())
          .maybeSingle();

        if (!error && data?.is_active) {
          setIsAgency(true);
          if (data.agency_code) {
            setAgencyCode(data.agency_code);
          } else {
            // Generate a fresh 6-digit random code and save it
            const generateRandomCode = () => {
              const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
              let res = "";
              for (let i = 0; i < 6; i++) {
                res += chars.charAt(Math.floor(Math.random() * chars.length));
              }
              return res;
            };
            const freshCode = generateRandomCode();
            const { error: updateError } = await supabase
              .from("agency_access_grants")
              .update({ agency_code: freshCode })
              .eq("email", user.email.toLowerCase().trim());
            
            if (!updateError) {
              setAgencyCode(freshCode);
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
    };
    void checkAgency();
  }, [user, isAdmin]);

  const { liveAvailableSeconds: agencySeconds } = useLiveMinuteBalance(
    isAgency ? user?.id : undefined,
    false,
    user?.email
  );
  const agencyMinutes = agencySeconds != null ? Math.max(0, Math.floor(agencySeconds / 60)) : 0;

  const loadClients = async () => {
    if (!isAdmin && !isAgency) return;
    setLoading(true);
    try {
      const data = await callAdminFunction<{ clients: AdminClient[] }>("admin-list-clients");
      setClients(
        data.clients.map((client) => ({
          ...client,
          requested_spaces: Array.isArray(client.requested_spaces) ? client.requested_spaces : [],
        })),
      );
      setDrafts(
        Object.fromEntries(
          data.clients.map((client) => [
            client.user_id,
            {
              enterprise_rate_per_minute:
                client.enterprise_rate_per_minute != null ? String(client.enterprise_rate_per_minute) : "0.10",
              purchase_amount: client.last_enterprise_amount != null ? String(client.last_enterprise_amount) : "",
            },
          ]),
        ),
      );
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to load clients.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const loadAgencies = async () => {
    if (!isAdmin && !isAgency) return;
    try {
      const data = await callAdminFunction<{ agencies: AgencyGrant[] }>("admin-list-agencies");
      setAgencies(Array.isArray(data.agencies) ? data.agencies : []);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to load agencies.",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (isAdmin || isAgency) {
      void loadClients();
      void loadAgencies();
    }
  }, [isAdmin, isAgency]);

  // Redirect Agency user to /agency/dashboard if they land on /admin/dashboard
  useEffect(() => {
    if (isAgency && location.pathname === "/admin/dashboard") {
      navigate("/agency/dashboard", { replace: true });
    }
  }, [isAgency, location.pathname, navigate]);

  // Redirect Admin user to /admin/dashboard if they land on /agency/dashboard
  useEffect(() => {
    if (isAdmin && location.pathname === "/agency/dashboard") {
      navigate("/admin/dashboard", { replace: true });
    }
  }, [isAdmin, location.pathname, navigate]);

  const filteredClients = useMemo(() => {
    if (viewMode === "agency") return [];
    const normalized = query.trim().toLowerCase();
    
    let baseClients =
      viewMode === "enterprise"
        ? clients.filter((client) => client.enterprise_interest)
        : clients.filter((client) => !client.enterprise_interest);

    // If the logged in user is the Super Admin (isAdmin) and we are viewing "enterprise" requests,
    // only show clients who do not have any referring agency (direct admin clients).
    if (isAdmin && viewMode === "enterprise") {
      baseClients = baseClients.filter((client) => !client.agency_email && !client.agency_code);
    }

    if (!normalized) return baseClients;

    return baseClients.filter((client) =>
      [client.email, client.full_name ?? "", client.company_name ?? ""].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    );
  }, [clients, query, viewMode, isAdmin]);

  const filteredAgencies = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let activeAgencies = agencies.filter((agency) => agency.is_active);

    if (isAgency && user?.email) {
      activeAgencies = activeAgencies.filter(
        (agency) => agency.email.toLowerCase() !== user.email.toLowerCase()
      );
    }

    if (!normalized) return activeAgencies;

    return activeAgencies.filter((agency) =>
      [agency.email, agency.granted_by].some((value) => value.toLowerCase().includes(normalized)),
    );
  }, [agencies, query, isAgency, user]);

  const interestedCount = useMemo(() => {
    const interested = clients.filter((client) => client.enterprise_interest);
    if (isAdmin) {
      return interested.filter((client) => !client.agency_email && !client.agency_code).length;
    }
    return interested.length;
  }, [clients, isAdmin]);
  const activeAgencyCount = useMemo(() => {
    const activeGrants = agencies.filter((agency) => agency.is_active);
    if (isAgency && user?.email) {
      return activeGrants.filter(
        (agency) => agency.email.toLowerCase() !== user.email.toLowerCase()
      ).length;
    }
    return activeGrants.length;
  }, [agencies, isAgency, user]);
  const sectionTitle =
    viewMode === "enterprise" ? "Enterprise" : viewMode === "agency" ? "Agency Access" : "Clients";
  const sectionDescription =
    viewMode === "enterprise"
      ? "Review and manage users who requested enterprise access."
      : viewMode === "agency"
        ? "Grant and revoke agency access by Gmail address only."
        : "Set custom enterprise price and minutes for each client.";

  const formatMinutes = (seconds: number) => Math.max(0, Math.floor(seconds / 60));
  const formatClientEmail = (email: string) => email || "Email not linked";
  const formatDateTime = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  const isValidAgencyGmail = (value: string) => /^[a-z0-9._%+-]+@gmail\.com$/i.test(value.trim());

  const saveEnterpriseAccess = async (client: AdminClient) => {
    const draft = drafts[client.user_id];
    const enterpriseRatePerMinute = Number(draft?.enterprise_rate_per_minute?.trim() || "");
    const purchaseAmount = Number(draft?.purchase_amount?.trim() || "");

    if (!Number.isFinite(enterpriseRatePerMinute) || enterpriseRatePerMinute <= 0) {
      toast({ title: "Error", description: "Enter a valid enterprise rate per minute.", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(purchaseAmount) || purchaseAmount <= 0) {
      toast({ title: "Error", description: "Enter a valid purchase amount.", variant: "destructive" });
      return;
    }

    setSavingUserId(client.user_id);
    try {
      const result = await callAdminFunction<{ success: boolean; credit: { creditedMinutes: number; availableSeconds: number } }>("admin-update-client-enterprise", {
        client_user_id: client.user_id,
        enterprise_rate_per_minute: enterpriseRatePerMinute,
        purchase_amount: purchaseAmount,
      });

      setClients((current) =>
        current.map((item) =>
          item.user_id === client.user_id
            ? {
                ...item,
                enterprise_rate_per_minute: enterpriseRatePerMinute,
                last_enterprise_amount: purchaseAmount,
                last_enterprise_minutes: result.credit.creditedMinutes,
                available_seconds: result.credit.availableSeconds,
                enterprise_interest: false,
              }
            : item,
        ),
      );

      toast({ title: "Minutes added successfully" });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to update enterprise plan.",
        variant: "destructive",
      });
    } finally {
      setSavingUserId(null);
    }
  };

  const dismissEnterpriseAccess = async (client: AdminClient) => {
    setDismissingUserId(client.user_id);
    try {
      await callAdminFunction<{ success: boolean }>("admin-dismiss-enterprise", {
        client_user_id: client.user_id,
      });

      setClients((current) =>
        current.map((item) =>
          item.user_id === client.user_id
            ? {
                ...item,
                enterprise_interest: false,
              }
            : item,
        ),
      );

      toast({ title: "Request dismissed" });
      setClientToDismiss(null);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to dismiss enterprise request.",
        variant: "destructive",
      });
    } finally {
      setDismissingUserId(null);
    }
  };

  const openClientSpaces = (client: AdminClient) => {
    setSelectedClient(client);
    setClientAgencyDraft(client.agency_code || client.agency_email || "");
    setSpaceDraft({
      voice: client.enabled_spaces.includes("voice"),
      sms: client.enabled_spaces.includes("sms"),
      whatsapp: client.enabled_spaces.includes("whatsapp"),
      gmail: client.enabled_spaces.includes("gmail"),
    });
  };

  const hasPendingSpaceRequests = (client: AdminClient) => client.requested_spaces.length > 0;

  const saveClientSpaces = async () => {
    if (!selectedClient) return;

    const enabledSpaces = ALL_VIBE_SPACES.filter((space) => spaceDraft[space]);

    setSavingUserId(selectedClient.user_id);
    try {
      const isCode = clientAgencyDraft.length === 6 && !clientAgencyDraft.includes("@");
      
      const result = await callAdminFunction<{ success: boolean; enabled_spaces: VibeSpace[] }>(
        "admin-update-client-spaces",
        {
          client_user_id: selectedClient.user_id,
          client_email: selectedClient.email,
          enabled_spaces: enabledSpaces,
          agency_code: isAdmin && isCode ? clientAgencyDraft : undefined,
          agency_email: isAdmin ? (isCode ? undefined : (clientAgencyDraft || null)) : undefined,
        },
      );

      const matchedAgency = agencies.find(a => 
        (isCode && a.agency_code?.toUpperCase() === clientAgencyDraft.toUpperCase()) || 
        (!isCode && a.email.toLowerCase() === clientAgencyDraft.toLowerCase())
      );

      const nextAgencyEmail = matchedAgency ? matchedAgency.email : null;
      const nextAgencyCode = matchedAgency ? (matchedAgency.agency_code || null) : null;

      setClients((current) =>
        current.map((client) =>
          client.user_id === selectedClient.user_id
            ? {
                ...client,
                enabled_spaces: result.enabled_spaces,
                requested_spaces: client.requested_spaces.filter((space) => !result.enabled_spaces.includes(space)),
                agency_email: isAdmin ? nextAgencyEmail : client.agency_email,
                agency_code: isAdmin ? nextAgencyCode : client.agency_code,
              }
            : client,
        ),
      );
      setSelectedClient((current) =>
        current
          ? {
              ...current,
              enabled_spaces: result.enabled_spaces,
              requested_spaces: current.requested_spaces.filter((space) => !result.enabled_spaces.includes(space)),
              agency_email: isAdmin ? nextAgencyEmail : current.agency_email,
              agency_code: isAdmin ? nextAgencyCode : current.agency_code,
            }
          : current
      );

      toast({ title: "Client spaces updated" });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to update client spaces.",
        variant: "destructive",
      });
    } finally {
      setSavingUserId(null);
    }
  };

  const handleTransferMinutes = async () => {
    if (!selectedClient) return;
    const mins = Number(minutesToTransfer);
    if (!Number.isInteger(mins) || mins <= 0) {
      toast({
        title: "Error",
        description: "Please enter a valid positive integer number of minutes.",
        variant: "destructive",
      });
      return;
    }

    setTransferring(true);
    try {
      const result = await callAdminFunction<{
        success: boolean;
        credit: { creditedMinutes: number; availableSeconds: number };
      }>("admin-update-client-enterprise", {
        client_user_id: selectedClient.user_id,
        minutes_to_transfer: mins,
      });

      // Update local clients state with new minute balance
      setClients((current) =>
        current.map((item) =>
          item.user_id === selectedClient.user_id
            ? {
                ...item,
                available_seconds: result.credit.availableSeconds,
                enterprise_interest: false,
              }
            : item
        )
      );

      // Update dialog client with new minute balance
      setSelectedClient((current) =>
        current
          ? {
              ...current,
              available_seconds: result.credit.availableSeconds,
              enterprise_interest: false,
            }
          : current
      );

      // Decrement agency seconds in our local Hook state by reloading
      void loadClients();
      setMinutesToTransfer("");
      toast({
        title: "Transfer successful",
        description: `Successfully allocated ${mins} minutes to ${selectedClient.full_name || selectedClient.email}.`,
      });
    } catch (error) {
      toast({
        title: "Transfer failed",
        description: error instanceof Error ? error.message : "Unable to complete transfer.",
        variant: "destructive",
      });
    } finally {
      setTransferring(false);
    }
  };

  const saveAgencyTransferFromCard = async (client: AdminClient) => {
    let mins = 0;
    let rate = 0;
    let amount = 0;

    if (viewMode === "enterprise") {
      rate = Number(drafts[client.user_id]?.enterprise_rate_per_minute || 0);
      amount = Number(drafts[client.user_id]?.purchase_amount || 0);
      mins = rate > 0 && amount > 0 ? Math.floor(amount / rate) : 0;

      if (rate <= 0 || amount <= 0 || mins <= 0) {
        toast({
          title: "Error",
          description: "Please enter valid positive enterprise rate and purchase amount.",
          variant: "destructive",
        });
        return;
      }
    } else {
      mins = Number(agencyMinutesDrafts[client.user_id]);
      if (!Number.isInteger(mins) || mins <= 0) {
        toast({
          title: "Error",
          description: "Please enter a valid positive integer number of minutes.",
          variant: "destructive",
        });
        return;
      }
    }

    setSavingUserId(client.user_id);
    try {
      const result = await callAdminFunction<{
        success: boolean;
        credit: { creditedMinutes: number; availableSeconds: number };
      }>("admin-update-client-enterprise", {
        client_user_id: client.user_id,
        minutes_to_transfer: mins,
        enterprise_rate_per_minute: rate > 0 ? rate : undefined,
        purchase_amount: amount > 0 ? amount : undefined,
      });

      // Update local clients state with new minute balance
      setClients((current) =>
        current.map((item) =>
          item.user_id === client.user_id
            ? {
                ...item,
                available_seconds: result.credit.availableSeconds,
                enterprise_interest: false,
              }
            : item
        )
      );

      // Clear draft
      setAgencyMinutesDrafts((current) => ({
        ...current,
        [client.user_id]: "",
      }));

      // Reload clients
      void loadClients();
      toast({
        title: "Transfer successful",
        description: `Successfully allocated ${mins} minutes to ${client.full_name || client.email}.`,
      });
    } catch (error) {
      toast({
        title: "Transfer failed",
        description: error instanceof Error ? error.message : "Unable to complete transfer.",
        variant: "destructive",
      });
    } finally {
      setSavingUserId(null);
    }
  };

  const saveAdminDirectMinutes = async (client: AdminClient) => {
    const mins = Number(agencyMinutesDrafts[client.user_id]);
    if (!Number.isInteger(mins) || mins <= 0) {
      toast({
        title: "Error",
        description: "Please enter a valid positive integer number of minutes.",
        variant: "destructive",
      });
      return;
    }

    setSavingUserId(client.user_id);
    try {
      const result = await callAdminFunction<{
        success: boolean;
        credit: { creditedMinutes: number; availableSeconds: number };
      }>("admin-update-client-enterprise", {
        client_user_id: client.user_id,
        minutes_to_transfer: mins,
      });

      // Update local clients state with new minute balance
      setClients((current) =>
        current.map((item) =>
          item.user_id === client.user_id
            ? {
                ...item,
                available_seconds: result.credit.availableSeconds,
              }
            : item
        )
      );

      // Clear draft
      setAgencyMinutesDrafts((current) => ({
        ...current,
        [client.user_id]: "",
      }));

      // Reload clients
      void loadClients();
      toast({
        title: "Minutes added successfully",
        description: `Successfully credited ${mins} minutes to ${client.full_name || client.email}.`,
      });
    } catch (error) {
      toast({
        title: "Failed to add minutes",
        description: error instanceof Error ? error.message : "Unable to add minutes.",
        variant: "destructive",
      });
    } finally {
      setSavingUserId(null);
    }
  };


  const saveAgencyAccess = async () => {
    const normalizedEmail = agencyEmailDraft.trim().toLowerCase();

    if (!isValidAgencyGmail(normalizedEmail)) {
      toast({
        title: "Error",
        description: "Enter a valid Gmail address ending in @gmail.com.",
        variant: "destructive",
      });
      return;
    }

    const wholesaleRate = Number(agencyWholesaleRateDraft);
    if (isNaN(wholesaleRate) || wholesaleRate <= 0) {
      toast({
        title: "Error",
        description: "Please enter a valid positive wholesale rate.",
        variant: "destructive",
      });
      return;
    }

    setSavingAgency(true);
    try {
      const functionName = isAgency ? "admin-grant-agency-access" : "admin-upsert-agency-access";
      const payload = isAgency 
        ? { child_agency_email: normalizedEmail, wholesale_rate_per_minute: wholesaleRate } 
        : { email: normalizedEmail, wholesale_rate_per_minute: wholesaleRate };

      await callAdminFunction<{ success: boolean; agency?: AgencyGrant }>(
        functionName,
        payload
      );

      await loadAgencies();
      setAgencyEmailDraft("");
      setAgencyWholesaleRateDraft("0.10");
      toast({ title: "Agency access granted" });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to save agency access.",
        variant: "destructive",
      });
    } finally {
      setSavingAgency(false);
    }
  };

  const revokeAgencyAccess = async (agency: AgencyGrant) => {
    setRevokingAgencyId(agency.id);
    try {
      await callAdminFunction<{ success: boolean; id: string }>("admin-revoke-agency-access", {
        id: agency.id,
      });

      setAgencies((current) =>
        current.map((item) =>
          item.id === agency.id
            ? {
                ...item,
                is_active: false,
              }
            : item,
        ),
      );
      toast({ title: "Agency access revoked" });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Unable to revoke agency access.",
        variant: "destructive",
      });
    } finally {
      setRevokingAgencyId(null);
    }
  };

  if (!isAdmin && !isAgency) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Admin Dashboard</CardTitle>
            <CardDescription>This page is available only for the admin/agency account.</CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {isAgency ? "Agency Dashboard" : "Admin Dashboard"}
            </h1>
            <p className="mt-1 text-muted-foreground">
              {isAgency 
                ? "Manage your clients and allocate minutes to their accounts."
                : "Manage platform clients and assign enterprise pricing and minutes."}
            </p>
          </div>

          {isAgency && agencyCode && (
            <div className="flex flex-row items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-1.5 shadow-sm">
              <span className="text-[11px] font-bold uppercase tracking-wider text-primary/80 whitespace-nowrap">
                Agency Referral Code
              </span>
              <code className="text-sm font-bold px-2 py-0.5 bg-background rounded-lg border border-primary/10 select-all">{agencyCode}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const signupUrl = `${window.location.origin}/signup?agency=${agencyCode}`;
                  navigator.clipboard.writeText(signupUrl);
                  toast({
                    title: "Referral link copied!",
                    description: "Share this link with clients to automatically link them to your agency.",
                  });
                }}
                className="h-7 px-2 text-xs text-primary hover:text-primary/80 hover:bg-primary/10 rounded-lg font-medium"
              >
                Copy Link
              </Button>
            </div>
          )}

          {(isAdmin || isAgency) && (
            <div className="inline-flex rounded-2xl bg-muted p-1">
              <button
                type="button"
                onClick={() => setViewMode("clients")}
                className={`relative rounded-xl px-6 py-2 text-sm font-medium transition-colors ${
                  viewMode === "clients"
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {viewMode === "clients" ? (
                  <motion.div
                    layoutId="admin-view-mode-pill"
                    className="absolute inset-0 rounded-xl bg-primary shadow-sm"
                    transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
                  />
                ) : null}
                <span className="relative z-10">Clients</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("enterprise")}
                className={`relative rounded-xl px-6 py-2 text-sm font-medium transition-colors ${
                  viewMode === "enterprise"
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {viewMode === "enterprise" ? (
                  <motion.div
                    layoutId="admin-view-mode-pill"
                    className="absolute inset-0 rounded-xl bg-primary shadow-sm"
                    transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
                  />
                ) : null}
                <span className="relative z-10">Enterprise</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("agency")}
                className={`relative rounded-xl px-6 py-2 text-sm font-medium transition-colors ${
                  viewMode === "agency"
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {viewMode === "agency" ? (
                  <motion.div
                    layoutId="admin-view-mode-pill"
                    className="absolute inset-0 rounded-xl bg-primary shadow-sm"
                    transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.8 }}
                  />
                ) : null}
                <span className="relative z-10">Agency</span>
              </button>
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>Total Clients</CardDescription>
              <CardTitle className="flex items-center gap-2 text-3xl">
                <Users className="h-6 w-6 text-primary" />
                {loading ? "..." : clients.length}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>Enterprise Requests</CardDescription>
              <CardTitle className="flex items-center gap-2 text-3xl">
                <Crown className="h-6 w-6 text-primary" />
                {loading ? "..." : interestedCount}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription>
                {isAgency ? "Active Sub-Agencies" : "Agency Gmail Access"}
              </CardDescription>
              <CardTitle className="flex items-center gap-2 text-3xl">
                <Building2 className="h-6 w-6 text-primary" />
                {loading ? "..." : activeAgencyCount}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight">{sectionTitle}</h2>
                  <p className="text-muted-foreground">{sectionDescription}</p>
                </div>
                <div className="relative w-full md:w-80">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={viewMode === "agency" ? "Search by Gmail or admin" : "Search by email, name, company"}
                    aria-label={viewMode === "agency" ? "Search agencies" : "Search users"}
                    className="pl-9"
                  />
                </div>
              </div>

              {viewMode === "agency" ? (
                <div className="space-y-4">
                  <div className="grid gap-4 rounded-xl border border-border bg-card p-4 md:grid-cols-[1fr_200px_auto]">
                    <div className="space-y-2">
                      <Label htmlFor="agency-gmail">Agency Gmail</Label>
                      <Input
                        id="agency-gmail"
                        type="email"
                        inputMode="email"
                        value={agencyEmailDraft}
                        onChange={(e) => setAgencyEmailDraft(e.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveAgencyAccess();
                          }
                        }}
                        placeholder="agencyname@gmail.com"
                      />
                      <p className="text-xs text-muted-foreground">
                        Only Gmail addresses are allowed for agency access.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="agency-wholesale-rate">Wholesale Rate ($/min)</Label>
                      <Input
                        id="agency-wholesale-rate"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={agencyWholesaleRateDraft}
                        onChange={(e) => setAgencyWholesaleRateDraft(e.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveAgencyAccess();
                          }
                        }}
                        placeholder="0.10"
                      />
                      <p className="text-xs text-muted-foreground">
                        Wholesale minute cost rate for this agency.
                      </p>
                    </div>
                    <div className="flex items-end pb-5 md:pb-6">
                      <Button onClick={() => void saveAgencyAccess()} disabled={savingAgency} className="w-full">
                        {savingAgency ? "Saving..." : "Grant Access"}
                      </Button>
                    </div>
                  </div>

                  {filteredAgencies.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active agency Gmail access found.</p>
                  ) : (
                    filteredAgencies.map((agency) => (
                      <div
                        key={agency.id}
                        className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm lg:flex-row lg:items-start lg:justify-between"
                      >
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-lg font-semibold">{agency.email}</h3>
                            <Badge className="bg-primary text-primary-foreground hover:bg-primary">Active</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">Granted by {agency.granted_by}</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground animate-rise-in">
                            <span>Cost Rate: <strong>${agency.wholesale_rate_per_minute?.toFixed(2) ?? "0.10"}/min</strong></span>
                            <span>Client Price: <strong>${agency.client_rate_per_minute?.toFixed(2) ?? "0.15"}/min</strong></span>
                          </div>
                          <p className="text-sm text-muted-foreground">
                            Updated {formatDateTime(agency.updated_at)}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 mt-2 lg:mt-0">
                          {agency.agency_code && (
                            <Button
                              variant="outline"
                              onClick={() => {
                                const signupUrl = `${window.location.origin}/signup?agency=${agency.agency_code}`;
                                navigator.clipboard.writeText(signupUrl);
                                toast({
                                  title: "Referral link copied!",
                                  description: `Referral link for agency ${agency.email} copied.`,
                                });
                              }}
                              className="text-primary hover:bg-primary/10 border-primary/20 hover:text-primary"
                            >
                              Copy Referral Link
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            onClick={() => void revokeAgencyAccess(agency)}
                            disabled={revokingAgencyId === agency.id}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            {revokingAgencyId === agency.id ? "Revoking..." : "Revoke Access"}
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : loading ? (
                <p className="text-sm text-muted-foreground">Loading clients...</p>
              ) : filteredClients.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {viewMode === "enterprise" ? "No enterprise requests found." : "No clients found."}
                </p>
              ) : (
                filteredClients.map((client) => (
                  <div
                    key={client.user_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openClientSpaces(client)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openClientSpaces(client);
                      }
                    }}
                    className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/20"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-lg font-semibold">
                            {client.full_name || formatClientEmail(client.email)}
                          </h3>
                          {hasPendingSpaceRequests(client) ? (
                            <Badge variant="outline" className="border-primary/30 text-primary">
                              Requested: {client.requested_spaces.map((space) => spaceLabels[space]).join(", ")}
                            </Badge>
                          ) : null}
                          {client.enterprise_interest ? (
                            <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                              Enterprise Request
                            </Badge>
                          ) : null}
                          <Badge variant="outline">{formatMinutes(client.available_seconds)} minutes available</Badge>
                          {isAdmin && (client.agency_code || client.agency_email) && (
                            <Badge variant="outline" className="bg-muted text-muted-foreground border-muted-foreground/30">
                              Agency: {client.agency_code || client.agency_email}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{formatClientEmail(client.email)}</p>
                        <p className="text-sm text-muted-foreground">
                          {client.company_name || "No company added"}
                        </p>
                      </div>

                      {viewMode === "enterprise" ? (
                        <div className="grid w-full gap-3 md:grid-cols-[1fr_1fr_auto] lg:max-w-2xl">
                          <div className="space-y-2">
                            <Label htmlFor={`enterprise-rate-${client.user_id}`}>Enterprise Rate / Minute</Label>
                            <Input
                              id={`enterprise-rate-${client.user_id}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={drafts[client.user_id]?.enterprise_rate_per_minute ?? ""}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(e) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [client.user_id]: {
                                    enterprise_rate_per_minute: e.target.value,
                                    purchase_amount: current[client.user_id]?.purchase_amount ?? "",
                                  },
                                }))
                              }
                              placeholder="0.08"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`purchase-amount-${client.user_id}`}>Purchase Amount</Label>
                            <Input
                              id={`purchase-amount-${client.user_id}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={drafts[client.user_id]?.purchase_amount ?? ""}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(e) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [client.user_id]: {
                                    enterprise_rate_per_minute: current[client.user_id]?.enterprise_rate_per_minute ?? "",
                                    purchase_amount: e.target.value,
                                  },
                                }))
                              }
                              placeholder="99"
                            />
                            <p className="text-xs text-muted-foreground">
                              Credits{" "}
                              {(() => {
                                const rate = Number(drafts[client.user_id]?.enterprise_rate_per_minute || 0);
                                const amount = Number(drafts[client.user_id]?.purchase_amount || 0);
                                return rate > 0 && amount > 0 ? Math.floor(amount / rate) : 0;
                              })()}{" "}
                              minutes
                            </p>
                          </div>
                          <div className="flex items-end gap-2">
                            <Button
                              onClick={(event) => {
                                event.stopPropagation();
                                if (isAgency) {
                                  void saveAgencyTransferFromCard(client);
                                } else {
                                  void saveEnterpriseAccess(client);
                                }
                              }}
                              disabled={savingUserId === client.user_id || dismissingUserId === client.user_id}
                              className="flex-1 lg:flex-none"
                            >
                              {savingUserId === client.user_id ? "Transferring..." : "Transfer"}
                            </Button>
                            {client.enterprise_interest && (
                              <Button
                                variant="outline"
                                size="icon"
                                aria-label={`Dismiss enterprise request from ${client.full_name || client.email}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setClientToDismiss(client);
                                }}
                                disabled={savingUserId === client.user_id || dismissingUserId === client.user_id}
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ) : (
                        // Clients view mode (single input)
                        isAgency ? (
                          <div className="grid w-full gap-3 md:grid-cols-[1fr_auto] lg:max-w-md">
                            <div className="space-y-2">
                              <Label htmlFor={`minutes-transfer-${client.user_id}`}>Minutes to Transfer</Label>
                              <Input
                                id={`minutes-transfer-${client.user_id}`}
                                type="number"
                                min="1"
                                step="1"
                                value={agencyMinutesDrafts[client.user_id] ?? ""}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(e) =>
                                  setAgencyMinutesDrafts((current) => ({
                                    ...current,
                                    [client.user_id]: e.target.value,
                                  }))
                                }
                                placeholder="Enter minutes to transfer"
                              />
                            </div>
                            <div className="flex items-end gap-2">
                              <Button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void saveAgencyTransferFromCard(client);
                                }}
                                disabled={savingUserId === client.user_id}
                                className="flex-1 lg:flex-none"
                              >
                                {savingUserId === client.user_id ? "Transferring..." : "Transfer"}
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="grid w-full gap-3 md:grid-cols-[1fr_auto] lg:max-w-md">
                            <div className="space-y-2">
                              <Label htmlFor={`minutes-add-${client.user_id}`}>Minutes to Add</Label>
                              <Input
                                id={`minutes-add-${client.user_id}`}
                                type="number"
                                min="1"
                                step="1"
                                value={agencyMinutesDrafts[client.user_id] ?? ""}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(e) =>
                                  setAgencyMinutesDrafts((current) => ({
                                    ...current,
                                    [client.user_id]: e.target.value,
                                  }))
                                }
                                placeholder="Enter minutes to add"
                              />
                            </div>
                            <div className="flex items-end gap-2">
                              <Button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void saveAdminDirectMinutes(client);
                                }}
                                disabled={savingUserId === client.user_id}
                                className="flex-1 lg:flex-none"
                              >
                                {savingUserId === client.user_id ? "Adding..." : "Add"}
                              </Button>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog open={!!selectedClient} onOpenChange={(open) => !open && setSelectedClient(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Client Spaces</DialogTitle>
            <DialogDescription>
              Control which spaces are visible to{" "}
              <span className="font-medium text-foreground">
                {selectedClient ? selectedClient.full_name || formatClientEmail(selectedClient.email) : ""}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {isAdmin && (
              <div className="space-y-1.5 border-b border-border pb-4">
                <Label htmlFor="assign-agency" className="text-sm font-semibold">Assigned Agency</Label>
                <select
                  id="assign-agency"
                  value={clientAgencyDraft}
                  onChange={(e) => setClientAgencyDraft(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">No Agency Assigned (Platform Client)</option>
                  {agencies
                    .filter((agency) => agency.is_active)
                    .map((agency) => (
                      <option key={agency.id} value={agency.agency_code || agency.email}>
                        {agency.email} {agency.agency_code ? `(Code: ${agency.agency_code})` : ""}
                      </option>
                    ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Clients assigned to an agency are only visible and manageable by that agency.
                </p>
              </div>
            )}
            {ALL_VIBE_SPACES.map((space) => (
              <div key={space} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                <div>
                  <div className="font-medium">{spaceLabels[space]}</div>
                  <div className="text-sm text-muted-foreground">
                    {spaceDraft[space]
                      ? "Visible to the user"
                      : selectedClient?.requested_spaces.includes(space)
                        ? "User requested access. Toggle on to unlock it."
                        : "Locked for the user"}
                  </div>
                </div>
                <Switch
                  aria-label={`${spaceLabels[space]} access`}
                  checked={spaceDraft[space]}
                  onCheckedChange={(checked) =>
                    setSpaceDraft((current) => ({
                      ...current,
                      [space]: checked,
                    }))
                  }
                />
              </div>
            ))}

            {isAgency && (
              <div className="mt-6 border-t border-border pt-4 space-y-3">
                <h4 className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                  <Timer className="h-4 w-4 text-primary" />
                  Allocate Quota Minutes
                </h4>
                <p className="text-xs text-muted-foreground">
                  Transfer minutes from your agency balance to this client's balance. 
                  (Your current balance: <span className="font-medium text-foreground">{agencyMinutes} minutes</span>)
                </p>
                <div className="flex gap-2 items-center">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Enter minutes to transfer"
                    aria-label="Minutes to transfer"
                    value={minutesToTransfer}
                    onChange={(e) => setMinutesToTransfer(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    onClick={() => void handleTransferMinutes()}
                    disabled={transferring || !minutesToTransfer}
                  >
                    {transferring ? "Transferring..." : "Transfer"}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedClient(null)} disabled={!!savingUserId}>
              Cancel
            </Button>
            <Button onClick={() => void saveClientSpaces()} disabled={savingUserId === selectedClient?.user_id}>
              {savingUserId === selectedClient?.user_id ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!clientToDismiss} onOpenChange={(open) => !open && setClientToDismiss(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the enterprise request for{" "}
              <span className="font-medium text-foreground">
                {clientToDismiss ? clientToDismiss.full_name || formatClientEmail(clientToDismiss.email) : ""}
              </span>
              . This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!dismissingUserId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (clientToDismiss) void dismissEnterpriseAccess(clientToDismiss);
              }}
              disabled={!!dismissingUserId}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {dismissingUserId ? "Dismissing..." : "Dismiss Request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
