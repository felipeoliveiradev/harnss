import { memo, useCallback, useEffect, useState } from "react";
import { Loader2, GitBranch, Tag, FileText, FilePlus, FileX, FileEdit, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GraphEntry {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: string[];
  message: string;
  author: string;
  date: string;
}

interface CommitFile {
  status: string;
  path: string;
}

interface GitGraphSectionProps {
  cwd: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
}

function formatRelativeDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

const GRAPH_COLORS = [
  "text-emerald-400/80", "text-sky-400/80", "text-violet-400/80", "text-amber-400/80",
  "text-rose-400/80", "text-cyan-400/80", "text-pink-400/80", "text-lime-400/80",
];

function colorizeGraphLine(line: string): Array<{ text: string; colorClass: string }> {
  const segments: Array<{ text: string; colorClass: string }> = [];
  let currentCol = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "|" || ch === "*" || ch === "/" || ch === "\\") {
      const color = GRAPH_COLORS[currentCol % GRAPH_COLORS.length];
      segments.push({ text: ch === "*" ? "●" : ch, colorClass: ch === "*" ? "text-foreground/85 font-bold" : color });
      if (ch === "|" || ch === "*") currentCol++;
    } else if (ch === " ") {
      segments.push({ text: " ", colorClass: "" });
    } else {
      break;
    }
  }
  return segments;
}

function GraphLine({ graphPart }: { graphPart: string }) {
  const segments = colorizeGraphLine(graphPart);
  return (
    <span className="shrink-0 font-mono whitespace-pre">
      {segments.map((seg, i) => (
        <span key={i} className={seg.colorClass}>{seg.text}</span>
      ))}
    </span>
  );
}

