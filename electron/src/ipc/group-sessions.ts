import { ipcMain, type BrowserWindow } from "electron";
import { log } from "../lib/logger";
import { reportError } from "../lib/error-utils";
import { getDataDir } from "../lib/data-dir";
import { getSDK, clientAppEnv } from "../lib/sdk";
import { getClaudeBinaryPath } from "../lib/claude-binary";
import * as fs from "fs";
import * as path from "path";
import type {
  AgentGroup,
  AgentSlot,
  GroupMessage,
  GroupSession,
  GroupSessionEvent,
  GroupSessionStatus,
} from "../../../shared/types/groups";

const GROUPS_DIR = "groups";
const GROUP_SESSIONS_DIR = "group-sessions";

function getGroupsDir(): string {
  const dir = path.join(getDataDir(), GROUPS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getGroupSessionsDir(): string {
  const dir = path.join(getDataDir(), GROUP_SESSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const activeGroupSessions = new Map<
  string,
  {
    session: GroupSession;
    aborted: boolean;
  }
>();

function emit(getMainWindow: () => BrowserWindow | null, event: GroupSessionEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("group:event", event);
  }
}

function createMessageId(): string {
  return `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function querySlot(
  slot: AgentSlot,
  prompt: string,
  conversationContext: string,
  cwd: string,
): Promise<string> {
  if (slot.engine === "claude") {
    return queryClaude(slot, prompt, conversationContext, cwd);
  }
  if (slot.engine === "openclaw") {
    return queryOpenClaw(slot, prompt, conversationContext, cwd);
  }
  if (slot.engine === "codex") {
    return queryCodex(slot, prompt, conversationContext, cwd);
  }
  throw new Error(`Unsupported engine: ${slot.engine}`);
}

async function queryClaude(
  slot: AgentSlot,
  prompt: string,
  context: string,
  cwd: string,
): Promise<string> {
  const query = await getSDK();
  const cliPath = await getClaudeBinaryPath();
  const fullPrompt = context
    ? `${context}\n\n---\n\nNow respond to this as "${slot.label}" (${slot.model}):\n${prompt}`
    : prompt;

  let text = "";
  const q = query({
    prompt: fullPrompt,
    options: {
      cwd,
      model: slot.model,
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      pathToClaudeCodeExecutable: cliPath,
      env: { ...process.env, ...clientAppEnv() },
    },
  });

  const timeout = setTimeout(() => {
    try { q.close(); } catch {}
  }, 120_000);

  try {
    for await (const msg of q) {
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text") text = block.text;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return text || "(no response)";
}

async function queryOpenClaw(
  slot: AgentSlot,
  prompt: string,
  context: string,
  _cwd: string,
): Promise<string> {
  const fullPrompt = context
    ? `${context}\n\n---\n\nNow respond as "${slot.label}":\n${prompt}`
    : prompt;

  return new Promise<string>((resolve) => {
    let result = "";
    const timeout = setTimeout(() => resolve(result || "(timeout)"), 120_000);

    const handler = (_event: unknown, data: Record<string, unknown>) => {
      if (data.type === "chat" && typeof data.text === "string") {
        result = data.text;
      }
      if (data.type === "turn_complete" || data.type === "error") {
        clearTimeout(timeout);
        ipcMain.removeListener("openclaw:event", handler as never);
        resolve(result || (data.type === "error" ? `(error: ${data.error})` : "(no response)"));
      }
    };

    ipcMain.on("openclaw:event", handler as never);

    ipcMain.emit("openclaw:send-internal", null, {
      agentId: slot.agentId || "default",
      text: fullPrompt,
    });
  });
}

async function queryCodex(
  slot: AgentSlot,
  prompt: string,
  context: string,
  _cwd: string,
): Promise<string> {
  const fullPrompt = context
    ? `${context}\n\n---\n\nRespond as "${slot.label}" (${slot.model}):\n${prompt}`
    : prompt;
  return `[Codex/${slot.model}] ${fullPrompt.slice(0, 200)}... (Codex group integration pending)`;
}

function buildConversationContext(messages: GroupMessage[], slots: AgentSlot[]): string {
  if (messages.length === 0) return "";
  const slotMap = new Map(slots.map((s) => [s.id, s]));
  const lines = messages.map((m) => {
    if (m.role === "user") return `[User]: ${m.content}`;
    const slot = slotMap.get(m.slotId);
    const label = slot?.label ?? m.slotId;
    return `[${label}]: ${m.content}`;
  });
  return "Previous conversation:\n" + lines.join("\n\n");
}

async function runGroupSession(
  getMainWindow: () => BrowserWindow | null,
  session: GroupSession,
  group: AgentGroup,
): Promise<void> {
  const state = activeGroupSessions.get(session.id);
  if (!state) return;

  const slots = group.slots;
  const leader = slots.find((s) => s.role === "leader");
  const members = slots.filter((s) => s.role === "member");

  state.session.status = "running";
  emit(getMainWindow, { type: "status", sessionId: session.id, status: "running" });

  const cwd = session.cwd || process.cwd();

  if (group.turnOrder === "parallel") {
    const context = buildConversationContext(state.session.messages, slots);
    const promises = slots.map(async (slot) => {
      if (state.aborted) return;
      try {
        const response = await querySlot(slot, session.prompt, context, cwd);
        const msg: GroupMessage = {
          id: createMessageId(),
          slotId: slot.id,
          role: "assistant",
          content: response,
          timestamp: new Date().toISOString(),
          turnIndex: state.session.currentTurnIndex,
        };
        state.session.messages.push(msg);
        emit(getMainWindow, { type: "message", sessionId: session.id, slotId: slot.id, message: msg });
      } catch (err) {
        emit(getMainWindow, { type: "error", sessionId: session.id, slotId: slot.id, error: String(err) });
      }
    });
    await Promise.allSettled(promises);

  } else if (group.turnOrder === "round-robin") {
    for (const slot of slots) {
      if (state.aborted) break;
      const context = buildConversationContext(state.session.messages, slots);
      try {
        const response = await querySlot(slot, session.prompt, context, cwd);
        const msg: GroupMessage = {
          id: createMessageId(),
          slotId: slot.id,
          role: "assistant",
          content: response,
          timestamp: new Date().toISOString(),
          turnIndex: state.session.currentTurnIndex,
        };
        state.session.messages.push(msg);
        emit(getMainWindow, { type: "message", sessionId: session.id, slotId: slot.id, message: msg });
        state.session.currentSlotIndex++;
        emit(getMainWindow, {
          type: "turn-advance",
          sessionId: session.id,
          turnIndex: state.session.currentTurnIndex,
        });
      } catch (err) {
        emit(getMainWindow, { type: "error", sessionId: session.id, slotId: slot.id, error: String(err) });
      }
    }

  } else if (group.turnOrder === "leader-decides") {
    for (const member of members) {
      if (state.aborted) break;
      const context = buildConversationContext(state.session.messages, slots);
      try {
        const response = await querySlot(member, session.prompt, context, cwd);
        const msg: GroupMessage = {
          id: createMessageId(),
          slotId: member.id,
          role: "assistant",
          content: response,
          timestamp: new Date().toISOString(),
          turnIndex: state.session.currentTurnIndex,
        };
        state.session.messages.push(msg);
        emit(getMainWindow, { type: "message", sessionId: session.id, slotId: member.id, message: msg });
      } catch (err) {
        emit(getMainWindow, { type: "error", sessionId: session.id, slotId: member.id, error: String(err) });
      }
    }

    if (leader && !state.aborted) {
      state.session.status = "waiting-leader";
      emit(getMainWindow, { type: "status", sessionId: session.id, status: "waiting-leader" });
      const context = buildConversationContext(state.session.messages, slots);
      const leaderPrompt =
        `You are the group leader. Review all member responses above and provide your synthesis/decision.\n\nOriginal prompt: ${session.prompt}`;
      try {
        const response = await querySlot(leader, leaderPrompt, context, cwd);
        const msg: GroupMessage = {
          id: createMessageId(),
          slotId: leader.id,
          role: "assistant",
          content: response,
          timestamp: new Date().toISOString(),
          turnIndex: state.session.currentTurnIndex,
        };
        state.session.messages.push(msg);
        emit(getMainWindow, { type: "message", sessionId: session.id, slotId: leader.id, message: msg });
      } catch (err) {
        emit(getMainWindow, { type: "error", sessionId: session.id, slotId: leader.id, error: String(err) });
      }
    }
  }

  if (!state.aborted) {
    state.session.status = "completed";
    emit(getMainWindow, { type: "complete", sessionId: session.id, status: "completed" });
  }

  saveGroupSession(state.session);
}

function saveGroup(group: AgentGroup): void {
  const filePath = path.join(getGroupsDir(), `${group.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(group, null, 2));
}

function loadGroup(groupId: string): AgentGroup | null {
  const filePath = path.join(getGroupsDir(), `${groupId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function listGroups(): AgentGroup[] {
  const dir = getGroupsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
}

function deleteGroup(groupId: string): void {
  const filePath = path.join(getGroupsDir(), `${groupId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function saveGroupSession(session: GroupSession): void {
  const filePath = path.join(getGroupSessionsDir(), `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

export function registerGroupSessionHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("group:list", () => {
    try {
      return { ok: true, groups: listGroups() };
    } catch (err) {
      return { ok: false, error: reportError("GROUP_LIST_ERR", err) };
    }
  });

  ipcMain.handle("group:create", (_event, group: AgentGroup) => {
    try {
      group.createdAt = new Date().toISOString();
      group.updatedAt = group.createdAt;
      saveGroup(group);
      log("GROUP_CREATE", { id: group.id, name: group.name, slots: group.slots.length });
      return { ok: true, group };
    } catch (err) {
      return { ok: false, error: reportError("GROUP_CREATE_ERR", err) };
    }
  });

  ipcMain.handle("group:update", (_event, group: AgentGroup) => {
    try {
      group.updatedAt = new Date().toISOString();
      saveGroup(group);
      return { ok: true, group };
    } catch (err) {
      return { ok: false, error: reportError("GROUP_UPDATE_ERR", err) };
    }
  });

  ipcMain.handle("group:delete", (_event, groupId: string) => {
    try {
      deleteGroup(groupId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: reportError("GROUP_DELETE_ERR", err) };
    }
  });

  ipcMain.handle(
    "group:start-session",
    async (_event, { groupId, prompt, cwd }: { groupId: string; prompt: string; cwd?: string }) => {
      try {
        const group = loadGroup(groupId);
        if (!group) return { ok: false, error: "Group not found" };

        const session: GroupSession = {
          id: `gs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          groupId,
          status: "idle",
          messages: [
            {
              id: createMessageId(),
              slotId: "user",
              role: "user",
              content: prompt,
              timestamp: new Date().toISOString(),
              turnIndex: 0,
            },
          ],
          currentTurnIndex: 0,
          currentSlotIndex: 0,
          prompt,
          cwd,
          startedAt: new Date().toISOString(),
        };

        activeGroupSessions.set(session.id, { session, aborted: false });
        log("GROUP_SESSION_START", { sessionId: session.id, groupId, slots: group.slots.length });

        runGroupSession(getMainWindow, session, group).catch((err) => {
          reportError("GROUP_SESSION_RUN_ERR", err, { sessionId: session.id });
        });

        return { ok: true, sessionId: session.id };
      } catch (err) {
        return { ok: false, error: reportError("GROUP_SESSION_START_ERR", err) };
      }
    },
  );

  ipcMain.handle("group:stop-session", (_event, sessionId: string) => {
    const state = activeGroupSessions.get(sessionId);
    if (state) {
      state.aborted = true;
      state.session.status = "completed";
      saveGroupSession(state.session);
      activeGroupSessions.delete(sessionId);
      emit(getMainWindow, { type: "status", sessionId, status: "completed" });
    }
    return { ok: true };
  });

  ipcMain.handle("group:get-session", (_event, sessionId: string) => {
    const state = activeGroupSessions.get(sessionId);
    if (state) return { ok: true, session: state.session };
    const filePath = path.join(getGroupSessionsDir(), `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      return { ok: true, session: JSON.parse(fs.readFileSync(filePath, "utf-8")) };
    }
    return { ok: false, error: "Session not found" };
  });
}
