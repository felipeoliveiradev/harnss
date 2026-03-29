import { useCallback, useEffect, useRef, useState } from "react";

type PreviewMode = "none" | "srcdoc" | "dev-server";
type DevServerStatus = "stopped" | "starting" | "running" | "error";
type DeviceSize = "mobile" | "tablet" | "desktop";

interface PreviewState {
  mode: PreviewMode;
  devServerStatus: DevServerStatus;
  port: number | null;
  previewUrl: string | null;
  htmlContent: string | null;
  deviceSize: DeviceSize;
  projectType: "vite" | "nextjs" | "html" | "unknown" | null;
  lastRefresh: number;
}

const INITIAL_STATE: PreviewState = {
  mode: "none",
  devServerStatus: "stopped",
  port: null,
  previewUrl: null,
  htmlContent: null,
  deviceSize: "desktop",
  projectType: null,
  lastRefresh: 0,
};

export function usePreviewManager(sessionId: string | null, cwd: string | null) {
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const detectProject = useCallback(async () => {
    if (!cwdRef.current) return;
    try {
      const result = await window.claude.preview.detect(cwdRef.current);
      setState((prev) => ({
        ...prev,
        projectType: result.type as PreviewState["projectType"],
      }));
    } catch {
      setState((prev) => ({ ...prev, projectType: "unknown" }));
    }
  }, []);

  useEffect(() => {
    if (cwd) {
      detectProject();
    }
  }, [cwd, detectProject]);

  useEffect(() => {
    setState((prev) => ({
      ...INITIAL_STATE,
      deviceSize: prev.deviceSize,
    }));
  }, [sessionId]);

  const startDevServer = useCallback(async () => {
    if (!sessionId || !cwdRef.current) return;
    setState((prev) => ({ ...prev, devServerStatus: "starting" }));
    try {
      const result = await window.claude.preview.start({ sessionId, cwd: cwdRef.current });
      setState((prev) => ({
        ...prev,
        mode: "dev-server",
        devServerStatus: "running",
        port: result.port,
        previewUrl: `http://localhost:${result.port}`,
        projectType: result.type as PreviewState["projectType"],
      }));
    } catch {
      setState((prev) => ({ ...prev, devServerStatus: "error" }));
    }
  }, [sessionId]);

  const stopDevServer = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.claude.preview.stop(sessionId);
    } catch {
      /* already stopped */
    }
    setState((prev) => ({
      ...prev,
      mode: "none",
      devServerStatus: "stopped",
      port: null,
      previewUrl: null,
    }));
  }, [sessionId]);

  const refreshPreview = useCallback(() => {
    setState((prev) => ({ ...prev, lastRefresh: Date.now() }));
  }, []);

  const setDeviceSize = useCallback((size: DeviceSize) => {
    setState((prev) => ({ ...prev, deviceSize: size }));
  }, []);

  const loadHtmlFile = useCallback(async (filePath: string) => {
    if (!cwdRef.current) return;
    try {
      const content = await window.claude.preview.readHtml({ cwd: cwdRef.current, filePath });
      setState((prev) => ({
        ...prev,
        mode: "srcdoc",
        htmlContent: content,
      }));
    } catch {
      setState((prev) => ({ ...prev, mode: "none", htmlContent: null }));
    }
  }, []);

  return {
    ...state,
    startDevServer,
    stopDevServer,
    refreshPreview,
    setDeviceSize,
    loadHtmlFile,
    detectProject,
  };
}

export type { PreviewMode, DevServerStatus, DeviceSize, PreviewState };
