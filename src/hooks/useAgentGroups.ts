import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AgentGroup,
  GroupMessage,
  GroupSession,
  GroupSessionEvent,
  GroupSessionStatus,
} from "@/types/groups";

export interface UseAgentGroupsReturn {
  groups: AgentGroup[];
  activeSession: GroupSession | null;
  activeSessionStatus: GroupSessionStatus;
  messages: GroupMessage[];
  loading: boolean;
  createGroup: (group: AgentGroup) => Promise<void>;
  updateGroup: (group: AgentGroup) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  startSession: (groupId: string, prompt: string, cwd?: string) => Promise<void>;
  stopSession: () => void;
  refreshGroups: () => Promise<void>;
}

export function useAgentGroups(): UseAgentGroupsReturn {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [activeSession, setActiveSession] = useState<GroupSession | null>(null);
  const [activeSessionStatus, setActiveSessionStatus] = useState<GroupSessionStatus>("idle");
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const refreshGroups = useCallback(async () => {
    const result = await window.claude.groups.list();
    if (result.ok && result.groups) {
      setGroups(result.groups);
    }
  }, []);

  useEffect(() => {
    refreshGroups();
  }, [refreshGroups]);

  useEffect(() => {
    const cleanup = window.claude.groups.onEvent((data: unknown) => {
      const event = data as GroupSessionEvent;

      if (event.type === "message" && event.message) {
        setMessages((prev) => [...prev, event.message!]);
      }

      if (event.type === "status" && event.status) {
        setActiveSessionStatus(event.status);
      }

      if (event.type === "complete") {
        setActiveSessionStatus("completed");
      }

      if (event.type === "turn-advance") {
        setActiveSession((prev) =>
          prev ? { ...prev, currentTurnIndex: event.turnIndex ?? prev.currentTurnIndex } : null,
        );
      }

      if (event.type === "error") {
        const errorMsg: GroupMessage = {
          id: `err-${Date.now()}`,
          slotId: event.slotId ?? "system",
          role: "assistant",
          content: `Error: ${event.error}`,
          timestamp: new Date().toISOString(),
          turnIndex: 0,
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    });

    cleanupRef.current = cleanup;
    return cleanup;
  }, []);

  const createGroup = useCallback(
    async (group: AgentGroup) => {
      await window.claude.groups.create(group);
      await refreshGroups();
    },
    [refreshGroups],
  );

  const updateGroup = useCallback(
    async (group: AgentGroup) => {
      await window.claude.groups.update(group);
      await refreshGroups();
    },
    [refreshGroups],
  );

  const deleteGroup = useCallback(
    async (groupId: string) => {
      await window.claude.groups.delete(groupId);
      await refreshGroups();
    },
    [refreshGroups],
  );

  const startSession = useCallback(async (groupId: string, prompt: string, cwd?: string) => {
    setLoading(true);
    setMessages([
      {
        id: `user-${Date.now()}`,
        slotId: "user",
        role: "user",
        content: prompt,
        timestamp: new Date().toISOString(),
        turnIndex: 0,
      },
    ]);
    setActiveSessionStatus("running");
    const result = await window.claude.groups.startSession({ groupId, prompt, cwd });
    setLoading(false);
    if (result.ok && result.sessionId) {
      setActiveSession({
        id: result.sessionId,
        groupId,
        status: "running",
        messages: [],
        currentTurnIndex: 0,
        currentSlotIndex: 0,
        prompt,
        cwd,
        startedAt: new Date().toISOString(),
      });
    }
  }, []);

  const stopSession = useCallback(() => {
    if (activeSession) {
      window.claude.groups.stopSession(activeSession.id);
      setActiveSessionStatus("completed");
    }
  }, [activeSession]);

  return {
    groups,
    activeSession,
    activeSessionStatus,
    messages,
    loading,
    createGroup,
    updateGroup,
    deleteGroup,
    startSession,
    stopSession,
    refreshGroups,
  };
}
