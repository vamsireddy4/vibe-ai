import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getVibePath } from "@/lib/vibe-routes";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Bot, MoreVertical, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { Tables } from "@/integrations/supabase/types";
import { getFunctionUnavailableMessage, isEdgeFunctionUnavailable } from "@/lib/edge-functions";
import CreateAgentWizard from "@/components/CreateAgentWizard";

export default function Agents() {
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Tables<"agents">[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<Tables<"agents"> | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const isLocalDashboard = false; // ponytail: local /api/local + edge-function data path needs undeployed functions; read the DB directly

  const getAccessToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || null;
  };

  const invokeAuthedFunction = async <T,>(functionName: string, body: Record<string, unknown>) => {
    const accessToken = await getAccessToken();
    const { data, error } = await supabase.functions.invoke(functionName, {
      body,
      headers: accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : undefined,
    });
    if (error) throw error;
    return (data ?? {}) as T;
  };

  const fetchAgents = async () => {
    if (!user) return;

    if (isLocalDashboard) {
      const payload = await invokeAuthedFunction<any>("voice-space-data", {
        userId: user.id,
        userEmail: user.email || "",
      });
      setAgents(Array.isArray(payload?.agents) ? payload.agents : []);
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from("agents")
      .select("*")
      .order("created_at", { ascending: false });
    setAgents(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchAgents();
    const channel = supabase
      .channel('agents-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, () => fetchAgents())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, isLocalDashboard]);

  const deleteAgent = async (id: string) => {
    try {
      setDeletingAgentId(id);
      const { error } = await supabase.from("agents").delete().eq("id", id); // RLS: only the user's own agents
      if (error) throw error;

      toast({ title: "Agent deleted" });
      setAgentToDelete(null);
      // Realtime subscription auto-refetches, but call explicitly to be safe
      fetchAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message || "Failed to delete agent", variant: "destructive" });
    } finally {
      setDeletingAgentId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
            <p className="text-muted-foreground mt-1">Create and manage your AI receptionists.</p>
          </div>
          <Button onClick={() => setWizardOpen(true)}><Plus className="h-4 w-4 mr-2" />New Agent</Button>
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse"><CardContent className="p-6 h-40" /></Card>
            ))}
          </div>
        ) : agents.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Bot className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-1">No agents yet</h3>
              <p className="text-sm text-muted-foreground mb-4">Create your first AI receptionist to get started.</p>
              <Button onClick={() => setWizardOpen(true)}>Create Agent</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <Card
                key={agent.id}
                role="button"
                tabIndex={0}
                aria-label={agent.name}
                className="group relative cursor-pointer hover:shadow-md transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => navigate(getVibePath("voice", `agents/${agent.id}`))}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); navigate(getVibePath("voice", `agents/${agent.id}`)); } }}
              >
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
                      <Bot className="h-5 w-5 text-accent-foreground" />
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`More actions for ${agent.name}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <Link to={getVibePath("voice", `agents/${agent.id}`)}>
                          <DropdownMenuItem><Pencil className="h-4 w-4 mr-2" />Edit</DropdownMenuItem>
                        </Link>
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); setAgentToDelete(agent); }}
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <h3 className="font-semibold mb-1">{agent.name}</h3>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                    {agent.system_prompt}
                  </p>
                  {/* Green means live: this agent answers calls. */}
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${agent.is_active ? "text-success" : "text-muted-foreground"}`}>
                    <span aria-hidden className={`h-2 w-2 rounded-full ${agent.is_active ? "bg-success" : "bg-muted-foreground/50"}`} />
                    {agent.is_active ? "Active" : "Inactive"}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {user && (
          <CreateAgentWizard 
            open={wizardOpen} 
            onOpenChange={setWizardOpen} 
            userId={user.id} 
          />
        )}

        <AlertDialog open={!!agentToDelete} onOpenChange={(open) => !open && setAgentToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete agent?</AlertDialogTitle>
              <AlertDialogDescription>
                {agentToDelete
                  ? `Are you sure you want to delete "${agentToDelete.name}"? This action cannot be undone.`
                  : "Are you sure you want to delete this agent?"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!deletingAgentId}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!agentToDelete || !!deletingAgentId}
                onClick={(e) => {
                  e.preventDefault();
                  if (agentToDelete) {
                    void deleteAgent(agentToDelete.id);
                  }
                }}
              >
                {deletingAgentId ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  );
}
