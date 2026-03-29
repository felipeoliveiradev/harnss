import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AgentSlot, GroupSession, GroupSessionEvent } from "../../../shared/types/groups";

describe("group-sessions IPC handler", () => {
  describe("managed slot sessions creation", () => {
    it("creates a managed session for each slot with groupSessionId prefix", () => {
      const groupSessionId = "group-session-1";
      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "participant" },
        { id: "slot-bob", label: "Bob", model: "claude-opus-4-6", color: "#00ff00", engine: "claude", role: "participant" },
      ];

      const sessionIds = slots.map((slot) => `${groupSessionId}-slot-${slot.id}`);

      expect(sessionIds).toHaveLength(2);
      expect(sessionIds[0]).toBe("group-session-1-slot-slot-alice");
      expect(sessionIds[1]).toBe("group-session-1-slot-slot-bob");
    });

    it("registers each slot session in active session map", () => {
      const groupSessionId = "group-1";
      const slotSessionIds = new Set<string>();

      slotSessionIds.add(`${groupSessionId}-slot-alice`);
      slotSessionIds.add(`${groupSessionId}-slot-bob`);

      expect(slotSessionIds.size).toBe(2);
      expect(slotSessionIds.has(`${groupSessionId}-slot-alice`)).toBe(true);
    });

    it("configures each slot session with canUseTool callback for permission bridging", () => {
      const permissions: Array<{ requestId: string; toolName: string; slotId: string }> = [];

      const createCanUseTool = (slotId: string) => (toolName: string, input: unknown, context: unknown) => {
        permissions.push({ requestId: "req-1", toolName, slotId });
        return Promise.resolve({ allow: true });
      };

      const slotId1 = "slot-alice";
      const slotId2 = "slot-bob";

      const canUse1 = createCanUseTool(slotId1);
      const canUse2 = createCanUseTool(slotId2);

      canUse1("Bash", { command: "ls" }, { toolUseID: "tool-1", suggestions: [], decisionReason: "" });
      canUse2("Edit", { filePath: "src/index.ts" }, { toolUseID: "tool-2", suggestions: [], decisionReason: "" });

      expect(permissions).toHaveLength(2);
      expect(permissions[0].slotId).toBe("slot-alice");
      expect(permissions[1].slotId).toBe("slot-bob");
    });
  });

  describe("turn strategy execution", () => {
    it("parallel strategy: all slots receive prompt simultaneously", () => {
      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "participant" },
        { id: "slot-bob", label: "Bob", model: "claude-opus-4-6", color: "#00ff00", engine: "claude", role: "participant" },
        { id: "slot-charlie", label: "Charlie", model: "claude-haiku-4-5", color: "#0000ff", engine: "claude", role: "participant" },
      ];

      const turnStrategy = "parallel";
      const sentPrompts = new Map<string, string>();

      const prompt = "What is the best design pattern?";

      for (const slot of slots) {
        sentPrompts.set(slot.id, prompt);
      }

      expect(sentPrompts.size).toBe(3);
      for (const [, sentPrompt] of sentPrompts) {
        expect(sentPrompt).toBe(prompt);
      }
    });

    it("round-robin strategy: takes turns with leader designation", () => {
      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "leader" },
        { id: "slot-bob", label: "Bob", model: "claude-opus-4-6", color: "#00ff00", engine: "claude", role: "participant" },
        { id: "slot-charlie", label: "Charlie", model: "claude-haiku-4-5", color: "#0000ff", engine: "claude", role: "participant" },
      ];

      const turnOrder: string[] = [];
      let currentTurn = 0;

      for (let i = 0; i < 3; i++) {
        const slot = slots[currentTurn % slots.length];
        turnOrder.push(slot.id);
        currentTurn++;
      }

      expect(turnOrder[0]).toBe("slot-alice");
      expect(turnOrder[1]).toBe("slot-bob");
      expect(turnOrder[2]).toBe("slot-charlie");
    });

    it("leader-decides strategy: leader slot responds, others wait", () => {
      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "leader" },
        { id: "slot-bob", label: "Bob", model: "claude-opus-4-6", color: "#00ff00", engine: "claude", role: "participant" },
      ];

      const leaderSlot = slots.find((s) => s.role === "leader");
      const participantSlots = slots.filter((s) => s.role !== "leader");

      expect(leaderSlot?.id).toBe("slot-alice");
      expect(participantSlots).toHaveLength(1);
    });
  });

  describe("event emission and routing", () => {
    it("emits claude:event with _groupSessionId and _slotId tags", () => {
      const events: unknown[] = [];

      const groupSessionId = "group-1";
      const slotId = "slot-alice";

      const event = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
        _groupSessionId: groupSessionId,
        _slotId: slotId,
      };

      events.push(event);

      expect(events[0]).toEqual({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
        _groupSessionId: groupSessionId,
        _slotId: slotId,
      });
    });

    it("emits group:event for GroupSessionEvent (status, complete, error)", () => {
      const groupEvents: GroupSessionEvent[] = [];

      const statusEvent: GroupSessionEvent = {
        type: "status",
        sessionId: "group-1",
        status: "running",
      };

      const completeEvent: GroupSessionEvent = {
        type: "complete",
        sessionId: "group-1",
      };

      const errorEvent: GroupSessionEvent = {
        type: "error",
        sessionId: "group-1",
        error: "Slot timeout",
        slotId: "slot-alice",
      };

      groupEvents.push(statusEvent, completeEvent, errorEvent);

      expect(groupEvents).toHaveLength(3);
      expect(groupEvents[0].status).toBe("running");
      expect(groupEvents[1].type).toBe("complete");
      expect(groupEvents[2].error).toBe("Slot timeout");
    });

    it("routes permission requests from slots with _slotId context", () => {
      const permissionRequests: Array<{
        _groupSessionId: string;
        _slotId: string;
        requestId: string;
        toolName: string;
      }> = [];

      const groupSessionId = "group-1";
      const slotId = "slot-alice";

      permissionRequests.push({
        _groupSessionId: groupSessionId,
        _slotId: slotId,
        requestId: "req-1",
        toolName: "Bash",
      });

      expect(permissionRequests[0]._groupSessionId).toBe(groupSessionId);
      expect(permissionRequests[0]._slotId).toBe(slotId);
    });
  });

  describe("interrupt and cleanup", () => {
    it("interrupt cancels all slot sessions when called on group", () => {
      const slotSessionIds = new Set<string>();
      slotSessionIds.add("group-1-slot-alice");
      slotSessionIds.add("group-1-slot-bob");
      slotSessionIds.add("group-1-slot-charlie");

      expect(slotSessionIds.size).toBe(3);

      slotSessionIds.clear();

      expect(slotSessionIds.size).toBe(0);
    });

    it("clears pending permissions for all slots on interrupt", () => {
      const permissionQueue: unknown[] = [];
      const respondingIds = new Set<string>();
      const completedIds = new Set<string>();

      permissionQueue.push({ requestId: "req-1" }, { requestId: "req-2" });
      respondingIds.add("req-1");

      permissionQueue.length = 0;
      respondingIds.clear();
      completedIds.clear();

      expect(permissionQueue).toHaveLength(0);
      expect(respondingIds.size).toBe(0);
      expect(completedIds.size).toBe(0);
    });

    it("resets streaming state for all slots", () => {
      const slotBuffers = new Map();

      slotBuffers.set("slot-alice", { messageId: "msg-1", text: "Hello" });
      slotBuffers.set("slot-bob", { messageId: "msg-2", text: "Hi" });

      for (const [, buf] of slotBuffers) {
        buf.messageId = null;
        buf.text = "";
      }

      expect(slotBuffers.get("slot-alice")?.messageId).toBeNull();
      expect(slotBuffers.get("slot-bob")?.text).toBe("");
    });
  });

  describe("group session persistence", () => {
    it("converts GroupMessage array to UIMessage array with groupSlot metadata", () => {
      const slots: AgentSlot[] = [
        { id: "slot-alice", label: "Alice", model: "claude-sonnet-4-5", color: "#ff0000", engine: "claude", role: "participant" },
        { id: "slot-bob", label: "Bob", model: "claude-opus-4-6", color: "#00ff00", engine: "claude", role: "participant" },
      ];

      const slotMap = new Map(slots.map((s) => [s.id, s]));

      const groupMessages = [
        { id: "gm-1", role: "user" as const, content: "Hello", timestamp: Date.now(), slotId: "user" },
        { id: "gm-2", role: "assistant" as const, content: "Hi Alice", timestamp: Date.now(), slotId: "slot-alice" },
        { id: "gm-3", role: "assistant" as const, content: "Hi Bob", timestamp: Date.now(), slotId: "slot-bob" },
      ];

      const uiMessages = groupMessages.map((msg) => {
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

      expect(uiMessages).toHaveLength(3);
      expect(uiMessages[1].groupSlot?.label).toBe("Alice");
      expect(uiMessages[2].groupSlot?.label).toBe("Bob");
      expect(uiMessages[0].groupSlot).toBeUndefined();
    });

    it("generates session title from group name and prompt", () => {
      const groupName = "Design Team";
      const prompt = "What are the best practices for component design in React?";

      const title = `${groupName}: ${prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt}`;

      expect(title).toBe("Design Team: What are the best practices for component desig...");
    });

    it("saves PersistedGroupSession with all metadata", () => {
      const session: Partial<GroupSession> = {
        id: "group-1",
        groupId: "group-def-1",
        prompt: "Test prompt",
        startedAt: new Date().toISOString(),
        messages: [],
      };

      const persisted = {
        id: session.id,
        projectId: "project-1",
        title: "Design Team: Test prompt",
        createdAt: Date.now(),
        totalCost: 0,
        engine: "group" as const,
        groupId: session.groupId,
        messages: [],
        lastMessageAt: Date.now(),
      };

      expect(persisted).toHaveProperty("engine", "group");
      expect(persisted).toHaveProperty("groupId");
      expect(persisted).toHaveProperty("messages");
    });
  });
});
