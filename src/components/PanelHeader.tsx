/**
 * Consistent panel header used across TodoPanel, BackgroundAgentsPanel,
 * McpPanel, FilesPanel, and GitPanel.
 *
 * Provides a standardized layout: [icon] [label] [...children (right side)]
 * followed by an optional separator.
 *
 * Panel-level pin/maximize actions are injected via PanelActionsContext by
 * AppLayout so they appear inline with the panel's own header buttons.
 */

import { createContext, useContext } from "react";
import { Maximize2, Minimize2, Pin, PinOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Panel actions context ────────────────────────────────────────────────────

export interface PanelActionsContextValue {
  onPin?: () => void;
  isPinned?: boolean;
  onMaximize?: () => void;
  isMaximized?: boolean;
}

export const PanelActionsContext = createContext<PanelActionsContextValue>({});

// ── PanelHeader ──────────────────────────────────────────────────────────────

interface PanelHeaderProps {
  icon?: LucideIcon;
  /** Custom icon node — takes precedence over `icon` when provided. */
  iconNode?: React.ReactNode;
  label: string;
  /** Optional content rendered to the right of the label (badges, counts, buttons). */
  children?: React.ReactNode;
  /** Show a bottom border separator. Defaults to true. */
  separator?: boolean;
  /** Additional className for the header container (e.g. custom padding). */
  className?: string;
  /** Icon color class override. Defaults to "text-muted-foreground". */
  iconClass?: string;
}

export function PanelHeader({
  icon: Icon,
  iconNode,
  label,
  children,
  separator = true,
  className = "px-3 pt-3 pb-2",
  iconClass = "text-muted-foreground",
}: PanelHeaderProps) {
  const { onPin, isPinned, onMaximize, isMaximized } = useContext(PanelActionsContext);
  const hasRight = !!(children || onPin || onMaximize);

  return (
    <>
      <div className={`flex items-center gap-2 ${className}`}>
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.04]">
          {iconNode ?? (Icon && <Icon className={`h-3 w-3 shrink-0 ${iconClass}`} />)}
        </div>
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground/80 uppercase">{label}</span>
        {hasRight && (
          <div className="ms-auto flex items-center gap-1">
            {children}
            {onMaximize && (
              <button
                type="button"
                title={isMaximized ? "Restore" : "Maximize"}
                onClick={onMaximize}
                className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-all duration-150 hover:bg-foreground/[0.06] hover:text-muted-foreground active:scale-90"
              >
                {isMaximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              </button>
            )}
            {onPin && (
              <button
                type="button"
                title={isPinned ? "Unpin" : "Pin to side"}
                onClick={onPin}
                className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-all duration-150 hover:bg-foreground/[0.06] hover:text-muted-foreground active:scale-90"
              >
                {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              </button>
            )}
          </div>
        )}
      </div>
      {separator && (
        <div className="mx-2">
          <div className="h-px bg-gradient-to-r from-foreground/[0.06] via-foreground/[0.1] to-foreground/[0.06]" />
        </div>
      )}
    </>
  );
}
