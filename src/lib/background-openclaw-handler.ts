import type { OpenClawSessionEvent } from "@shared/types/openclaw";
import type { InternalState } from "./background-session-store";

function nextId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function ensureStreamingMsg(state: InternalState): void {
  if (state.currentStreamingMsgId) return;
  const id = nextId("openclaw-stream-bg");
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

export function handleOpenClawEvent(state: InternalState, event: OpenClawSessionEvent): void {
  switch (event.type) {
    case "lifecycle:start":
      state.isProcessing = true;
      break;

    case "chat:delta":
      ensureStreamingMsg(state);
      if (state.currentStreamingMsgId) {
        const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
        if (target) target.content += (event.payload.text as string) ?? "";
      }
      break;

    case "chat:final":
      finalizeStreamingMsg(state);
      state.isProcessing = false;
      break;

    case "chat:error":
      finalizeStreamingMsg(state);
      state.isProcessing = false;
      state.messages.push({
        id: nextId("openclaw-error-bg"),
        role: "system",
        content: (event.payload.message as string) ?? "OpenClaw error",
        isError: true,
        timestamp: Date.now(),
      });
      break;

    case "thinking:delta": {
      ensureStreamingMsg(state);
      const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
      if (target) target.thinking = (target.thinking ?? "") + ((event.payload.text as string) ?? "");
      break;
    }

    case "thinking:done": {
      const target = state.messages.find(m => m.id === state.currentStreamingMsgId);
      if (target) target.thinkingComplete = true;
      break;
    }

    case "tool:start": {
      const toolUseId = (event.payload.toolUseId as string) ?? nextId("tool-call-bg");
      state.messages.push({
        id: toolUseId,
        role: "tool_call",
        content: "",
        toolName: (event.payload.toolName as string) ?? "unknown",
        toolInput: event.payload.input as Record<string, unknown>,
        timestamp: Date.now(),
      });
      break;
    }

    case "tool:result": {
      const resultToolUseId = (event.payload.toolUseId as string) ?? "";
      const resultToolName = (event.payload.toolName as string) ?? "";
      for (const msg of state.messages) {
        if (msg.role !== "tool_call" || msg.toolResult) continue;
        if ((resultToolUseId && msg.id === resultToolUseId) || (!resultToolUseId && msg.toolName === resultToolName)) {
          msg.toolResult = event.payload.result as Record<string, unknown>;
          break;
        }
      }
      break;
    }

    case "lifecycle:end":
      finalizeStreamingMsg(state);
      state.isProcessing = false;
      break;
  }
}
