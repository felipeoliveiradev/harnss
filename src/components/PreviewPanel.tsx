import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RotateCw,
  Smartphone,
  Tablet,
  Monitor,
  Play,
  Square,
  ExternalLink,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelHeader } from "@/components/PanelHeader";
import type { UIMessage } from "@/types/ui";

interface ElectronWebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  reload(): void;
  executeJavaScript(code: string): Promise<unknown>;
}

type DevicePreset = "mobile" | "tablet" | "desktop";

type ServerStatus = "stopped" | "starting" | "running";

interface PreviewPanelProps {
  cwd: string | null;
  sessionId: string | null;
  messages: UIMessage[];
}

const WEB_FILE_EXTENSIONS = [".html", ".htm", ".css", ".js", ".jsx", ".tsx"];
const HTML_EXTENSIONS = [".html", ".htm"];

function getFilePathFromMessage(msg: UIMessage): string | null {
  if (msg.role !== "tool_call") return null;
  if (msg.toolName !== "Write" && msg.toolName !== "Edit") return null;
  const filePath = msg.toolInput?.file_path;
  if (typeof filePath !== "string") return null;
  const lower = filePath.toLowerCase();
  if (WEB_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return filePath;
  return null;
}

function isHtmlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

const DEVICE_PRESETS: Array<{ id: DevicePreset; icon: typeof Monitor; label: string; width: string | null }> = [
  { id: "mobile", icon: Smartphone, label: "Mobile (375px)", width: "375px" },
  { id: "tablet", icon: Tablet, label: "Tablet (768px)", width: "768px" },
  { id: "desktop", icon: Monitor, label: "Desktop", width: null },
];

function PreviewPanelInner({ cwd, sessionId, messages }: PreviewPanelProps) {
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const [device, setDevice] = useState<DevicePreset>("desktop");
  const [serverStatus, setServerStatus] = useState<ServerStatus>("stopped");
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [trackedHtmlFile, setTrackedHtmlFile] = useState<string | null>(null);
  const lastProcessedIndexRef = useRef(0);

  const isDevServer = serverStatus !== "stopped";
  const previewUrl = serverPort ? `http://localhost:${serverPort}` : null;

  const statusColor = useMemo(() => {
    if (serverStatus === "running") return "bg-emerald-500";
    if (serverStatus === "starting") return "bg-yellow-500 animate-pulse";
    if (htmlContent) return "bg-emerald-500";
    return "bg-foreground/20";
  }, [serverStatus, htmlContent]);

  const statusLabel = useMemo(() => {
    if (serverStatus === "running" && previewUrl) return previewUrl;
    if (serverStatus === "starting") return "Starting server...";
    if (htmlContent) return "HTML Preview";
    return "No preview";
  }, [serverStatus, previewUrl, htmlContent]);

  const loadHtmlContent = useCallback(async (filePath: string) => {
    if (!cwd) return;
    try {
      const content = await window.electronAPI.previewReadHtml({ cwd, filePath });
      if (typeof content === "string") {
        setHtmlContent(content);
        setTrackedHtmlFile(filePath);
      }
    } catch {
      // file read failed
    }
  }, [cwd]);

  useEffect(() => {
    if (isDevServer || !cwd) return;

    const newMessages = messages.slice(lastProcessedIndexRef.current);
    lastProcessedIndexRef.current = messages.length;

    let htmlFileToLoad: string | null = null;
    let needsRefresh = false;

    for (const msg of newMessages) {
      const filePath = getFilePathFromMessage(msg);
      if (!filePath) continue;

      if (isHtmlFile(filePath)) {
        htmlFileToLoad = filePath;
      } else if (trackedHtmlFile) {
        needsRefresh = true;
      }
    }

    if (htmlFileToLoad) {
      void loadHtmlContent(htmlFileToLoad);
    } else if (needsRefresh && trackedHtmlFile) {
      void loadHtmlContent(trackedHtmlFile);
    }
  }, [messages, cwd, isDevServer, trackedHtmlFile, loadHtmlContent]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !htmlContent || isDevServer) return;
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(htmlContent);
    wv.loadURL(dataUrl).catch(() => {});
  }, [htmlContent, isDevServer]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !previewUrl || serverStatus !== "running") return;
    wv.loadURL(previewUrl).catch(() => {});
  }, [previewUrl, serverStatus]);

  const handleStartServer = useCallback(async () => {
    if (!sessionId || !cwd) return;
    setServerStatus("starting");
    try {
      const result = await window.electronAPI.previewStart({ sessionId, cwd });
      if (result && typeof result.port === "number") {
        setServerPort(result.port);
        setServerStatus("running");
      } else {
        setServerStatus("stopped");
      }
    } catch {
      setServerStatus("stopped");
    }
  }, [sessionId, cwd]);

  const handleStopServer = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.electronAPI.previewStop(sessionId);
    } catch {
      // stop failed
    }
    setServerStatus("stopped");
    setServerPort(null);
  }, [sessionId]);

  const handleRefresh = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (isDevServer) {
      wv.reload();
    } else if (trackedHtmlFile) {
      void loadHtmlContent(trackedHtmlFile);
    }
  }, [isDevServer, trackedHtmlFile, loadHtmlContent]);

  const handleOpenInBrowser = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const url = wv.getURL();
    if (url && url !== "about:blank") {
      window.open(url, "_blank");
    }
  }, []);

  useEffect(() => {
    return () => {
      if (sessionId && serverStatus !== "stopped") {
        window.electronAPI.previewStop(sessionId).catch(() => {});
      }
    };
  }, [sessionId, serverStatus]);

  const deviceWidth = DEVICE_PRESETS.find((d) => d.id === device)?.width;

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        icon={Eye}
        label="Preview"
        iconClass="text-violet-600/70 dark:text-violet-200/50"
      >
        <div className="flex h-2 w-2 items-center justify-center">
          <div className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
        </div>
        <span className="max-w-32 truncate text-[10px] text-foreground/40">
          {statusLabel}
        </span>
      </PanelHeader>

      <div className="flex items-center gap-1 px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-foreground/30 hover:text-foreground/60"
              onClick={handleRefresh}
            >
              <RotateCw className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-3.5 w-px bg-foreground/[0.08]" />

        {DEVICE_PRESETS.map((preset) => {
          const Icon = preset.icon;
          const isActive = device === preset.id;
          return (
            <Tooltip key={preset.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-6 w-6 shrink-0 ${
                    isActive
                      ? "bg-foreground/[0.08] text-foreground/70"
                      : "text-foreground/30 hover:text-foreground/60"
                  }`}
                  onClick={() => setDevice(preset.id)}
                >
                  <Icon className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{preset.label}</TooltipContent>
            </Tooltip>
          );
        })}

        <div className="mx-1 h-3.5 w-px bg-foreground/[0.08]" />

        {serverStatus === "stopped" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-foreground/30 hover:text-emerald-500/80"
                onClick={() => { void handleStartServer(); }}
                disabled={!sessionId || !cwd}
              >
                <Play className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Start Dev Server</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-foreground/30 hover:text-red-500/80"
                onClick={() => { void handleStopServer(); }}
              >
                <Square className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Stop Dev Server</TooltipContent>
          </Tooltip>
        )}

        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-foreground/30 hover:text-foreground/60"
              onClick={handleOpenInBrowser}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in Browser</TooltipContent>
        </Tooltip>
      </div>

      <div className="h-px bg-gradient-to-r from-foreground/[0.04] via-foreground/[0.08] to-foreground/[0.04]" />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full items-start justify-center overflow-auto">
          <div
            className={`h-full transition-all duration-200 ${
              deviceWidth ? "border-x border-foreground/[0.06] shadow-sm" : ""
            }`}
            style={{
              width: deviceWidth ?? "100%",
              maxWidth: "100%",
            }}
          >
            <webview
              ref={webviewRef as React.RefObject<ElectronWebviewElement>}
              src="about:blank"
              className="h-full w-full"
              {...({
                allowpopups: "true",
                partition: "persist:preview",
              } as Record<string, string>)}
            />
          </div>
        </div>

        {!htmlContent && serverStatus === "stopped" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.03]">
              <Eye className="h-5 w-5 text-violet-600/70 dark:text-violet-200/50" />
            </div>
            <div className="text-center">
              <p className="text-[13px] font-medium text-foreground/50">No preview yet</p>
              <p className="mt-1 text-[11px] text-foreground/30">
                Write an HTML file or start a dev server
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const PreviewPanel = memo(PreviewPanelInner);
