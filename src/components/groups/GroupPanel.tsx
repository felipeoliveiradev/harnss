import { useState, useCallback, memo } from "react";
import { Plus, Play, Square, Trash2, Users, ChevronDown, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PanelHeader } from "@/components/PanelHeader";
import type { AgentGroup, GroupMessage, GroupSessionStatus } from "@/types/groups";
import { GroupConfigDialog } from "./GroupConfigDialog";
import { GroupChat } from "./GroupChat";

interface GroupPanelProps {
  groups: AgentGroup[];
  messages: GroupMessage[];
  activeSessionStatus: GroupSessionStatus;
  onCreateGroup: (group: AgentGroup) => Promise<void>;
  onUpdateGroup: (group: AgentGroup) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onStartSession: (groupId: string, prompt: string, cwd?: string) => Promise<void>;
  onStopSession: () => void;
  projectPath?: string;
}

export const GroupPanel = memo(function GroupPanel({
  groups,
  messages,
  activeSessionStatus,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onStartSession,
  onStopSession,
  projectPath,
}: GroupPanelProps) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [editingGroup, setEditingGroup] = useState<AgentGroup | null>(null);
  const [prompt, setPrompt] = useState("");

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;
  const isRunning = activeSessionStatus === "running" || activeSessionStatus === "waiting-leader";

  const handleCreate = useCallback(() => {
    setEditingGroup(null);
    setShowConfig(true);
  }, []);

  const handleEdit = useCallback((group: AgentGroup) => {
    setEditingGroup(group);
    setShowConfig(true);
  }, []);

  const handleSaveGroup = useCallback(
    async (group: AgentGroup) => {
      if (editingGroup) {
        await onUpdateGroup(group);
      } else {
        await onCreateGroup(group);
      }
      setShowConfig(false);
      setSelectedGroupId(group.id);
    },
    [editingGroup, onCreateGroup, onUpdateGroup],
  );

  const handleSend = useCallback(() => {
    if (!selectedGroupId || !prompt.trim() || isRunning) return;
    onStartSession(selectedGroupId, prompt.trim(), projectPath);
    setPrompt("");
  }, [selectedGroupId, prompt, isRunning, onStartSession, projectPath]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader icon={Users} label="Agent Groups">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCreate}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </PanelHeader>

      <div className="flex items-center gap-2 border-b border-foreground/5 px-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-foreground/10 bg-background px-2.5 py-1.5 text-sm text-foreground transition-colors hover:border-foreground/20">
              <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {selectedGroup?.name ?? "Select a group..."}
              </span>
              <ChevronDown className="ms-auto h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {groups.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No groups yet. Create one to start.
              </div>
            ) : (
              groups.map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  onClick={() => setSelectedGroupId(g.id)}
                  className={g.id === selectedGroupId ? "bg-accent" : ""}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{g.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {g.slots.length} agents · {g.turnOrder}
                    </span>
                  </div>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedGroup && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleEdit(selectedGroup)}
            >
              <Users className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-red-400 hover:text-red-300"
              onClick={() => {
                onDeleteGroup(selectedGroup.id);
                setSelectedGroupId(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {selectedGroup && (
        <div className="flex flex-wrap gap-1.5 border-b border-foreground/5 px-3 py-2">
          {selectedGroup.slots.map((slot) => (
            <div
              key={slot.id}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{ backgroundColor: `${slot.color}20`, color: slot.color }}
            >
              {slot.role === "leader" && <Crown className="h-2.5 w-2.5" />}
              {slot.label}
              <span className="opacity-60">· {slot.engine}/{slot.model}</span>
            </div>
          ))}
        </div>
      )}

      <ScrollArea className="flex-1">
        <GroupChat
          messages={messages}
          slots={selectedGroup?.slots ?? []}
          status={activeSessionStatus}
        />
      </ScrollArea>

      {selectedGroup && (
        <div className="border-t border-foreground/5 p-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Send a prompt to the group..."
              disabled={isRunning}
              className="h-8 flex-1 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20 disabled:opacity-50"
            />
            {isRunning ? (
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onStopSession}>
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={handleSend}
                disabled={!prompt.trim()}
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="capitalize">{activeSessionStatus}</span>
            <span>· {selectedGroup.turnOrder}</span>
          </div>
        </div>
      )}

      {showConfig && (
        <GroupConfigDialog
          group={editingGroup}
          onSave={handleSaveGroup}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  );
});
