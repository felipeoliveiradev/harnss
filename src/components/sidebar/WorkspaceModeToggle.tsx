import { memo } from "react";
import type { WorkspaceMode } from "@/hooks/useSettings";

interface WorkspaceModeToggleProps {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}

const OPTIONS: Array<{ id: WorkspaceMode; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "code", label: "Code" },
  { id: "both", label: "Both" },
];

export const WorkspaceModeToggle = memo(function WorkspaceModeToggle({
  mode,
  onChange,
}: WorkspaceModeToggleProps) {
  return (
    <div className="px-3 pt-1 pb-2">
      <div className="glass-outline flex items-center rounded-xl p-1">
        {OPTIONS.map((option) => {
          const active = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              className={`flex-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
                active
                  ? "bg-sidebar-foreground/12 text-sidebar-foreground"
                  : "text-sidebar-foreground/65 hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
});
