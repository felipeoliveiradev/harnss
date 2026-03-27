/**
 * useSecondaryPane — manages the right-side chat pane in split-chat mode.
 *
 * Runs independent engine hooks (useClaude / useACP / useCodex / useOllama / useOpenClaw)
 * for whatever session is assigned to pane 1. Supports both viewing existing sessions
 * AND creating new sessions (draft → materialize → live).
 *
 * Design: each engine hook filters IPC events by _sessionId, so having two
 * useClaude instances active simultaneously is safe — they never cross-talk.
 */

import { useState, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { ChatSession, UIMessage, PermissionRequest, EngineId, ImageAttachment } from "@/types";
import type { AppPermissionBehavior } from "@/types";
import type { BackgroundSessionState } from "@/lib/background-session-store";
import { captureException } from "@/lib/analytics";
import { useClaude } from "./useClaude";
import { useACP } from "./useACP";
import { useCodex } from "./useCodex";
import { useOllama } from "./useOllama";
import { useOpenClaw } from "./useOpenClaw";
import { getEffectiveClaudePermissionMode } from "./session/types";
import type { StartOptions } from "./session/types";

const DRAFT_ID = "__draft_pane1__";

export interface SecondaryPaneState {
  /** The session ID currently shown in pane 1 (null = pane is empty) */
  sessionId: string | null;
  /** The ChatSession object for pane 1 (derived from sessions list) */
  session: ChatSession | null;
  /** Messages for pane 1 */
  messages: UIMessage[];
  /** Whether pane 1 is actively processing (streaming / waiting) */
  isProcessing: boolean;
  /** Whether the underlying engine process is connected */
  isConnected: boolean;
  /** Pending tool-permission request for pane 1 */
  pendingPermission: PermissionRequest | null;
  /** Respond to a pending permission in pane 1 */
  respondPermission: (behavior: AppPermissionBehavior, updatedInput?: Record<string, unknown>, newMode?: string, updatedPerms?: unknown[]) => Promise<void>;
  /** Send a message to pane 1's session */
  send: (text: string, images?: ImageAttachment[]) => Promise<void>;
  /** Stop the current turn in pane 1 */
  stop: () => void;
  /** Interrupt the current turn in pane 1 */
  interrupt: () => void;
  /** Switch pane 1 to a different session (loads messages from store/disk) */
  switchSecondarySession: (
    sessionId: string | null,
    sessions: ChatSession[],
    getBackgroundState: (id: string) => BackgroundSessionState | undefined,
  ) => Promise<void>;
  /** Close pane 1 (clears sessionId) */
  clearSecondarySession: () => void;
  /** Whether pane 1 is in draft mode (new session, not yet materialized) */
  isDraft: boolean;
  /** Create a new draft session in pane 1 */
  createDraft: (projectId: string, options: StartOptions) => void;
  /** The project ID for the current draft */
  draftProjectId: string | null;
  /** Start options for the current draft */
  draftOptions: StartOptions;
  /** Update draft options (e.g. when user changes model/agent in pane 1) */
  setDraftOptions: React.Dispatch<React.SetStateAction<StartOptions>>;
}

export function useSecondaryPane(): SecondaryPaneState {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [activeEngine, setActiveEngine] = useState<EngineId>("claude");

  // ── Draft state ──
  const [isDraft, setIsDraft] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftOptions, setDraftOptions] = useState<StartOptions>({});
  const materializingRef = useRef(false);

  // Derive engine from draft or session
  const effectiveEngine: EngineId = isDraft
    ? (draftOptions.engine ?? "claude")
    : activeEngine;

  // Run all engine hooks — only the one matching effectiveEngine gets a non-null sessionId
  const claudeId = effectiveEngine === "claude" && !isDraft ? sessionId : null;
  const acpId = effectiveEngine === "acp" && !isDraft ? sessionId : null;
  const codexId = effectiveEngine === "codex" && !isDraft ? sessionId : null;
  const ollamaId = effectiveEngine === "ollama" && !isDraft ? sessionId : null;
  const openclawId = effectiveEngine === "openclaw" && !isDraft ? sessionId : null;

  const claude = useClaude({
    sessionId: claudeId,
    initialMessages: effectiveEngine === "claude" ? initialMessages : [],
  });

  const acp = useACP({
    sessionId: acpId,
    initialMessages: effectiveEngine === "acp" ? initialMessages : [],
  });

  const codex = useCodex({
    sessionId: codexId,
    initialMessages: effectiveEngine === "codex" ? initialMessages : [],
  });

  const ollama = useOllama({
    sessionId: ollamaId,
    initialMessages: effectiveEngine === "ollama" ? initialMessages : [],
  });

  const openclawHook = useOpenClaw({
    sessionId: openclawId,
    initialMessages: effectiveEngine === "openclaw" ? initialMessages : [],
  });

  // Pick the active engine's state
  const engine =
    effectiveEngine === "ollama" ? ollama :
    effectiveEngine === "openclaw" ? openclawHook :
    effectiveEngine === "codex" ? codex :
    effectiveEngine === "acp" ? acp :
    claude;

  const switchSecondarySession = useCallback(
    async (
      newSessionId: string | null,
      sessions: ChatSession[],
      getBackgroundState: (id: string) => BackgroundSessionState | undefined,
    ) => {
      // Switching to an existing session clears any draft
      setIsDraft(false);
      setDraftProjectId(null);
      setDraftOptions({});

      if (!newSessionId) {
        setSessionId(null);
        setSession(null);
        setInitialMessages([]);
        return;
      }

      const session = sessions.find((s) => s.id === newSessionId);
      const engine: EngineId = session?.engine ?? "claude";
      setSession(session ?? null);

      // 1. Try BackgroundSessionStore first (live in-memory state, has latest msgs)
      const stored = getBackgroundState(newSessionId);
      if (stored && stored.messages.length > 0) {
        setActiveEngine(engine);
        setInitialMessages(stored.messages);
        setSessionId(newSessionId);
        return;
      }

      // 2. Fall back to persisted session on disk
      if (session) {
        try {
          const persisted = await window.claude.sessions.load(session.projectId, newSessionId);
          const msgs: UIMessage[] = persisted?.messages ?? [];
          setActiveEngine(engine);
          setInitialMessages(msgs);
          setSessionId(newSessionId);
          return;
        } catch {
          // Silently fall through — open empty pane rather than showing an error
        }
      }

      // 3. Open empty pane for sessions with no persisted history yet
      setActiveEngine(engine);
      setInitialMessages([]);
      setSessionId(newSessionId);
    },
    [],
  );

  const clearSecondarySession = useCallback(() => {
    setSessionId(null);
    setSession(null);
    setInitialMessages([]);
    setIsDraft(false);
    setDraftProjectId(null);
    setDraftOptions({});
  }, []);

  // ── Draft creation ──
  const createDraft = useCallback((projectId: string, options: StartOptions) => {
    // Clear any existing session
    setSessionId(null);
    setSession(null);
    setInitialMessages([]);

    // Set draft state
    setIsDraft(true);
    setDraftProjectId(projectId);
    setDraftOptions(options);
    setActiveEngine(options.engine ?? "claude");
  }, []);

  // ── Materialization: draft → live session on first message ──
  const materializeDraft = useCallback(async (
    text: string,
    images?: ImageAttachment[],
    projectId?: string | null,
    options?: StartOptions,
  ): Promise<string> => {
    if (materializingRef.current) return "";
    materializingRef.current = true;

    if (!projectId) {
      materializingRef.current = false;
      return "";
    }

    const draftEngine = options?.engine ?? "claude";
    let newSessionId: string;

    try {
      if (draftEngine === "acp" && options?.agentId) {
        const result = await window.claude.acp.start({
          agentId: options.agentId,
          cwd: await getProjectCwd(projectId),
        });
        if (result.cancelled || result.error || !result.sessionId) {
          const msg = result.error || "Failed to start ACP agent";
          toast.error("Failed to start agent", { description: msg });
          materializingRef.current = false;
          return "";
        }
        newSessionId = result.sessionId;
      } else if (draftEngine === "ollama") {
        const result = await window.claude.ollama.start({
          cwd: await getProjectCwd(projectId),
          ...(options?.model ? { model: options.model } : {}),
        });
        if (result.error || !result.sessionId) {
          const msg = result.error || "Failed to connect to Ollama";
          toast.error("Failed to start Ollama", { description: msg });
          materializingRef.current = false;
          return "";
        }
        newSessionId = result.sessionId;
      } else if (draftEngine === "openclaw") {
        const result = await window.claude.openclaw.start({
          cwd: await getProjectCwd(projectId),
          ...(options?.model ? { model: options.model } : {}),
        });
        if (result.error || !result.sessionId) {
          const msg = result.error || "Failed to connect to OpenClaw";
          toast.error("Failed to start OpenClaw", { description: msg });
          materializingRef.current = false;
          return "";
        }
        newSessionId = result.sessionId;
      } else if (draftEngine === "codex") {
        const result = await window.claude.codex.start({
          cwd: await getProjectCwd(projectId),
          ...(options?.model ? { model: options.model } : {}),
        });
        if (result.error || !result.sessionId) {
          const msg = result.error || "Failed to start Codex";
          toast.error("Failed to start Codex", { description: msg });
          materializingRef.current = false;
          return "";
        }
        newSessionId = result.sessionId;
      } else {
        // Claude engine
        const mcpServers = await window.claude.mcp.list(projectId);
        const result = await window.claude.start({
          cwd: await getProjectCwd(projectId),
          model: options?.model,
          permissionMode: getEffectiveClaudePermissionMode(options ?? {}),
          thinkingEnabled: options?.thinkingEnabled,
          effort: options?.effort,
          mcpServers,
        });
        if (result.error) {
          toast.error("Failed to start Claude", { description: result.error });
          materializingRef.current = false;
          return "";
        }
        newSessionId = result.sessionId;
      }
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), { label: "PANE1_MATERIALIZE_ERR" });
      toast.error("Failed to start session", {
        description: err instanceof Error ? err.message : String(err),
      });
      materializingRef.current = false;
      return "";
    }

    // Transition from draft to live session
    const now = Date.now();
    const newSession: ChatSession = {
      id: newSessionId,
      projectId,
      title: "New Chat",
      createdAt: now,
      lastMessageAt: now,
      model: options?.model,
      planMode: !!options?.planMode,
      totalCost: 0,
      isActive: false, // pane 1 sessions are never "active" in the primary manager
      titleGenerating: true,
      engine: draftEngine,
      ...(draftEngine === "acp" && options?.agentId ? { agentId: options.agentId } : {}),
      ...(draftEngine === "codex" ? { agentId: options?.agentId ?? "codex" } : {}),
    };

    // Set up initial messages for the engine hook
    if (draftEngine === "acp" || draftEngine === "ollama" || draftEngine === "openclaw") {
      setInitialMessages([{
        id: `user-${now}`,
        role: "user" as const,
        content: text,
        timestamp: now,
        ...(images?.length ? { images } : {}),
      }]);
    } else {
      setInitialMessages([]);
    }

    setIsDraft(false);
    setDraftProjectId(null);
    setSession(newSession);
    setActiveEngine(draftEngine);
    setSessionId(newSessionId);

    // Generate title
    getProjectCwd(projectId).then((cwd) => {
      window.claude.generateTitle(text, cwd).then((result) => {
        if (result.title) {
          setSession((prev) => prev && prev.id === newSessionId ? { ...prev, title: result.title!, titleGenerating: false } : prev);
        }
      }).catch(() => {});
    }).catch(() => {});

    // Save persisted session and notify sidebar
    window.claude.sessions.save({
      id: newSessionId,
      projectId,
      title: "New Chat",
      createdAt: now,
      messages: [],
      planMode: !!options?.planMode,
      totalCost: 0,
      engine: draftEngine,
      ...(draftEngine === "acp" && options?.agentId ? { agentId: options.agentId } : {}),
    });
    window.dispatchEvent(new CustomEvent("harnss:session-saved"));

    materializingRef.current = false;
    return newSessionId;
  }, []);

  const noopRespond: SecondaryPaneState["respondPermission"] = useCallback(async () => {}, []);
  const noopSend = useCallback(async () => {}, []);
  const noopVoid = useCallback(() => {}, []);

  // Stable send that handles draft materialization
  const engineSendRef = useRef(engine.send);
  engineSendRef.current = engine.send;
  const draftRef = useRef({ isDraft, draftProjectId, draftOptions });
  draftRef.current = { isDraft, draftProjectId, draftOptions };

  const stableSend = useCallback(async (text: string, images?: ImageAttachment[]) => {
    const { isDraft: currentDraft, draftProjectId: pid, draftOptions: opts } = draftRef.current;

    if (currentDraft && pid) {
      // Materialize the draft first, then send
      const newId = await materializeDraft(text, images, pid, opts);
      if (!newId) return;
      // For engines that need explicit send after start (claude, codex):
      const eng = opts.engine ?? "claude";
      if (eng === "claude" || eng === "codex") {
        // Wait a tick for the engine hook to pick up the new sessionId
        await new Promise((r) => setTimeout(r, 100));
        await engineSendRef.current(text, images);
      } else if (eng === "acp") {
        // ACP sends via prompt
        await window.claude.acp.prompt(newId, text);
      } else if (eng === "ollama") {
        await window.claude.ollama.send(newId, text);
      } else if (eng === "openclaw") {
        await window.claude.openclaw.send(newId, text);
      }
    } else {
      await engineSendRef.current(text, images);
    }
  }, [materializeDraft]);

  const respondPermission = "respondPermission" in engine ? engine.respondPermission : noopRespond;
  const send = "send" in engine || isDraft ? stableSend : noopSend;
  const stop = "stop" in engine ? engine.stop : noopVoid;
  const interrupt = "interrupt" in engine ? engine.interrupt : noopVoid;

  return useMemo(() => ({
    sessionId: isDraft ? DRAFT_ID : sessionId,
    session,
    messages: engine.messages,
    isProcessing: engine.isProcessing,
    isConnected: engine.isConnected,
    pendingPermission: engine.pendingPermission,
    respondPermission,
    send,
    stop,
    interrupt,
    switchSecondarySession,
    clearSecondarySession,
    isDraft,
    createDraft,
    draftProjectId,
    draftOptions,
    setDraftOptions,
  }), [
    sessionId, session, engine.messages, engine.isProcessing, engine.isConnected,
    engine.pendingPermission, respondPermission, send, stop, interrupt,
    switchSecondarySession, clearSecondarySession,
    isDraft, createDraft, draftProjectId, draftOptions,
  ]);
}

/** Helper to get project cwd from project ID */
async function getProjectCwd(projectId: string): Promise<string> {
  const projects = await window.claude.projects.list();
  const project = projects.find((p: { id: string; path: string }) => p.id === projectId);
  return project?.path ?? "";
}
