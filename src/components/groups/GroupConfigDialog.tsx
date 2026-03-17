import { useState, useCallback, memo } from "react";
import { Plus, Trash2, Crown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentGroup, AgentSlot } from "@/types/groups";
import { SLOT_COLORS } from "@/types/groups";
import type { EngineId } from "@/types/engine";

const ENGINES: { id: EngineId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "codex", label: "Codex" },
  { id: "acp", label: "ACP" },
];

const TURN_ORDERS = [
  { id: "round-robin" as const, label: "Round Robin", desc: "Each agent responds in order" },
  { id: "leader-decides" as const, label: "Leader Decides", desc: "Members respond, then leader synthesizes" },
  { id: "parallel" as const, label: "Parallel", desc: "All agents respond simultaneously" },
];

function createSlotId(): string {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function createGroupId(): string {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface GroupConfigDialogProps {
  group: AgentGroup | null;
  onSave: (group: AgentGroup) => Promise<void>;
  onClose: () => void;
}

export const GroupConfigDialog = memo(function GroupConfigDialog({
  group,
  onSave,
  onClose,
}: GroupConfigDialogProps) {
  const [name, setName] = useState(group?.name ?? "");
  const [turnOrder, setTurnOrder] = useState(group?.turnOrder ?? "round-robin");
  const [slots, setSlots] = useState<AgentSlot[]>(
    group?.slots ?? [
      {
        id: createSlotId(),
        label: "Leader",
        engine: "claude",
        model: "claude-sonnet-4-6",
        role: "leader",
        color: SLOT_COLORS[0],
      },
    ],
  );

  const handleAddSlot = useCallback(() => {
    const colorIndex = slots.length % SLOT_COLORS.length;
    setSlots((prev) => [
      ...prev,
      {
        id: createSlotId(),
        label: `Agent ${prev.length + 1}`,
        engine: "claude" as EngineId,
        model: "claude-sonnet-4-6",
        role: "member" as const,
        color: SLOT_COLORS[colorIndex],
      },
    ]);
  }, [slots.length]);

  const handleRemoveSlot = useCallback((slotId: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== slotId));
  }, []);

  const handleSlotChange = useCallback(
    (slotId: string, field: keyof AgentSlot, value: string) => {
      setSlots((prev) =>
        prev.map((s) => (s.id === slotId ? { ...s, [field]: value } : s)),
      );
    },
    [],
  );

  const handleSetLeader = useCallback((slotId: string) => {
    setSlots((prev) =>
      prev.map((s) => ({
        ...s,
        role: s.id === slotId ? ("leader" as const) : ("member" as const),
      })),
    );
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim() || slots.length === 0) return;
    const now = new Date().toISOString();
    await onSave({
      id: group?.id ?? createGroupId(),
      name: name.trim(),
      slots,
      turnOrder,
      createdAt: group?.createdAt ?? now,
      updatedAt: now,
    });
  }, [name, slots, turnOrder, group, onSave]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-foreground/10 bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-foreground/5 px-4 py-3">
          <h2 className="text-sm font-semibold">
            {group ? "Edit Group" : "Create Agent Group"}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-4">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Group Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-full rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
              placeholder="e.g. Code Review Team"
            />
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Turn Order
            </label>
            <div className="flex gap-2">
              {TURN_ORDERS.map((to) => (
                <button
                  key={to.id}
                  onClick={() => setTurnOrder(to.id)}
                  className={`flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    turnOrder === to.id
                      ? "border-foreground/30 bg-foreground/[0.06] text-foreground"
                      : "border-foreground/10 text-muted-foreground hover:border-foreground/20"
                  }`}
                >
                  <div className="font-medium">{to.label}</div>
                  <div className="mt-0.5 text-[10px] opacity-60">{to.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mb-2 flex items-center justify-between">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Agent Slots ({slots.length})
            </label>
            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleAddSlot}>
              <Plus className="me-1 h-3 w-3" />
              Add Agent
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {slots.map((slot) => (
              <div
                key={slot.id}
                className="rounded-lg border border-foreground/10 p-2.5"
                style={{ borderLeftColor: slot.color, borderLeftWidth: 3 }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={slot.label}
                    onChange={(e) => handleSlotChange(slot.id, "label", e.target.value)}
                    className="h-7 flex-1 rounded border border-foreground/10 bg-background px-2 text-xs text-foreground outline-none focus:border-foreground/30"
                    placeholder="Agent label"
                  />
                  <button
                    onClick={() => handleSetLeader(slot.id)}
                    className={`rounded p-1 transition-colors ${
                      slot.role === "leader"
                        ? "bg-amber-500/15 text-amber-400"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                    }`}
                    title={slot.role === "leader" ? "Leader" : "Set as leader"}
                  >
                    <Crown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleRemoveSlot(slot.id)}
                    className="rounded p-1 text-muted-foreground/40 hover:text-red-400"
                    disabled={slots.length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex gap-2">
                  <select
                    value={slot.engine}
                    onChange={(e) => handleSlotChange(slot.id, "engine", e.target.value)}
                    className="h-7 flex-1 rounded border border-foreground/10 bg-background px-1.5 text-xs text-foreground outline-none focus:border-foreground/30"
                  >
                    {ENGINES.map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={slot.model}
                    onChange={(e) => handleSlotChange(slot.id, "model", e.target.value)}
                    className="h-7 flex-1 rounded border border-foreground/10 bg-background px-2 text-xs text-foreground outline-none focus:border-foreground/30"
                    placeholder="Model or agent ID"
                  />
                  {slot.engine === "openclaw" && (
                    <input
                      type="text"
                      value={slot.agentId ?? ""}
                      onChange={(e) => handleSlotChange(slot.id, "agentId", e.target.value)}
                      className="h-7 w-20 rounded border border-foreground/10 bg-background px-2 text-xs text-foreground outline-none focus:border-foreground/30"
                      placeholder="Agent ID"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-foreground/5 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!name.trim() || slots.length === 0}
          >
            {group ? "Save Changes" : "Create Group"}
          </Button>
        </div>
      </div>
    </div>
  );
});
