import { useEffect, useState } from "react";
import {
  Wrench,
  Loader2,
  AlertCircle,
  ChevronRight,
  Terminal,
  FileText,
  FileEdit,
  Search,
  FolderSearch,
  Globe,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentIcon } from "@/components/AgentIcon";
import { ENGINE_ICONS } from "@/lib/engine-icons";
import { reportError } from "@/lib/analytics";

const CLAUDE_ICON = ENGINE_ICONS["claude"];

const REMARK_PLUGINS = [remarkGfm];

interface AgentTranscriptViewerProps {
  outputFile: string;
  agentDescription: string;
  onClose: () => void;
}

// ── JSONL entry shapes ──

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

interface TranscriptEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    stop_reason?: string | null;
  };
  [key: string]: unknown;
}

// ── Flattened display item (one per visual row) ──

interface DisplayItem {
  kind: "text" | "tool_call" | "tool_result" | "thinking";
  /** For text/thinking: the markdown content */
  text?: string;
  /** For tool_call: the tool name */
  toolName?: string;
  /** For tool_call: stringified input */
  toolInput?: string;
  /** For tool_result: the output content */
  toolOutput?: string;
  /** For tool_result: whether the tool errored */
  isError?: boolean;
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: FileText,
  Write: FileEdit,
  Edit: FileEdit,
  Grep: Search,
  Glob: FolderSearch,
  WebSearch: Globe,
  WebFetch: Globe,
};

function getToolIcon(toolName: string) {
  return TOOL_ICONS[toolName] ?? Wrench;
}

/**
 * Modal dialog displaying the full JSONL transcript of a background agent.
 * Reads the agent's output file, flattens content blocks into display items,
 * and renders them in a chat-like view with tool calls, results, and text.
 */
export function AgentTranscriptViewer({ outputFile, agentDescription, onClose }: AgentTranscriptViewerProps) {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.claude.readAgentOutput(outputFile);
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
        } else {
          const entries = (result.messages ?? []) as TranscriptEntry[];
          setItems(flattenEntries(entries));
        }
      } catch (err) {
        if (cancelled) return;
        const msg = reportError("TRANSCRIPT_LOAD", err);
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [outputFile]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl h-[70vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/50 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <AgentIcon icon={CLAUDE_ICON} size={16} className="opacity-60" />
            Agent Transcript — {agentDescription}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-5 py-4 space-y-2">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-foreground/40">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading transcript…
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 py-4 text-sm text-red-400/70">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {!loading && !error && items.length === 0 && (
              <div className="py-8 text-center text-sm text-foreground/40">
                No transcript data available.
              </div>
            )}

            {items.map((item, i) => (
              <DisplayRow key={i} item={item} />
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ── Flatten JSONL entries into display items ──

function flattenEntries(entries: TranscriptEntry[]): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const entry of entries) {
    // Skip system, result, and progress events
    if (entry.type === "system" || entry.type === "result" || entry.type === "progress") continue;

    const content = entry.message?.content;
    if (!content) continue;

    // String content (simple text message)
    if (typeof content === "string") {
      if (content.trim()) {
        items.push({ kind: "text", text: content });
      }
      continue;
    }

    // Array of content blocks — iterate and create display items
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;

        switch (block.type) {
          case "text":
            if (block.text?.trim()) {
              items.push({ kind: "text", text: block.text });
            }
            break;

          case "thinking":
            if (block.thinking?.trim()) {
              items.push({ kind: "thinking", text: block.thinking });
            }
            break;

          case "tool_use":
            items.push({
              kind: "tool_call",
              toolName: block.name ?? "Tool",
              toolInput: block.input ? formatToolInput(block.name ?? "", block.input) : undefined,
            });
            break;

          case "tool_result": {
            const output = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((b): b is ContentBlock => b?.type === "text" && typeof b.text === "string")
                    .map((b) => b.text)
                    .join("\n")
                : null;
            if (output) {
              items.push({
                kind: "tool_result",
                toolOutput: output,
                isError: !!block.is_error,
              });
            }
            break;
          }
        }
      }
    }
  }

  return items;
}

