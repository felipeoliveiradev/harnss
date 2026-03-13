import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { parseQuickOpenQuery, rankQuickOpenMatches } from "@/lib/quick-open";
import { reportError } from "@/lib/analytics";

interface QuickOpenDialogProps {
  open: boolean;
  cwd?: string;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (absolutePath: string, line?: number) => void;
}

export const QuickOpenDialog = memo(function QuickOpenDialog({
  open,
  cwd,
  onOpenChange,
  onOpenFile,
}: QuickOpenDialogProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    window.claude.files.listAll(cwd)
      .then((result) => {
        if (cancelled) return;
        setFiles(result.files);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = reportError("QUICK_OPEN_LIST_FILES_ERR", err, { cwd });
        setError(message);
        setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, open]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const matches = useMemo(
    () => rankQuickOpenMatches(files, query, 300),
    [files, query],
  );

  useEffect(() => {
    if (selectedIndex >= matches.length) {
      setSelectedIndex(0);
    }
  }, [matches.length, selectedIndex]);

  const handlePick = useCallback((relativePath: string) => {
    if (!cwd) return;
    const parsed = parseQuickOpenQuery(query);
    onOpenFile(`${cwd}/${relativePath}`, parsed.line);
    onOpenChange(false);
  }, [cwd, onOpenChange, onOpenFile, query]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (matches.length === 0 ? 0 : (prev + 1) % matches.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (matches.length === 0 ? 0 : (prev - 1 + matches.length) % matches.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = matches[selectedIndex];
      if (item) handlePick(item.path);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }, [handlePick, matches, onOpenChange, selectedIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-2xl p-0" showCloseButton={false}>
        <div className="border-b border-foreground/[0.08] px-4 py-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground/60" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Go to file... (ex: src/App.tsx:42)"
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground/70">
              <Loader2 className="h-4 w-4 animate-spin" />
              Indexing project files...
            </div>
          )}

          {!loading && error && (
            <p className="px-4 py-6 text-xs text-destructive">{error}</p>
          )}

          {!loading && !error && matches.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground/70">No matching files</p>
          )}

          {!loading && !error && matches.map((item, index) => {
            const fileName = item.path.split("/").pop() ?? item.path;
            const dir = item.path.slice(0, Math.max(0, item.path.length - fileName.length)).replace(/\/$/, "");
            const isSelected = index === selectedIndex;

            return (
              <button
                key={item.path}
                type="button"
                onClick={() => handlePick(item.path)}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left transition-colors ${
                  isSelected ? "bg-foreground/[0.08]" : "hover:bg-foreground/[0.04]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">{fileName}</span>
                <span className="truncate text-xs text-muted-foreground/60">{dir}</span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
});
