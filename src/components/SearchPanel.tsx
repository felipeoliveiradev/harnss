import { memo, useMemo } from "react";
import {
  Search,
  FileText,
  CaseSensitive,
  Regex,
  File,
  AlignLeft,
  FolderSearch,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PanelHeader } from "@/components/PanelHeader";
import { useSearch, type ContentSearchResult } from "@/hooks/useSearch";
import { useState, useCallback } from "react";

interface SearchPanelProps {
  cwd?: string;
  enabled?: boolean;
  onOpenFile?: (filePath: string) => void;
}

function groupByFile(results: ContentSearchResult[]): Map<string, ContentSearchResult[]> {
  const map = new Map<string, ContentSearchResult[]>();
  for (const r of results) {
    const existing = map.get(r.file);
    if (existing) existing.push(r);
    else map.set(r.file, [r]);
  }
  return map;
}

export const SearchPanel = memo(function SearchPanel({
  cwd,
  enabled = true,
  onOpenFile,
}: SearchPanelProps) {
  const search = useSearch(enabled ? cwd : undefined);
  const [showFilters, setShowFilters] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const toggleFileCollapse = useCallback((file: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const groupedContent = useMemo(
    () => groupByFile(search.contentResults),
    [search.contentResults],
  );

  if (!cwd) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader icon={Search} label="Search" iconClass="text-cyan-600/70 dark:text-cyan-200/50" />
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/[0.05]">
            <Search className="h-3.5 w-3.5 text-foreground/25" />
          </div>
          <p className="text-[11px] text-foreground/40">No project open</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader icon={Search} label="Search" iconClass="text-cyan-600/70 dark:text-cyan-200/50">
        {search.isSearching && <Loader2 className="h-3 w-3 animate-spin text-foreground/40" />}
      </PanelHeader>

      <div className="space-y-1.5 border-b border-foreground/[0.06] px-3 py-2">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            placeholder={search.mode === "files" ? "Search files..." : search.mode === "folders" ? "Search folders..." : "Search in files..."}
            className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-[11px] text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${search.mode === "files" ? "bg-foreground/[0.08] text-foreground/80" : "text-foreground/40"}`}
                onClick={() => search.setMode("files")}
              >
                <File className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs">File Search</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${search.mode === "content" ? "bg-foreground/[0.08] text-foreground/80" : "text-foreground/40"}`}
                onClick={() => search.setMode("content")}
              >
                <AlignLeft className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs">Content Search</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${search.mode === "folders" ? "bg-foreground/[0.08] text-foreground/80" : "text-foreground/40"}`}
                onClick={() => search.setMode("folders")}
              >
                <FolderSearch className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs">Folder Search</p></TooltipContent>
          </Tooltip>

          <div className="mx-1 h-3 w-px bg-foreground/[0.08]" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 ${search.caseSensitive ? "bg-foreground/[0.08] text-foreground/80" : "text-foreground/40"}`}
                onClick={search.toggleCaseSensitive}
              >
                <CaseSensitive className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p className="text-xs">Match Case</p></TooltipContent>
          </Tooltip>
          {search.mode === "content" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-6 w-6 ${search.isRegex ? "bg-foreground/[0.08] text-foreground/80" : "text-foreground/40"}`}
                  onClick={search.toggleRegex}
                >
                  <Regex className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom"><p className="text-xs">Use Regex</p></TooltipContent>
            </Tooltip>
          )}

          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className={`h-6 w-6 ${showFilters ? "bg-foreground/[0.08] text-foreground/70" : "text-foreground/40"}`}
            onClick={() => setShowFilters((p) => !p)}
          >
            {showFilters ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </Button>
        </div>

        {showFilters && (
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-[9px] font-medium text-foreground/40 w-10">Include</span>
              <input
                type="text"
                value={search.include}
                onChange={(e) => search.setInclude(e.target.value)}
                placeholder="*.tsx, *.ts, src/**"
                className="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-[10px] text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-[9px] font-medium text-foreground/40 w-10">Exclude</span>
              <input
                type="text"
                value={search.exclude}
                onChange={(e) => search.setExclude(e.target.value)}
                placeholder="node_modules, dist, *.test.*"
                className="h-5 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-[10px] text-foreground/85 outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {search.mode === "files" && search.fileResults.length > 0 && (
          <div className="py-1">
            {search.fileResults.map((r) => (
              <button
                key={r.path}
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-[3px] text-[10px] transition-colors hover:bg-foreground/[0.03] cursor-pointer"
                onClick={() => onOpenFile?.(r.path)}
              >
                <FileText className="h-3 w-3 shrink-0 text-foreground/30" />
                <span className="shrink-0 font-medium text-foreground/80">{r.name}</span>
                {r.dir && (
                  <span className="min-w-0 truncate text-foreground/40">{r.dir}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {search.mode === "folders" && search.fileResults.length > 0 && (
          <div className="py-1">
            {search.fileResults.map((r) => (
              <button
                key={r.dir || r.path}
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-[3px] text-[10px] transition-colors hover:bg-foreground/[0.03] cursor-pointer"
                onClick={() => onOpenFile?.(r.dir || r.path)}
              >
                <FolderSearch className="h-3 w-3 shrink-0 text-foreground/30" />
                <span className="min-w-0 truncate font-medium text-foreground/70">{r.dir || "."}</span>
              </button>
            ))}
          </div>
        )}

        {search.mode === "content" && groupedContent.size > 0 && (
          <div className="py-1">
            {Array.from(groupedContent.entries()).map(([file, matches]) => (
              <div key={file}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-3 py-[3px] transition-colors hover:bg-foreground/[0.03] cursor-pointer"
                  onClick={() => toggleFileCollapse(file)}
                >
                  {collapsedFiles.has(file) ? (
                    <ChevronRight className="h-3 w-3 shrink-0 text-foreground/40" />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0 text-foreground/40" />
                  )}
                  <FileText className="h-3 w-3 shrink-0 text-foreground/30" />
                  <span className="min-w-0 truncate text-[10px] font-medium text-foreground/70">{file}</span>
                  <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 py-px text-[9px] font-medium tabular-nums text-foreground/45">
                    {matches.length}
                  </span>
                </button>
                {!collapsedFiles.has(file) &&
                  matches.map((m, i) => (
                    <button
                      key={`${file}-${m.line}-${i}`}
                      type="button"
                      className="flex w-full items-center gap-1.5 pe-3 ps-8 py-[2px] text-[10px] transition-colors hover:bg-foreground/[0.03] cursor-pointer"
                      onClick={() => onOpenFile?.(file)}
                    >
                      <span className="shrink-0 w-8 text-end font-mono text-foreground/35 tabular-nums">
                        {m.line}
                      </span>
                      <span className="min-w-0 truncate font-mono text-foreground/65">
                        {m.preview}
                      </span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}

        {search.query && !search.isSearching && search.fileResults.length === 0 && search.contentResults.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-1.5 py-8">
            <p className="text-[11px] text-foreground/40">No results found</p>
          </div>
        )}
      </ScrollArea>

      {search.query && (
        <div className="border-t border-foreground/[0.06] px-3 py-1 text-[10px] text-foreground/40">
          {search.mode === "files"
            ? `${search.fileResults.length} files found`
            : search.mode === "folders"
            ? `${search.fileResults.length} folders found`
            : `${search.totalContentCount} results in ${groupedContent.size} files`}
        </div>
      )}
    </div>
  );
});