function RefBadge({ name }: { name: string }) {
  const isTag = name.startsWith("tag: ");
  const isHead = name === "HEAD";
  const cleanName = isTag ? name.replace("tag: ", "") : name;
  const colorClass = isHead
    ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300"
    : isTag
    ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
    : "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300";
  const Icon = isTag ? Tag : GitBranch;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[8px] font-medium leading-none ${colorClass}`}>
      <Icon className="h-2 w-2" />
      {cleanName}
    </span>
  );
}

const STATUS_CONFIG: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  M: { icon: FileEdit, color: "text-amber-500", label: "Modified" },
  A: { icon: FilePlus, color: "text-emerald-500", label: "Added" },
  D: { icon: FileX, color: "text-red-500", label: "Deleted" },
  R: { icon: FileEdit, color: "text-blue-500", label: "Renamed" },
  C: { icon: FilePlus, color: "text-cyan-500", label: "Copied" },
};

function CommitFileRow({ file, cwd, hash, onOpenFile }: { file: CommitFile; cwd: string; hash: string; onOpenFile?: (path: string) => void }) {
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [loading, setLoading] = useState(false);

  const config = STATUS_CONFIG[file.status[0]] ?? STATUS_CONFIG.M;
  const Icon = config.icon;

  const handleClick = useCallback(async () => {
    if (showDiff) { setShowDiff(false); return; }
    if (diffContent !== null) { setShowDiff(true); return; }
    setLoading(true);
    try {
      const result = await window.claude.git.commitFileDiff(cwd, hash, file.path);
      setDiffContent(result.diff || "");
      setShowDiff(true);
    } finally {
      setLoading(false);
    }
  }, [cwd, hash, file.path, showDiff, diffContent]);

  return (
    <div>
      <div className="group flex w-full items-center gap-1.5 px-3 ps-8 py-[2px] text-[10px] transition-colors hover:bg-foreground/[0.03]">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
        <button
          type="button"
          className="min-w-0 truncate font-mono text-foreground/65 hover:text-foreground/90 hover:underline cursor-pointer"
          onClick={() => onOpenFile?.(file.path)}
        >
          {file.path}
        </button>
        <span className={`shrink-0 text-[9px] font-medium ${config.color}`}>{file.status[0]}</span>
        {loading && <Loader2 className="ms-auto h-2.5 w-2.5 animate-spin text-foreground/40" />}
        <button
          type="button"
          onClick={handleClick}
          className="ms-auto hidden shrink-0 rounded border border-foreground/[0.12] bg-foreground/[0.04] px-1.5 py-px text-[9px] font-medium text-foreground/50 hover:border-foreground/[0.22] hover:bg-foreground/[0.08] hover:text-foreground/80 group-hover:block cursor-pointer transition-colors"
        >
          {showDiff ? "hide" : "diff"}
        </button>
      </div>
      {showDiff && diffContent !== null && (
        <pre className="mx-3 ms-8 mb-1 max-h-[200px] overflow-auto rounded border border-foreground/[0.06] bg-foreground/[0.02] font-mono text-[9px] leading-relaxed">
          {diffContent.split("\n").map((line, i) => {
            const color = line.startsWith("+") && !line.startsWith("+++")
              ? "text-emerald-500"
              : line.startsWith("-") && !line.startsWith("---")
              ? "text-red-500"
              : line.startsWith("@@")
              ? "text-cyan-500"
              : "text-foreground/50";
            return (
              <div key={i} className={`flex ${color}`}>
                <span className="w-7 shrink-0 select-none border-e border-foreground/[0.06] pe-1 text-end text-foreground/25 tabular-nums">{i + 1}</span>
                <span className="px-1.5">{line || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

function extractGraphPrefix(line: string): string {
  let end = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "|" || ch === "*" || ch === "/" || ch === "\\" || ch === " " || ch === "_") end = i + 1;
    else break;
  }
  return line.slice(0, end);
}

function parseGraphLines(graphRaw: string): string[] {
  return graphRaw.split("\n").filter((l) => l.length > 0);
}

export const GitGraphSection = memo(function GitGraphSection({
  cwd,
  expanded,
  onToggle,
  onOpenFile,
}: GitGraphSectionProps) {
  const [entries, setEntries] = useState<GraphEntry[]>([]);
  const [graphLines, setGraphLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(50);
  const [filter, setFilter] = useState("");
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Map<string, CommitFile[]>>(new Map());
  const [loadingCommit, setLoadingCommit] = useState<string | null>(null);

  const fetchGraph = useCallback(async (limit: number) => {
    setLoading(true);
    try {
      const result = await window.claude.git.graph(cwd, limit);
      if ("error" in result && result.error) return;
      setEntries(result.entries);
      setGraphLines(parseGraphLines(result.graph));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (expanded) fetchGraph(count);
  }, [expanded, count, fetchGraph]);

  const handleToggleCommit = useCallback(async (hash: string) => {
    if (expandedCommit === hash) {
      setExpandedCommit(null);
      return;
    }
    setExpandedCommit(hash);
    if (!commitFiles.has(hash)) {
      setLoadingCommit(hash);
      try {
        const result = await window.claude.git.commitFiles(cwd, hash);
        setCommitFiles((prev) => {
          const next = new Map(prev);
          next.set(hash, result.files || []);
          return next;
        });
      } finally {
        setLoadingCommit(null);
      }
    }
  }, [cwd, expandedCommit, commitFiles]);

  const handleLoadMore = useCallback(() => {
    setCount((c) => c + 50);
  }, []);

  const commitLineIndices: number[] = [];
  graphLines.forEach((line, i) => {
    if (line.includes("*")) commitLineIndices.push(i);
  });

  return (
    <div className="border-b border-foreground/[0.06]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 transition-colors hover:bg-foreground/[0.03] cursor-pointer"
      >
        {expanded ? (
          <svg className="h-3 w-3 shrink-0 text-foreground/45" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5L6 7.5L9 4.5" /></svg>
        ) : (
          <svg className="h-3 w-3 shrink-0 text-foreground/45" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4.5 3L7.5 6L4.5 9" /></svg>
        )}
        <span className="text-[11px] font-semibold text-foreground/60">Graph</span>
        {entries.length > 0 && (
          <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[10px] font-medium tabular-nums text-foreground/45">
            {entries.length}
          </span>
        )}
        {loading && <Loader2 className="ms-auto h-3 w-3 animate-spin text-foreground/40" />}
      </button>
      {expanded && (
        <div className="max-h-[500px] overflow-y-auto pb-1">
          <div className="px-2 pb-1.5 pt-0.5">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute start-1.5 h-2.5 w-2.5 text-foreground/35" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by message, author, hash..."
                className="h-6 w-full rounded border border-input bg-background ps-5 pe-2 text-[10px] text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
          {graphLines.map((line, i) => {
            const isCommitLine = line.includes("*");
            const commitIdx = isCommitLine ? commitLineIndices.indexOf(i) : -1;
            const entry = commitIdx >= 0 && commitIdx < entries.length ? entries[commitIdx] : null;
            if (filter && entry) {
              const lf = filter.toLowerCase();
              const matches = entry.message.toLowerCase().includes(lf)
                || entry.author.toLowerCase().includes(lf)
                || entry.shortHash.toLowerCase().includes(lf)
                || entry.refs.some((r) => r.toLowerCase().includes(lf));
              if (!matches) return null;
            }
            if (filter && !entry && !isCommitLine) return null;

            const graphPart = extractGraphPrefix(line);
            const isExpanded = entry && expandedCommit === entry.hash;
            const files = entry ? commitFiles.get(entry.hash) : undefined;

            return (
              <div key={i}>
                <div
                  className={`flex items-start px-2 text-[10px] leading-[18px] transition-colors ${isCommitLine ? "hover:bg-foreground/[0.03] cursor-pointer" : ""} ${isExpanded ? "bg-foreground/[0.04]" : ""}`}
                  onClick={entry ? () => handleToggleCommit(entry.hash) : undefined}
                >
                  <GraphLine graphPart={graphPart} />
                  {entry ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[7px] font-semibold uppercase text-foreground/60">
                        {entry.author.charAt(0)}
                      </span>
                      <span className="shrink-0 font-mono text-foreground/45 tabular-nums">{entry.shortHash}</span>
                      {entry.refs.filter((r) => r && r !== "HEAD").map((ref) => (
                        <RefBadge key={ref} name={ref} />
                      ))}
                      <span className="min-w-0 truncate text-foreground/75">{entry.message}</span>
                      {loadingCommit === entry.hash && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-foreground/40" />}
                      <span className="ms-auto shrink-0 text-foreground/30 tabular-nums">{formatRelativeDate(entry.date)}</span>
                    </div>
                  ) : !isCommitLine ? null : (
                    <span className="text-foreground/40">{line.slice(graphPart.length)}</span>
                  )}
                </div>
                {isExpanded && files && (
                  <div className="animate-in fade-in slide-in-from-top-1 border-b border-foreground/[0.04] border-s-2 border-s-foreground/[0.12] ms-3 pb-1 duration-150">
                    <div className="px-3 ps-5 py-0.5 text-[9px] text-foreground/40">
                      {entry!.author} · {files.length} file{files.length !== 1 ? "s" : ""} changed
                    </div>
                    {files.map((file) => (
                      <CommitFileRow key={file.path} file={file} cwd={cwd} hash={entry!.hash} onOpenFile={onOpenFile} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {entries.length > 0 && entries.length >= count && (
            <div className="px-3 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-full text-[10px] text-foreground/50"
                onClick={handleLoadMore}
                disabled={loading}
              >
                Load {50} more commits
              </Button>
            </div>
          )}
          {entries.length === 0 && !loading && (
            <p className="px-3 py-2 text-[10px] text-foreground/40">No commits</p>
          )}
        </div>
      )}
    </div>
  );
});
