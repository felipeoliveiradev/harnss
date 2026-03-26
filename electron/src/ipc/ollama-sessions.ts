import { BrowserWindow, ipcMain } from "electron";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { safeSend } from "../lib/safe-send";
import { getAppSetting } from "../lib/app-settings";
import { log } from "../lib/logger";

interface OllamaMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OllamaSession {
  messages: OllamaMessage[];
  cwd: string;
  abortController: AbortController | null;
}

const sessions = new Map<string, OllamaSession>();

const MAX_FILE_READ_BYTES = 200_000; // 200 KB
const MAX_TOOL_LOOPS = 6; // prevent infinite loops

function getBaseUrl(): string {
  return (getAppSetting("ollamaBaseUrl") || "http://localhost:11434").replace(/\/$/, "");
}

function getDefaultModel(): string {
  return getAppSetting("ollamaDefaultModel") || "llama3";
}

function emit(
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type, payload, _seq: 0 });
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(cwd: string): string {
  return `You are a senior software engineer working as an autonomous coding assistant inside Harnss.
Working directory: ${cwd}

## You have built-in tools. Use them directly — do NOT ask the user to share files.

The application intercepts specific XML tags you write in your responses and executes them automatically. The results are fed back to you so you can continue working.

---

## Tool: read_file

Read the contents of a file.

\`\`\`
<read_file path="relative/path/to/file.ts"/>
\`\`\`

You will receive the full file content in the next message.

---

## Tool: write_file

Create or fully overwrite a file.

\`\`\`
<write_file path="relative/path/to/newfile.ts">
// full file content here
</write_file>
\`\`\`

---

## Tool: edit_file

Modify specific sections of an existing file using SEARCH/REPLACE blocks.

\`\`\`
<edit_file path="relative/path/to/file.ts">
<<<<<<< SEARCH
const old = "value";
=======
const old = "newvalue";
>>>>>>> REPLACE
</edit_file>
\`\`\`

The SEARCH block must match the file content exactly (whitespace included).
You can have multiple SEARCH/REPLACE blocks in a single edit_file call.

---

## Tool: delete_file

Delete a file.

\`\`\`
<delete_file path="relative/path/to/file.ts"/>
\`\`\`

---

## Workflow

1. When you need to read a file: use \`<read_file path="..."/>\`. Results come back automatically.
2. When you need to modify a file: use \`<edit_file>\` (prefer this for changes) or \`<write_file>\` (for new files or full rewrites).
3. You can use multiple tool tags in a single response.
4. After tool results are returned, continue reasoning and acting until the task is complete.
5. Only respond with a final summary when there is nothing left to do.

## Rules

- Always read a file before editing it (so the SEARCH blocks match exactly).
- All paths are relative to the working directory: ${cwd}
- Never invent file contents — always read first.
- Be autonomous: chain tool calls until the task is fully done.`;
}

// ── Tool execution ─────────────────────────────────────────────────────────────

function safePath(cwd: string, relPath: string): string | null {
  const abs = path.resolve(cwd, relPath);
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) return null;
  return abs;
}

interface ToolResult {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  attachment?: { path: string; content: string };
}