/** Format tool input for display — show the most relevant field. */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  // Common patterns: show the primary argument
  if (toolName === "Bash" && typeof input.command === "string") return input.command;
  if (toolName === "Read" && typeof input.file_path === "string") return input.file_path;
  if ((toolName === "Write" || toolName === "Edit") && typeof input.file_path === "string") return input.file_path;
  if (toolName === "Grep" && typeof input.pattern === "string") return `/${input.pattern}/`;
  if (toolName === "Glob" && typeof input.pattern === "string") return input.pattern;
  if ((toolName === "WebSearch" || toolName === "WebFetch") && typeof input.query === "string") return input.query;
  if ((toolName === "WebFetch") && typeof input.url === "string") return input.url;
  // Fallback: show first string value
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length < 200) return val;
  }
  return "";
}

// ── Display components ──

function DisplayRow({ item }: { item: DisplayItem }) {
  switch (item.kind) {
    case "text":
      return <TextRow text={item.text!} />;
    case "thinking":
      return <ThinkingRow text={item.text!} />;
    case "tool_call":
      return <ToolCallRow toolName={item.toolName!} toolInput={item.toolInput} />;
    case "tool_result":
      return <ToolResultRow output={item.toolOutput!} isError={item.isError} />;
  }
}

function TextRow({ text }: { text: string }) {
  return (
    <div className="flex gap-2.5">
      <AgentIcon icon={CLAUDE_ICON} size={14} className="mt-1 shrink-0 opacity-50" />
      <div className="min-w-0 flex-1 prose dark:prose-invert prose-xs max-w-none text-[12px] text-foreground/70 wrap-break-word
        [&_p]:my-1 [&_p]:leading-relaxed
        [&_pre]:my-1 [&_pre]:rounded [&_pre]:bg-foreground/[0.04] [&_pre]:px-2 [&_pre]:py-1.5 [&_pre]:text-[11px]
        [&_code]:text-[11px] [&_code]:text-foreground/60
        [&_ul]:my-1 [&_ul]:ps-4 [&_ol]:my-1 [&_ol]:ps-4
        [&_li]:my-0 [&_li]:text-[12px]
        [&_strong]:text-foreground/80">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.slice(0, 80) + (text.length > 80 ? "…" : "");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-foreground/30 cursor-pointer hover:text-foreground/50 transition-colors">
          <ChevronRight className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="italic truncate">💭 {preview}</span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-4 px-2 py-1.5 text-[11px] text-foreground/35 italic whitespace-pre-wrap wrap-break-word border-s border-foreground/10">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallRow({ toolName, toolInput }: { toolName: string; toolInput?: string }) {
  const Icon = getToolIcon(toolName);

  return (
    <div className="flex items-start gap-2 py-0.5">
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-foreground/40" />
      <div className="min-w-0 flex-1">
        <span className="text-xs font-medium text-foreground/60">{toolName}</span>
        {toolInput && (
          <div className="text-[11px] text-foreground/40 truncate mt-0.5 font-mono">
            {toolInput}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolResultRow({ output, isError }: { output: string; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  const isLong = output.length > 200;
  const displayText = isLong ? output.slice(0, 200) + "…" : output;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={`ms-5 rounded px-2 py-1 text-[11px] ${
        isError
          ? "bg-red-500/[0.04] text-red-400/60"
          : "bg-foreground/[0.02] text-foreground/40"
      }`}>
        <div className="flex items-center gap-1.5 mb-0.5">
          {isError
            ? <XCircle className="h-3 w-3 shrink-0 text-red-400/50" />
            : <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500/40" />}
          <span className="text-[10px] font-medium">
            {isError ? "Error" : "Result"}
          </span>
          {isLong && (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="text-[10px] text-foreground/30 hover:text-foreground/50 transition-colors cursor-pointer ms-auto"
              >
                {open ? "Collapse" : "Expand"}
              </button>
            </CollapsibleTrigger>
          )}
        </div>
        <div className="font-mono whitespace-pre-wrap wrap-break-word">
          {!open ? displayText : null}
        </div>
        <CollapsibleContent>
          <div className="font-mono whitespace-pre-wrap wrap-break-word">
            {output}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
