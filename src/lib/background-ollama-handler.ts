import type { InternalState } from "./background-session-store";

type OllamaEvent = {
  _sessionId: string;
  type: string;
  payload: Record<string, unknown>;
};

function nextId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function ensureStreamingMsg(state: InternalState): void {
  if (state.currentStreamingMsgId) return;
  const id = nextId("ollama-stream-bg");
  state.currentStreamingMsgId = id;
  state.messages.push({
    id,
    role: "assistant",
    content: "",
    isStreaming: true,
    timestamp: Date.now(),
  });
}

function finalizeStreamingMsg(state: InternalState): void {
  if (!state.currentStreamingMsgId) return;
  const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
  if (target) target.isStreaming = false;
  state.currentStreamingMsgId = null;
}

export function handleOllamaEvent(state: InternalState, event: OllamaEvent): void {
  switch (event.type) {
    case "lifecycle:start":
      state.isProcessing = true;
      state.isConnected = true;
      break;

    case "chat:thinking": {
      const thinkText = (event.payload.text as string) ?? "";
      ensureStreamingMsg(state);
      const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
      if (target) target.thinking = thinkText;
      break;
    }

    case "chat:delta": {
      const text = (event.payload.text as string) ?? "";
      ensureStreamingMsg(state);
      const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
      if (target) target.content = text;
      break;
    }

    case "chat:final": {
      const finalMsg = (event.payload.message as string) ?? "";
      if (state.currentStreamingMsgId) {
        const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
        if (target) {
          target.content = finalMsg;
          target.isStreaming = false;
        }
        state.currentStreamingMsgId = null;
      } else if (finalMsg) {
        state.messages.push({
          id: nextId("ollama-final-bg"),
          role: "assistant",
          content: finalMsg,
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
      const taskPlanMsg = state.messages.find(
        m => m.role === "tool_call" && m.toolName === "Task" && m.subagentStatus === "running" && m.isStreaming
      );
      if (taskPlanMsg) {
        taskPlanMsg.subagentStatus = "completed";
        taskPlanMsg.isStreaming = false;
      }
      state.isProcessing = false;
      break;
    }

    case "chat:mid-final": {
      const midMsg = (event.payload.message as string) ?? "";
      if (state.currentStreamingMsgId) {
        const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
        if (target) {
          target.content = midMsg;
          target.isStreaming = false;
        }
        state.currentStreamingMsgId = null;
      } else if (midMsg) {
        state.messages.push({
          id: nextId("ollama-mid-bg"),
          role: "assistant",
          content: midMsg,
          isStreaming: false,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "chat:clear-streaming": {
      if (state.currentStreamingMsgId) {
        state.messages = state.messages.filter(m => m.id !== state.currentStreamingMsgId);
        state.currentStreamingMsgId = null;
      }
      break;
    }

    case "tool:start": {
      const { toolUseId, toolName, input } = event.payload as {
        toolUseId: string;
        toolName: string;
        input: Record<string, unknown>;
      };
      const taskPlanMsg = state.messages.find(
        m => m.role === "tool_call" && m.toolName === "Task" && m.subagentStatus === "running" && m.isStreaming
      );
      if (taskPlanMsg) {
        taskPlanMsg.subagentSteps = [
          ...(taskPlanMsg.subagentSteps ?? []),
          { toolUseId, toolName, toolInput: input },
        ];
      } else {
        const msgId = nextId("ollama-tool-bg");
        state.parentToolMap.set(toolUseId, msgId);
        state.messages.push({
          id: msgId,
          role: "tool_call",
          content: "",
          toolName,
          toolInput: input,
          isStreaming: true,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case "tool:result": {
      const { toolUseId, toolName, result } = event.payload as {
        toolUseId: string;
        toolName: string;
        result: Record<string, unknown>;
      };
      const taskPlanMsg = state.messages.find(
        m => m.role === "tool_call" && m.toolName === "Task" && m.subagentStatus === "running" && m.isStreaming
      );
      if (taskPlanMsg) {
        taskPlanMsg.subagentSteps = (taskPlanMsg.subagentSteps ?? []).map(s =>
          s.toolUseId === toolUseId
            ? { ...s, toolResult: result, toolError: !!(result.error) }
            : s
        );
      } else {
        const msgId = state.parentToolMap.get(toolUseId);
        if (msgId) {
          const msg = state.messages.find(m => m.id === msgId);
          if (msg) {
            msg.isStreaming = false;
            msg.toolResult = result;
            msg.toolError = !!(result.error);
          }
          state.parentToolMap.delete(toolUseId);
        } else {
          state.messages.push({
            id: nextId("ollama-tool-result-bg"),
            role: "tool_call",
            content: "",
            toolName,
            toolResult: result,
            isStreaming: false,
            timestamp: Date.now(),
          });
        }
      }
      break;
    }

    case "task:plan": {
      const { tasks } = event.payload as { tasks: string[] };
      const taskId = nextId("ollama-task-plan-bg");
      state.messages.push({
        id: taskId,
        role: "tool_call",
        content: tasks.join("\n"),
        toolName: "Task",
        toolInput: { description: `Plan: ${tasks.length} tasks`, task_list: tasks },
        subagentSteps: [],
        subagentStatus: "running",
        isStreaming: true,
        timestamp: Date.now(),
      });
      break;
    }

    case "context:usage": {
      const { used, limit } = event.payload as { used: number; limit: number };
      state.contextUsage = {
        inputTokens: used,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: limit,
      };
      break;
    }

    case "ask_user:request": {
      const { question, toolUseId, options } = event.payload as {
        question: string;
        toolUseId: string;
        options?: string[];
      };
      const questionObj: Record<string, unknown> = { question, header: question, multiSelect: false };
      if (options && options.length > 0) {
        questionObj.options = options.map((o: string) => ({ label: o, description: "" }));
      }
      state.pendingPermission = {
        requestId: toolUseId,
        toolName: "AskUserQuestion",
        toolUseId,
        toolInput: { questions: [questionObj] },
      };
      state.isProcessing = false;
      break;
    }

    case "chat:error": {
      finalizeStreamingMsg(state);
      state.isProcessing = false;
      state.messages.push({
        id: nextId("ollama-error-bg"),
        role: "system",
        content: (event.payload.message as string) ?? "Ollama error",
        isError: true,
        timestamp: Date.now(),
      });
      break;
    }
  }
}
