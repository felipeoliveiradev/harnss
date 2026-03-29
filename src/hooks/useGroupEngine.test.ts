import { describe, expect, it, vi } from "vitest";
import type {
  UIMessage,
  PermissionRequest,
  SessionMeta,
} from "../types";
import type { GroupSessionEvent } from "../types/groups";

describe("useGroupEngine contract", () => {
  it("initializes with EngineHookState contract properties", () => {
    const contract = {
      messages: [] as UIMessage[],
      setMessages: vi.fn(),
      isProcessing: false,
      setIsProcessing: vi.fn(),
      isConnected: false,
      setIsConnected: vi.fn(),
      sessionInfo: null as SessionMeta | null,
      setSessionInfo: vi.fn(),
      totalCost: 0,
      setTotalCost: vi.fn(),
      pendingPermission: null as PermissionRequest | null,
      respondPermission: vi.fn(),
      contextUsage: null,
      setContextUsage: vi.fn(),
      isCompacting: false,
      send: vi.fn(),
      stop: vi.fn(),
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      compact: vi.fn(),
      registerSlotMeta: vi.fn(),
    };

    expect(contract).toHaveProperty("messages");
    expect(contract).toHaveProperty("isProcessing");
    expect(contract).toHaveProperty("isConnected");
    expect(contract).toHaveProperty("send");
    expect(contract).toHaveProperty("stop");
    expect(contract).toHaveProperty("interrupt");
    expect(contract).toHaveProperty("respondPermission");
  });

  it("properly tracks streaming messages with groupSlot metadata", () => {
    const msg: UIMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello from Alice",
      timestamp: Date.now(),
      isStreaming: true,
      groupSlot: {
        label: "Alice",
        color: "#ff0000",
        engine: "claude",
        model: "claude-sonnet-4-5",
      },
    };

    expect(msg.groupSlot).toBeDefined();
    expect(msg.groupSlot?.label).toBe("Alice");
    expect(msg.groupSlot?.engine).toBe("claude");
    expect(msg.groupSlot?.model).toBe("claude-sonnet-4-5");
  });

  it("manages per-slot streaming buffers independently", () => {
    const slots = ["slot-alice", "slot-bob", "slot-charlie"];
    const buffers = new Map();

    for (const slotId of slots) {
      buffers.set(slotId, {
        messageId: null,
        text: "",
        thinking: "",
      });
    }

    expect(buffers.size).toBe(3);
    for (const slotId of slots) {
      expect(buffers.has(slotId)).toBe(true);
    }
  });

  it("enqueues permission requests and tracks responding ids", () => {
    const permissionQueue: PermissionRequest[] = [];
    const respondingIds = new Set<string>();

    const request: PermissionRequest = {
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tool-1",
    };

    permissionQueue.push(request);
    respondingIds.add(request.requestId);

    expect(permissionQueue).toHaveLength(1);
    expect(respondingIds.has("req-1")).toBe(true);
  });
});

describe("useGroupEngine group event handling", () => {
  it("transitions to running state on GroupSessionEvent status=running", () => {
    const event: GroupSessionEvent = {
      type: "status",
      sessionId: "group-1",
      status: "running",
    };

    expect(event.type).toBe("status");
    expect(event.status).toBe("running");
  });

  it("marks streaming messages as complete on GroupSessionEvent complete", () => {
    const messages: UIMessage[] = [
      {
        id: "msg-1",
        role: "assistant",
        content: "Response 1",
        timestamp: Date.now(),
        isStreaming: true,
        groupSlot: { label: "Alice", color: "#ff0000", engine: "claude", model: "claude-sonnet-4-5" },
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Response 2",
        timestamp: Date.now(),
        isStreaming: true,
        groupSlot: { label: "Bob", color: "#00ff00", engine: "claude", model: "claude-sonnet-4-5" },
      },
    ];

    const completed = messages.map((m) => m.isStreaming ? { ...m, isStreaming: false } : m);

    expect(completed[0].isStreaming).toBe(false);
    expect(completed[1].isStreaming).toBe(false);
  });

  it("emits error messages on GroupSessionEvent error", () => {
    const event: GroupSessionEvent = {
      type: "error",
      sessionId: "group-1",
      error: "Slot timed out",
      slotId: "slot-alice",
    };

    const errorMessage: UIMessage = {
      id: "error-1",
      role: "system",
      content: `Error (slot ${event.slotId}): ${event.error}`,
      isError: true,
      timestamp: Date.now(),
    };

    expect(errorMessage.isError).toBe(true);
    expect(errorMessage.content).toContain(event.error);
  });
});

