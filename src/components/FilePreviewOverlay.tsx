import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, File, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OpenInEditorButton } from "./OpenInEditorButton";
import { useResolvedThemeClass } from "@/hooks/useResolvedThemeClass";
import { getLanguageFromPath } from "@/lib/languages";
import { getMonacoLanguageFromPath } from "@/lib/monaco";
import { captureException } from "@/lib/analytics";

const MonacoEditor = lazy(() =>
  import("@monaco-editor/react").then((mod) => ({ default: mod.default })),
);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Props ──

interface FilePreviewOverlayProps {
  filePath: string | null;
  sourceRect: DOMRect | null;
  onClose: () => void;
}

// ── Floating preview dimensions ──
const PREVIEW_MAX_WIDTH = 1040;
const PREVIEW_MAX_HEIGHT_VH = 78;

// ── Component ──

export const FilePreviewOverlay = memo(function FilePreviewOverlay({
  filePath,
  sourceRect,
  onClose,
}: FilePreviewOverlayProps) {
  return (
    <AnimatePresence mode="wait">
      {filePath && (
        <OverlayContent
          key={filePath}
          filePath={filePath}
          sourceRect={sourceRect}
          onClose={onClose}
        />
      )}
    </AnimatePresence>
  );
});

// ── Inner content (separate for AnimatePresence keying) ──

interface OverlayContentProps {
  filePath: string;
  sourceRect: DOMRect | null;
  onClose: () => void;
}

const OverlayContent = memo(function OverlayContent({
  filePath,
  sourceRect,
  onClose,
}: OverlayContentProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const resolvedTheme = useResolvedThemeClass();

  // Load file content
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    window.claude
      .readFile(filePath)
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
        } else {
          setContent(result.content ?? "");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        captureException(err instanceof Error ? err : new Error(String(err)), { label: "FILE_READ_ERR" });
        setError(err instanceof Error ? err.message : "Failed to read file");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // File metadata
  const fileName = filePath.split("/").pop() ?? filePath;
  const dirPath = filePath.split("/").slice(0, -1).join("/");
  const language = getLanguageFromPath(filePath);
  const monacoLang = getMonacoLanguageFromPath(filePath);
  const lineCount = content ? content.split("\n").length : 0;
  const fileSize = content ? formatFileSize(new Blob([content]).size) : "";

  const initialTransform = useMemo(() => {
    if (!sourceRect) return { y: 14, scale: 0.985, opacity: 0 };
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const sourceX = sourceRect.left + sourceRect.width / 2;
    const sourceY = sourceRect.top + sourceRect.height / 2;
    return {
      x: (sourceX - viewportW / 2) * 0.12,
      y: (sourceY - viewportH / 2) * 0.12,
      scale: 0.985,
      opacity: 0,
    };
  }, [sourceRect]);

  return (
    <motion.div
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <motion.div
        className="pointer-events-auto flex h-[78vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-foreground/12 bg-background/97 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)] backdrop-blur-md"
        style={{
          width: Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - 120),
          maxHeight: `${PREVIEW_MAX_HEIGHT_VH}vh`,
        }}
        initial={initialTransform}
        animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 8, scale: 0.99, opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 300, mass: 0.72 }}
      >
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-foreground/[0.08] px-4 py-2.5">
            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-foreground">{fileName}</span>
              <span className="ms-2 truncate text-xs text-muted-foreground/60">{dirPath}</span>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <OpenInEditorButton filePath={filePath} className="!text-muted-foreground/40 hover:!text-muted-foreground" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  <p className="text-xs">Open in editor</p>
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md
                  text-muted-foreground/40 transition-colors duration-150
                  hover:text-foreground hover:bg-foreground/[0.06]
                  active:scale-90"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Editor content */}
          <div className="relative flex-1 overflow-hidden" style={{ minHeight: 360 }}>
            {loading && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
              </div>
            )}

            {error && (
              <div className="flex h-full items-center justify-center p-6">
                <p className="text-center text-sm text-muted-foreground/60">{error}</p>
              </div>
            )}

            {content !== null && !loading && (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
                  </div>
                }
              >
                <MonacoEditor
                  height="100%"
                  language={monacoLang}
                  value={content}
                  theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
                  options={{
                    readOnly: true,
                    minimap: { enabled: true },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: "on",
                    wordWrap: "on",
                    automaticLayout: true,
                    domReadOnly: true,
                    renderLineHighlight: "none",
                    overviewRulerLanes: 0,
                    hideCursorInOverviewRuler: true,
                    scrollbar: {
                      verticalScrollbarSize: 8,
                      horizontalScrollbarSize: 8,
                    },
                    padding: { top: 8, bottom: 8 },
                  }}
                  loading={
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
                    </div>
                  }
                />
              </Suspense>
            )}
          </div>

          {/* Footer */}
          {content !== null && !loading && (
            <div className="flex items-center gap-3 border-t border-foreground/[0.08] px-4 py-1.5">
              <span className="text-[11px] text-muted-foreground/50">
                {lineCount} {lineCount === 1 ? "line" : "lines"}
              </span>
              <span className="text-[11px] text-muted-foreground/30">•</span>
              <span className="text-[11px] text-muted-foreground/50">{language}</span>
              <span className="text-[11px] text-muted-foreground/30">•</span>
              <span className="text-[11px] text-muted-foreground/50">{fileSize}</span>
            </div>
          )}
      </motion.div>
    </motion.div>
  );
});
