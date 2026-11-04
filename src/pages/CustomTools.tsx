import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Trash2, Wrench, Loader2, Code2, MoreVertical, Pencil, Bot } from "lucide-react";
import CreateToolDialog from "@/components/custom-tools/CreateToolDialog";

interface AgentToolRow {
  id: string;
  user_id: string;
  agent_id: string;
  name: string;
  description: string;
  tool_type: string;
  http_method: string;
  http_url: string;
  http_headers: Record<string, string>;
  http_body_template: Record<string, any>;
  parameters: any[];
  is_active: boolean;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
}

export default function CustomTools() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tools, setTools] = useState<AgentToolRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentToolRow | null>(null);

  const fetchData = async () => {
    if (!user) return;
    const [{ data: tl }, { data: ag }] = await Promise.all([
      supabase.from("agent_tools").select("*").order("created_at", { ascending: false }),
      supabase.from("agents").select("id, name"),
    ]);
    setTools((tl as AgentToolRow[]) || []);
    setAgents(ag || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const channel = supabase
      .channel('custom-tools-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_tools' }, () => fetchData())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("agent_tools").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Tool deleted" });
      fetchData();
    }
  };

  // Flip right away; put it back if the save fails.
  const toggleActive = async (id: string, current: boolean) => {
    setTools((ts) => ts.map((t) => (t.id === id ? { ...t, is_active: !current } : t)));
    const { error } = await supabase.from("agent_tools").update({ is_active: !current } as any).eq("id", id);
    if (error) {
      setTools((ts) => ts.map((t) => (t.id === id ? { ...t, is_active: current } : t)));
      toast({ title: "Couldn't change the tool", description: error.message, variant: "destructive" });
    }
  };

  const getAgentName = (agentId: string) => agents.find(a => a.id === agentId)?.name || "Unknown";

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Custom Tools</h1>
            <p className="text-muted-foreground mt-1">Define HTTP tools your AI agents can trigger during calls.</p>
          </div>
          {user && <CreateToolDialog agents={agents} userId={user.id} onCreated={fetchData} />}
          {user && editing && <CreateToolDialog agents={agents} userId={user.id} onCreated={fetchData} editing={editing} onEditClose={() => setEditing(null)} />}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : tools.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Wrench className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold">No custom tools yet</h3>
              <p className="text-muted-foreground text-sm mt-1">Create tools your AI agents can invoke during calls.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {tools.map(tool => (
              <Card
                key={tool.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${tool.name}`}
                onClick={() => setEditing(tool)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(tool); } }}
                className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="flex items-center justify-between gap-4 p-4">
                  <div className="flex items-center gap-4 min-w-0">
                    <Code2 className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="font-mono font-medium text-sm truncate">
                        {tool.name}
                        {!tool.is_active && <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">Off</span>}
                      </p>
                      <p className="flex items-center gap-1.5 text-sm text-muted-foreground truncate">
                        <Bot className="h-3.5 w-3.5 shrink-0" /> {getAgentName(tool.agent_id)}
                      </p>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="shrink-0" aria-label={`Options for ${tool.name}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        className="justify-between gap-6"
                        onSelect={(e) => { e.preventDefault(); toggleActive(tool.id, tool.is_active); }}
                      >
                        Active
                        <Switch checked={tool.is_active} aria-label={`${tool.name} active`} className="pointer-events-none" tabIndex={-1} />
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setEditing(tool)}>
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => handleDelete(tool.id)}>
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