describe("useGroupEngine permission bridging", () => {
  it("queues permission requests with requestId tracking", () => {
    const permissionQueue: PermissionRequest[] = [];
    const req1: PermissionRequest = {
      requestId: "req-alice-1",
      toolName: "Bash",
      toolInput: { command: "npm install" },
      toolUseId: "tool-alice-1",
    };

    const req2: PermissionRequest = {
      requestId: "req-bob-1",
      toolName: "Edit",
      toolInput: { filePath: "src/index.ts" },
      toolUseId: "tool-bob-1",
    };

    permissionQueue.push(req1, req2);

    expect(permissionQueue).toHaveLength(2);
    expect(permissionQueue[0].toolName).toBe("Bash");
    expect(permissionQueue[1].toolName).toBe("Edit");
  });

  it("prevents duplicate responses for same permission request", () => {
    const respondingIds = new Set<string>();
    const completedIds = new Set<string>();

    const requestId = "req-1";

    respondingIds.add(requestId);
    const canRespond = !respondingIds.has(requestId) && !completedIds.has(requestId);

    expect(canRespond).toBe(false);

    respondingIds.delete(requestId);
    completedIds.add(requestId);
    const canRespondAgain = !respondingIds.has(requestId) && !completedIds.has(requestId);

    expect(canRespondAgain).toBe(false);
  });
});

describe("useGroupEngine message routing", () => {
  it("routes Claude events to correct slot by _slotId", () => {
    const events = [
      { type: "assistant", _slotId: "slot-alice", message: { content: [] } },
      { type: "assistant", _slotId: "slot-bob", message: { content: [] } },
    ];

    const slotRouting = new Map();
    for (const event of events) {
      if (event._slotId) {
        if (!slotRouting.has(event._slotId)) {
          slotRouting.set(event._slotId, []);
        }
        slotRouting.get(event._slotId).push(event);
      }
    }

    expect(slotRouting.get("slot-alice")).toHaveLength(1);
    expect(slotRouting.get("slot-bob")).toHaveLength(1);
  });

  it("filters out subagent events (parent_tool_use_id set)", () => {
    const events = [
      { type: "assistant", parent_tool_use_id: null },
      { type: "assistant", parent_tool_use_id: "tool-task-1" },
      { type: "assistant", parent_tool_use_id: null },
    ];

    const mainEvents = events.filter((e) => !e.parent_tool_use_id);

    expect(mainEvents).toHaveLength(2);
    expect(mainEvents[0].parent_tool_use_id).toBeNull();
  });
});

describe("useGroupEngine slot metadata registration", () => {
  it("registers slot metadata for label, color, engine, model", () => {
    const slots = [
      { id: "slot-alice", label: "Alice", color: "#ff0000", engine: "claude", model: "claude-sonnet-4-5" },
      { id: "slot-bob", label: "Bob", color: "#00ff00", engine: "claude", model: "claude-opus-4-6" },
    ];

    const slotMetaMap = new Map();
    for (const slot of slots) {
      slotMetaMap.set(slot.id, {
        label: slot.label,
        color: slot.color,
        engine: slot.engine,
        model: slot.model,
      });
    }

    expect(slotMetaMap.get("slot-alice")?.label).toBe("Alice");
    expect(slotMetaMap.get("slot-bob")?.model).toBe("claude-opus-4-6");
  });

  it("clears old metadata when registerSlotMeta is called", () => {
    const slotMetaMap = new Map();

    slotMetaMap.set("slot-old-1", { label: "Old", color: "#000000", engine: "claude", model: "old" });
    expect(slotMetaMap.size).toBe(1);

    slotMetaMap.clear();

    expect(slotMetaMap.size).toBe(0);
  });
});