function executeToolTags(
  fullText: string,
  cwd: string,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): { results: ToolResult[]; cleanedText: string } {
  const results: ToolResult[] = [];
  const processed = new Set<string>();
  let ops = 0;

  function emitToolStart(toolUseId: string, toolName: string, input: Record<string, unknown>) {
    safeSend(getMainWindow, "ollama:event", {
      _sessionId: sessionId, type: "tool:start",
      payload: { toolUseId, toolName, input }, _seq: 0,
    });
  }
  function emitToolResult(toolUseId: string, toolName: string, result: Record<string, unknown>) {
    safeSend(getMainWindow, "ollama:event", {
      _sessionId: sessionId, type: "tool:result",
      payload: { toolUseId, toolName, result }, _seq: 0,
    });
  }

  // read_file
  const readRe = /<read_file\s+path="([^"]+)"\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = readRe.exec(fullText)) !== null) {
    const rel = m[1];
    const key = `read:${rel}`;
    if (processed.has(key) || ops >= MAX_TOOL_LOOPS * 2) continue;
    processed.add(key); ops++;
    const id = `ollama-read-${crypto.randomUUID().slice(0, 8)}`;
    emitToolStart(id, "Read", { file_path: rel });
    const abs = safePath(cwd, rel);
    if (!abs) {
      const r = "Error: path outside project";
      results.push({ toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: ${r}` });
      emitToolResult(id, "Read", { error: r });
      continue;
    }
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_READ_BYTES) {
        const r = `file too large (${stat.size} bytes, max ${MAX_FILE_READ_BYTES})`;
        results.push({ toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: ${r}` });
        emitToolResult(id, "Read", { error: r });
        continue;
      }
      const content = fs.readFileSync(abs, "utf-8");
      log("OLLAMA_TOOL", `read_file ${rel} (${stat.size} bytes)`);
      results.push({
        toolName: "Read", input: { file_path: rel },
        result: `Read ${rel}: OK (${stat.size} bytes)`,
        attachment: { path: rel, content },
      });
      emitToolResult(id, "Read", { content: content.slice(0, 300) + (content.length > 300 ? "\n..." : "") });
    } catch {
      const r = "file not found";
      results.push({ toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: ${r}` });
      emitToolResult(id, "Read", { error: r });
    }
  }

  // write_file
  const writeRe = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
  while ((m = writeRe.exec(fullText)) !== null) {
    const rel = m[1];
    const key = `write:${rel}`;
    if (processed.has(key) || ops >= MAX_TOOL_LOOPS * 2) continue;
    processed.add(key); ops++;
    const content = m[2].replace(/^\n/, "");
    const id = `ollama-write-${crypto.randomUUID().slice(0, 8)}`;
    emitToolStart(id, "Write", { file_path: rel });
    const abs = safePath(cwd, rel);
    if (!abs) {
      const r = "path outside project";
      results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: ${r}` });
      emitToolResult(id, "Write", { error: r });
      continue;
    }
    try {
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      log("OLLAMA_TOOL", `write_file ${rel} (${content.length} chars)`);
      results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: OK (${content.length} bytes)` });
      emitToolResult(id, "Write", { status: "ok", bytesWritten: content.length });
    } catch (err) {
      const r = (err as Error).message;
      results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: ${r}` });
      emitToolResult(id, "Write", { error: r });
    }
  }

  // edit_file
  const editRe = /<edit_file\s+path="([^"]+)">([\s\S]*?)<\/edit_file>/g;
  while ((m = editRe.exec(fullText)) !== null) {
    const rel = m[1];
    const key = `edit:${rel}`;
    if (processed.has(key) || ops >= MAX_TOOL_LOOPS * 2) continue;
    processed.add(key); ops++;
    const body = m[2];
    const id = `ollama-edit-${crypto.randomUUID().slice(0, 8)}`;
    const abs = safePath(cwd, rel);
    if (!abs) {
      emitToolStart(id, "Edit", { file_path: rel });
      const r = "path outside project";
      results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: ${r}` });
      emitToolResult(id, "Edit", { error: r });
      continue;
    }
    try {
      let fileContent = fs.readFileSync(abs, "utf-8");
      const blockRe = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
      let bm: RegExpExecArray | null;
      let replacements = 0;
      const oldParts: string[] = [];
      const newParts: string[] = [];
      while ((bm = blockRe.exec(body)) !== null) {
        const search = bm[1];
        const replace = bm[2];
        if (fileContent.includes(search)) {
          fileContent = fileContent.replace(search, replace);
          oldParts.push(search);
          newParts.push(replace);
          replacements++;
        }
      }
      if (replacements > 0) {
        fs.writeFileSync(abs, fileContent, "utf-8");
        const oldStr = oldParts.join("\n...\n");
        const newStr = newParts.join("\n...\n");
        emitToolStart(id, "Edit", { file_path: rel, old_string: oldStr, new_string: newStr });
        log("OLLAMA_TOOL", `edit_file ${rel} (${replacements} replacements)`);
        results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: OK (${replacements} replacement${replacements > 1 ? "s" : ""})` });
        emitToolResult(id, "Edit", { status: "ok", replacements, oldString: oldStr, newString: newStr, filePath: rel });
      } else {
        emitToolStart(id, "Edit", { file_path: rel });
        results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: no matching SEARCH blocks found — read the file first to get exact content` });
        emitToolResult(id, "Edit", { error: "no matching blocks" });
      }
    } catch (err) {
      emitToolStart(id, "Edit", { file_path: rel });
      const r = (err as Error).message;
      results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: ${r}` });
      emitToolResult(id, "Edit", { error: r });
    }
  }

  // delete_file
  const deleteRe = /<delete_file\s+path="([^"]+)"\s*\/>/g;
  while ((m = deleteRe.exec(fullText)) !== null) {
    const rel = m[1];
    const key = `delete:${rel}`;
    if (processed.has(key) || ops >= MAX_TOOL_LOOPS * 2) continue;
    processed.add(key); ops++;
    const id = `ollama-delete-${crypto.randomUUID().slice(0, 8)}`;
    emitToolStart(id, "Delete", { file_path: rel });
    const abs = safePath(cwd, rel);
    if (!abs) {
      const r = "path outside project";
      results.push({ toolName: "Delete", input: { file_path: rel }, result: `Delete ${rel}: ${r}` });
      emitToolResult(id, "Delete", { error: r });
      continue;
    }
    try {
      fs.unlinkSync(abs);
      log("OLLAMA_TOOL", `delete_file ${rel}`);
      results.push({ toolName: "Delete", input: { file_path: rel }, result: `Delete ${rel}: OK` });
      emitToolResult(id, "Delete", { status: "ok" });
    } catch (err) {
      const r = (err as Error).message;
      results.push({ toolName: "Delete", input: { file_path: rel }, result: `Delete ${rel}: ${r}` });
      emitToolResult(id, "Delete", { error: r });
    }
  }

  // Strip tool tags from displayed text
  let cleanedText = fullText
    .replace(/<read_file\s+path="[^"]+"\s*\/>/g, "")
    .replace(/<write_file\s+path="[^"]+">([\s\S]*?)<\/write_file>/g, "")
    .replace(/<edit_file\s+path="[^"]+">([\s\S]*?)<\/edit_file>/g, "")
    .replace(/<delete_file\s+path="[^"]+"\s*\/>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { results, cleanedText };
}

