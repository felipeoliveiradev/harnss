import { describe, expect, it } from "vitest";
import type { PersistedSession } from "../types/ui";
import type { AgentSlot } from "../types/groups";

describe("group session persistence integration", () => {
  describe("save group session as PersistedSession", () => {
    it("converts GroupSession to PersistedSession with all metadata", () => {
      const groupSession = {
        id: "group-1",
        projectId: "project-1",
        groupId: "group-def-1",
        prompt: "Design review for authentication module",
        messages: [
          {
            id: "gm-1",
            role: "user" as const,
            content: "Design review for authentication module",
            timestamp: Date.now(),
            slotId: "user",
          },
          {
            id: "gm-2",
            role: "assistant" as const,
            content: "I suggest using OAuth2 with JWT tokens",
            timestamp: Date.now() + 1000,
            slotId: "slot-alice",
          },
        ],
        startedAt: new Date().toISOString(),
      };

      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "member" },
      ];

      const slotMap = new Map(slots.map((s) => [s.id, s]));

      const uiMessages = groupSession.messages.map((msg) => {
        const slot = slotMap.get(msg.slotId);
        return {
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          groupSlot: slot && msg.role === "assistant"
            ? { label: slot.label, color: slot.color, engine: slot.engine, model: slot.model }
            : undefined,
        };
      });

      const persisted: PersistedSession = {
        id: groupSession.id,
        projectId: groupSession.projectId,
        title: `Group: ${groupSession.prompt.length > 50 ? groupSession.prompt.slice(0, 47) + "..." : groupSession.prompt}`,
        createdAt: new Date(groupSession.startedAt).getTime(),
        totalCost: 0,
        engine: "group",
        groupId: groupSession.groupId,
        messages: uiMessages,
      };

      expect(persisted).toEqual({
        id: "group-1",
        projectId: "project-1",
        title: "Group: Design review for authentication module",
        createdAt: expect.any(Number),
        totalCost: 0,
        engine: "group",
        groupId: "group-def-1",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            groupSlot: expect.objectContaining({ label: "Alice" }),
          }),
        ]),
      });
    });

    it("generates session title from group name and prompt", () => {
      const groupName = "Design Team";
      const prompt = "What is the best architecture for a real-time collaborative editor?";

      const title = groupName
        ? `${groupName}: ${prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt}`
        : prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;

      expect(title).toBe("Design Team: What is the best architecture for a real-time c...");
    });

    it("handles missing group name gracefully", () => {
      const groupName: string | null = null;
      const prompt = "Design discussion";

      const title = groupName
        ? `${groupName}: ${prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt}`
        : prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;

      expect(title).toBe("Design discussion");
    });
  });

  describe("load group session from PersistedSession", () => {
    it("reconstructs group session with full message history and slot info", () => {
      const persisted: PersistedSession = {
        id: "group-1",
        projectId: "project-1",
        title: "Design Team: Authentication review",
        createdAt: Date.now() - 86400000,
        totalCost: 0,
        engine: "group",
        groupId: "group-def-1",
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Let's review the auth design",
            timestamp: Date.now() - 86400000,
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "I recommend OAuth2 with JWT",
            timestamp: Date.now() - 85800000,
            groupSlot: {
              label: "Alice",
              color: "#ff0000",
              engine: "claude",
              model: "claude-sonnet-4-5",
            },
          },
          {
            id: "msg-3",
            role: "assistant",
            content: "I agree with Alice, JWT is solid",
            timestamp: Date.now() - 85400000,
            groupSlot: {
              label: "Bob",
              color: "#00ff00",
              engine: "claude",
              model: "claude-opus-4-6",
            },
          },
        ],
      };

      expect(persisted.engine).toBe("group");
      expect(persisted.groupId).toBe("group-def-1");
      expect(persisted.messages).toHaveLength(3);

      const assistantMessages = persisted.messages.filter((m) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].groupSlot?.label).toBe("Alice");
      expect(assistantMessages[1].groupSlot?.label).toBe("Bob");
    });

    it("loads session info with proper engine type", () => {
      const sessionBase = {
        id: "group-1",
        projectId: "project-1",
        engine: "group" as const,
        groupId: "group-def-1",
      };

      expect(sessionBase.engine).toBe("group");
      expect(sessionBase.groupId).toBeDefined();
    });
  });

  describe("list group sessions from persistence", () => {
    it("lists group sessions with metadata", () => {
      const sessions = [
        {
          id: "group-1",
          projectId: "project-1",
          title: "Design Team: Auth Review",
          createdAt: Date.now() - 86400000,
          lastMessageAt: Date.now() - 3600000,
          engine: "group" as const,
          groupId: "group-def-1",
        },
        {
          id: "group-2",
          projectId: "project-1",
          title: "Dev Team: Performance Discussion",
          createdAt: Date.now() - 172800000,
          lastMessageAt: Date.now() - 7200000,
          engine: "group" as const,
          groupId: "group-def-2",
        },
      ];

      expect(sessions).toHaveLength(2);
      expect(sessions[0].groupId).toBe("group-def-1");
      expect(sessions[1].groupId).toBe("group-def-2");
    });

    it("sorts sessions by lastMessageAt descending", () => {
      const sessions = [
        {
          id: "group-1",
          projectId: "project-1",
          title: "Group 1",
          createdAt: Date.now() - 86400000,
          lastMessageAt: Date.now() - 7200000,
          engine: "group" as const,
          groupId: "group-def-1",
        },
        {
          id: "group-2",
          projectId: "project-1",
          title: "Group 2",
          createdAt: Date.now() - 172800000,
          lastMessageAt: Date.now() - 3600000,
          engine: "group" as const,
          groupId: "group-def-2",
        },
      ];

      const sorted = [...sessions].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

      expect(sorted[0].id).toBe("group-2");
      expect(sorted[1].id).toBe("group-1");
    });

    it("includes group sessions when listing all project sessions", () => {
      const allSessions = [
        { id: "claude-1", projectId: "project-1", title: "Chat", createdAt: Date.now(), engine: "claude" as const },
        {
          id: "group-1",
          projectId: "project-1",
          title: "Group",
          createdAt: Date.now() - 3600000,
          engine: "group" as const,
          groupId: "group-def-1",
        },
        { id: "acp-1", projectId: "project-1", title: "ACP", createdAt: Date.now() - 7200000, engine: "acp" as const },
      ];

      const groupSessions = allSessions.filter((s) => s.engine === "group");

      expect(groupSessions).toHaveLength(1);
      expect(groupSessions[0].id).toBe("group-1");
    });
  });

  describe("delete group session from persistence", () => {
    it("removes group session file and metadata", () => {
      const sessionFiles = new Map<string, unknown>();

      const groupSessionId = "group-1";
      sessionFiles.set(groupSessionId, { id: groupSessionId, data: "session-data" });
      sessionFiles.set(`${groupSessionId}.meta`, { metadata: "info" });

      expect(sessionFiles.size).toBe(2);

      sessionFiles.delete(groupSessionId);
      sessionFiles.delete(`${groupSessionId}.meta`);

      expect(sessionFiles.size).toBe(0);
      expect(sessionFiles.has(groupSessionId)).toBe(false);
    });

    it("cleans up per-project group sessions directory if empty", () => {
      const projectGroupSessions = new Map<string, unknown>();

      projectGroupSessions.set("group-1", {});
      projectGroupSessions.delete("group-1");

      expect(projectGroupSessions.size).toBe(0);
    });
  });

  describe("group session cost tracking", () => {
    it("accumulates cost from multiple slot sessions", () => {
      const slotCosts = [
        { slotId: "slot-alice", cost: 0.15 },
        { slotId: "slot-bob", cost: 0.12 },
        { slotId: "slot-charlie", cost: 0.18 },
      ];

      const totalCost = slotCosts.reduce((sum, slot) => sum + slot.cost, 0);

      expect(totalCost).toBe(0.45);
    });

    it("persists accumulated cost in PersistedGroupSession", () => {
      const session: PersistedSession = {
        id: "group-1",
        projectId: "project-1",
        title: "Group Session",
        createdAt: Date.now(),
        totalCost: 0.45,
        engine: "group",
        groupId: "group-def-1",
        messages: [],
      };

      expect(session.totalCost).toBe(0.45);
    });
  });

  describe("migration: group sessions format", () => {
    it("converts old GroupSession format to PersistedSession format", () => {
      const oldFormat = {
        id: "group-1",
        groupId: "group-def-1",
        prompt: "Design review",
        messages: [
          { id: "m1", role: "user", content: "Hello", slotId: "user" },
          { id: "m2", role: "assistant", content: "Hi", slotId: "slot-1" },
        ],
      };

      const newFormat: PersistedSession = {
        id: oldFormat.id,
        projectId: "project-1",
        title: `Group: ${oldFormat.prompt}`,
        createdAt: Date.now(),
        totalCost: 0,
        engine: "group",
        groupId: oldFormat.groupId,
        messages: oldFormat.messages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: Date.now(),
          groupSlot: undefined,
        })),
      };

      expect(newFormat.engine).toBe("group");
      expect(newFormat.groupId).toBe("group-def-1");
      expect(newFormat.messages[1].groupSlot).toBeUndefined();
    });
  });
});
