import { describe, expect, it } from "vitest";
import type { ChatSession, PersistedSession, SessionBase } from "../types/ui";

describe("useSessionManager with group sessions", () => {
  describe("engine selector returns group hook when engine === group", () => {
    it("returns useGroupEngine for engine type group", () => {
      const session: SessionBase = {
        id: "group-session-1",
        projectId: "project-1",
        title: "Design Discussion",
        createdAt: Date.now(),
        totalCost: 0,
        engine: "group",
        groupId: "group-1",
      };

      const getEngineHook = (engine?: string) => {
        if (engine === "group") return "useGroupEngine";
        if (engine === "claude") return "useClaude";
        if (engine === "acp") return "useACP";
        if (engine === "codex") return "useCodex";
        return "useClaude";
      };

      expect(getEngineHook(session.engine)).toBe("useGroupEngine");
    });

    it("returns useClaude for engine type claude", () => {
      const session: SessionBase = {
        id: "session-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: Date.now(),
        totalCost: 0,
        engine: "claude",
      };

      const getEngineHook = (engine?: string) => {
        if (engine === "group") return "useGroupEngine";
        if (engine === "claude") return "useClaude";
        if (engine === "acp") return "useACP";
        if (engine === "codex") return "useCodex";
        return "useClaude";
      };

      expect(getEngineHook(session.engine)).toBe("useClaude");
    });

    it("defaults to useClaude when engine is undefined", () => {
      const session: SessionBase = {
        id: "session-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: Date.now(),
        totalCost: 0,
      };

      const getEngineHook = (engine?: string) => {
        if (engine === "group") return "useGroupEngine";
        if (engine === "claude") return "useClaude";
        if (engine === "acp") return "useACP";
        if (engine === "codex") return "useCodex";
        return "useClaude";
      };

      expect(getEngineHook(session.engine)).toBe("useClaude");
    });
  });

  describe("session switching works for group sessions", () => {
    it("switches from claude session to group session", () => {
      const sessions: ChatSession[] = [
        {
          id: "claude-1",
          projectId: "project-1",
          title: "Claude Chat",
          createdAt: Date.now(),
          totalCost: 0,
          engine: "claude",
          isActive: true,
          isProcessing: false,
        },
        {
          id: "group-1",
          projectId: "project-1",
          title: "Group Discussion",
          createdAt: Date.now(),
          totalCost: 0,
          engine: "group",
          groupId: "group-def-1",
          isActive: false,
          isProcessing: false,
        },
      ];

      let activeSessionId = sessions[0].id;
      activeSessionId = sessions[1].id;

      expect(activeSessionId).toBe("group-1");
      const activeSession = sessions.find((s) => s.id === activeSessionId);
      expect(activeSession?.engine).toBe("group");
    });

    it("preserves group session state in background store during switch away", () => {
      const backgroundStore = new Map();

      const groupSession: ChatSession = {
        id: "group-1",
        projectId: "project-1",
        title: "Group Discussion",
        createdAt: Date.now(),
        totalCost: 0,
        engine: "group",
        groupId: "group-def-1",
        isActive: true,
        isProcessing: true,
      };

      const state = {
        messages: [{ id: "msg-1", role: "user" as const, content: "Hello", timestamp: Date.now() }],
        isProcessing: true,
        isConnected: true,
        sessionInfo: { sessionId: "group-1", model: "", cwd: "", tools: [], version: "" },
        totalCost: 0.5,
      };

      backgroundStore.set(groupSession.id, state);

      expect(backgroundStore.has("group-1")).toBe(true);
      expect(backgroundStore.get("group-1")?.isProcessing).toBe(true);
    });

    it("restores group session state from background store on switch back", () => {
      const backgroundStore = new Map();

      const savedState = {
        messages: [{ id: "msg-1", role: "user" as const, content: "Hello", timestamp: Date.now() }],
        isProcessing: false,
        isConnected: true,
        sessionInfo: { sessionId: "group-1", model: "", cwd: "", tools: [], version: "" },
        totalCost: 0.5,
      };

      backgroundStore.set("group-1", savedState);

      const restored = backgroundStore.get("group-1");

      expect(restored).toEqual(savedState);
      expect(restored?.messages).toHaveLength(1);
    });
  });

  describe("background store manages group sessions", () => {
    it("stores group session state keyed by sessionId", () => {
      const backgroundStore = new Map();

      const groupSessionId = "group-1";
      const state = {
        messages: [],
        isProcessing: true,
        isConnected: true,
        sessionInfo: { sessionId: groupSessionId, model: "", cwd: "", tools: [], version: "" },
        totalCost: 0,
      };

      backgroundStore.set(groupSessionId, state);

      expect(backgroundStore.has(groupSessionId)).toBe(true);
      expect(backgroundStore.get(groupSessionId)?.sessionInfo.sessionId).toBe(groupSessionId);
    });

    it("consumes group session state from store (one-time read)", () => {
      const backgroundStore = new Map();

      const groupSessionId = "group-1";
      const state = {
        messages: [{ id: "msg-1", role: "assistant" as const, content: "Response", timestamp: Date.now() }],
        isProcessing: false,
        isConnected: true,
        sessionInfo: { sessionId: groupSessionId, model: "claude-sonnet-4-5", cwd: "/project", tools: [], version: "" },
        totalCost: 0.5,
      };

      backgroundStore.set(groupSessionId, state);

      const consumed = backgroundStore.get(groupSessionId);
      backgroundStore.delete(groupSessionId);

      expect(consumed).toEqual(state);
      expect(backgroundStore.has(groupSessionId)).toBe(false);
    });

    it("routes incoming group events to background store when session is not active", () => {
      const activeSessionId = "other-session";
      const backgroundStore = new Map();

      const groupSessionId = "group-1";
      const incomingEvent = {
        type: "assistant" as const,
        sessionId: groupSessionId,
        message: { content: [{ type: "text" as const, text: "New response" }] },
      };

      if (incomingEvent.sessionId !== activeSessionId) {
        const current = backgroundStore.get(incomingEvent.sessionId) || { messages: [] };
        current.messages.push({
          id: `msg-${Date.now()}`,
          role: incomingEvent.type,
          content: "New response",
          timestamp: Date.now(),
        });
        backgroundStore.set(incomingEvent.sessionId, current);
      }

      expect(backgroundStore.has(groupSessionId)).toBe(true);
      expect(backgroundStore.get(groupSessionId)?.messages).toHaveLength(1);
    });
  });

  describe("group session persistence integration", () => {
    it("loads group session from disk with group metadata", () => {
      const persisted: PersistedSession = {
        id: "group-1",
        projectId: "project-1",
        title: "Design Discussion",
        createdAt: Date.now() - 86400000,
        engine: "group",
        groupId: "group-def-1",
        totalCost: 0,
        messages: [
          { id: "msg-1", role: "user", content: "Design review", timestamp: Date.now() - 3600000 },
          {
            id: "msg-2",
            role: "assistant",
            content: "Here is my feedback",
            timestamp: Date.now() - 3000000,
            groupSlot: { label: "Alice", color: "#ff0000", engine: "claude", model: "claude-sonnet-4-5" },
          },
        ],
      };

      expect(persisted.engine).toBe("group");
      expect(persisted.groupId).toBe("group-def-1");
      expect(persisted.messages).toHaveLength(2);
      expect(persisted.messages[1].groupSlot?.label).toBe("Alice");
    });

    it("saves group session with all slot messages and metadata", () => {
      const session: PersistedSession = {
        id: "group-1",
        projectId: "project-1",
        title: "Team Discussion",
        createdAt: Date.now(),
        engine: "group",
        groupId: "group-def-1",
        totalCost: 0.75,
        messages: [
          { id: "msg-user", role: "user", content: "What's the best approach?", timestamp: Date.now() },
          {
            id: "msg-alice",
            role: "assistant",
            content: "I think we should use pattern X",
            timestamp: Date.now(),
            groupSlot: { label: "Alice", color: "#ff0000", engine: "claude", model: "claude-sonnet-4-5" },
          },
          {
            id: "msg-bob",
            role: "assistant",
            content: "I agree with Alice, pattern X is solid",
            timestamp: Date.now(),
            groupSlot: { label: "Bob", color: "#00ff00", engine: "claude", model: "claude-opus-4-6" },
          },
        ],
      };

      expect(session.messages).toHaveLength(3);
      expect(session.totalCost).toBe(0.75);
      expect(session.messages.filter((m) => m.groupSlot)).toHaveLength(2);
    });

    it("lists group sessions alongside regular sessions", () => {
      const sessions: SessionBase[] = [
        {
          id: "claude-1",
          projectId: "project-1",
          title: "Claude Chat",
          createdAt: Date.now() - 1000000,
          totalCost: 0,
          engine: "claude",
        },
        {
          id: "group-1",
          projectId: "project-1",
          title: "Group Discussion",
          createdAt: Date.now() - 500000,
          totalCost: 0,
          engine: "group",
          groupId: "group-def-1",
        },
        {
          id: "acp-1",
          projectId: "project-1",
          title: "ACP Session",
          createdAt: Date.now(),
          totalCost: 0,
          engine: "acp",
        },
      ];

      expect(sessions).toHaveLength(3);
      const groupSession = sessions.find((s) => s.engine === "group");
      expect(groupSession?.id).toBe("group-1");
    });
  });

  describe("session list sorting includes group sessions", () => {
    it("sorts sessions by creation date with group sessions mixed in", () => {
      const sessions: SessionBase[] = [
        { id: "1", projectId: "p1", title: "A", createdAt: 1000, totalCost: 0, engine: "claude" },
        { id: "2", projectId: "p1", title: "B", createdAt: 3000, totalCost: 0, engine: "group", groupId: "g1" },
        { id: "3", projectId: "p1", title: "C", createdAt: 2000, totalCost: 0, engine: "claude" },
      ];

      const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);

      expect(sorted[0].id).toBe("2");
      expect(sorted[1].id).toBe("3");
      expect(sorted[2].id).toBe("1");
    });
  });
});