// ── Streaming helper ───────────────────────────────────────────────────────────

async function streamOllamaResponse(
  session: OllamaSession,
  controller: AbortController,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<string> {
  const response = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: getDefaultModel(),
      messages: session.messages,
      stream: true,
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(errText);
  }
  if (!response.body) throw new Error("No response body from Ollama");

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          emit(getMainWindow, sessionId, "chat:delta", { text: fullText });
        }
      } catch {
        // ignore malformed SSE lines
      }
    }
  }

  return fullText;
}

// ── IPC registration ───────────────────────────────────────────────────────────

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("ollama:start", async (_event, { cwd }: { cwd: string }) => {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      messages: [{ role: "system", content: buildSystemPrompt(cwd) }],
      cwd,
      abortController: null,
    });
    return { sessionId };
  });

  ipcMain.handle("ollama:send", async (_event, { sessionId, text }: { sessionId: string; text: string }) => {
    const session = sessions.get(sessionId);
    if (!session) return { error: "Session not found" };

    session.messages.push({ role: "user", content: text });

    const controller = new AbortController();
    session.abortController = controller;

    emit(getMainWindow, sessionId, "lifecycle:start", {});

    try {
      let loopCount = 0;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        const fullText = await streamOllamaResponse(session, controller, getMainWindow, sessionId);

        // Parse and execute any tool tags in the response
        const { results, cleanedText } = executeToolTags(fullText, session.cwd, getMainWindow, sessionId);

        if (results.length === 0) {
          // No tool calls — this is the final response
          session.messages.push({ role: "assistant", content: fullText });
          emit(getMainWindow, sessionId, "chat:final", { message: fullText });
          break;
        }

        // Tool calls were made — store cleaned text and feed results back
        session.messages.push({ role: "assistant", content: fullText });
        emit(getMainWindow, sessionId, "chat:final", { message: cleanedText });

        // Build feedback message with file contents for reads
        const feedbackParts: string[] = ["Tool results:"];
        for (const r of results) {
          feedbackParts.push(r.result);
          if (r.attachment) {
            feedbackParts.push(`\nContents of ${r.attachment.path}:\n\`\`\`\n${r.attachment.content}\n\`\`\``);
          }
        }

        session.messages.push({ role: "user", content: feedbackParts.join("\n") });

        // Emit lifecycle:start for the next iteration (continuation turn)
        emit(getMainWindow, sessionId, "lifecycle:start", {});
      }

      if (loopCount >= MAX_TOOL_LOOPS) {
        emit(getMainWindow, sessionId, "chat:error", { message: "Maximum tool loop depth reached" });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        const last = session.messages.findLast((m) => m.role === "assistant");
        emit(getMainWindow, sessionId, "chat:final", { message: last?.content ?? "" });
      } else {
        emit(getMainWindow, sessionId, "chat:error", {
          message: (err as Error).message || "Ollama request failed",
        });
      }
    } finally {
      session.abortController = null;
    }

    return { ok: true };
  });

  ipcMain.handle("ollama:stop", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortController?.abort();
      sessions.delete(sessionId);
    }
    safeSend(getMainWindow, "ollama:exit", { _sessionId: sessionId });
    return { ok: true };
  });

  ipcMain.handle("ollama:interrupt", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    session?.abortController?.abort();
    return { ok: true };
  });

  ipcMain.handle("ollama:status", async () => {
    try {
      const response = await fetch(`${getBaseUrl()}/api/version`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return { available: true };
      return { available: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("ollama:list-models", async () => {
    try {
      const response = await fetch(`${getBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` };
      const data = await response.json() as { models?: Array<{ name: string }> };
      return { ok: true, models: (data.models ?? []).map((m) => m.name) };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });
}
