import { BrowserWindow, ipcMain } from "electron";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { exec, execFile } from "child_process";
import { safeSend } from "../lib/safe-send";
import { getAppSetting } from "../lib/app-settings";
import { log } from "../lib/logger";
import { triggerIndex, compressConversation } from "../lib/rag/index";
import { webSearch, formatWebResults } from "../lib/rag/web-search";

interface OllamaMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface SessionState {
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];
  originalRequest: string;
  toolCallCount: number;
}

interface OllamaSession {
  messages: OllamaMessage[];
  cwd: string;
  model: string;
  abortController: AbortController | null;
  state: SessionState;
}

const sessions = new Map<string, OllamaSession>();

const MAX_FILE_READ_BYTES = 200_000;
const MAX_TOOL_LOOPS = 6;
const MAX_TOOL_OPS = MAX_TOOL_LOOPS * 2;
const MAX_SHELL_OUTPUT_BYTES = 16_000;
const SHELL_TIMEOUT_MS = 15_000;
const MAX_LIST_FILES = 500;
const MAX_SEARCH_MATCHES = 100;

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

function freshState(): SessionState {
  return { filesRead: [], filesModified: [], filesCreated: [], originalRequest: "", toolCallCount: 0 };
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(cwd: string): string {
  return `You are a coding assistant. CWD: ${cwd}

OUTPUT FORMAT — always respond with a JSON object:
{"tools":[...],"response":"..."}

- "tools": array of tool calls to execute (omit or use [] when just answering)
- "response": text for the user (omit when requesting tools, include when answering)

AVAILABLE TOOLS (8):
1. {"tools":[{"tool":"read_file","path":"relative/path"}]}
2. Write a file — JSON line then content block:
{"tools":[{"tool":"write_file","path":"relative/path"}]}
CONTENT:
full file content here
END_CONTENT
3. Edit a file — JSON line then SEARCH/REPLACE blocks:
{"tools":[{"tool":"edit_file","path":"relative/path"}]}
<<<<<<< SEARCH
exact old text (copied from file)
=======
new replacement text
>>>>>>> REPLACE
4. {"tools":[{"tool":"delete_file","path":"relative/path"}]}
5. {"tools":[{"tool":"list_files","path":"."}]}
6. {"tools":[{"tool":"search_files","pattern":"text","path":"."}]}
7. {"tools":[{"tool":"run_shell","command":"command here"}]}
8. {"tools":[{"tool":"web_search","query":"search terms"}]}

RULES:
1. Start your response with a JSON object on the first line. No markdown fences.
2. For write_file and edit_file, put file content AFTER the JSON line — never inside JSON strings.
3. You do NOT know any file contents. ALWAYS use read_file first. NEVER guess.
4. For edit_file, SEARCH block must match the file EXACTLY (same whitespace, same punctuation).
5. Always read_file before edit_file to get exact content.
6. Respond in the SAME language as the user.
7. When you have the info you need, include "response" with your answer and no "tools".
8. NEVER say "I cannot" or "I don't have access" — you have all tools.
9. You can request multiple tools at once in the "tools" array.

DECISION TREE:
- User asks about a file -> {"tools":[{"tool":"read_file","path":"that_file"}]}
- User asks to change a file -> read_file first, then edit_file with EXACT text
- User asks to create a file -> write_file with CONTENT block
- Don't know what files exist -> {"tools":[{"tool":"list_files","path":"."}]}
- Looking for specific code -> {"tools":[{"tool":"search_files","pattern":"keyword","path":"."}]}
- Need to run a command -> {"tools":[{"tool":"run_shell","command":"the command"}]}
- You already have tool results -> {"response":"your answer here"}

EXAMPLES:

User: "what's in package.json?"
{"tools":[{"tool":"read_file","path":"package.json"}]}

[system returns file content]
{"response":"The package.json has project my-app with React 19..."}

User: "add a test script to package.json"
{"tools":[{"tool":"read_file","path":"package.json"}]}

[system returns: "scripts": { "dev": "vite", "build": "vite build" }]
{"tools":[{"tool":"edit_file","path":"package.json"}]}
<<<<<<< SEARCH
    "build": "vite build"
  }
=======
    "build": "vite build",
    "test": "vitest"
  }
>>>>>>> REPLACE

[system confirms edit]
{"response":"Done! Added test: vitest to scripts."}

User: "create a hello.ts file"
{"tools":[{"tool":"write_file","path":"hello.ts"}]}
CONTENT:
export function hello() {
  console.log("Hello, world!");
}
END_CONTENT

[system confirms write]
{"response":"Created hello.ts with a hello() function."}

User: "list files in src/"
{"tools":[{"tool":"list_files","path":"src/"}]}`;
}

// ── JSON response parsing ───────────────────────────────────────────────────────

interface ToolRequest {
  tool: string;
  path?: string;
  content?: string;
  edits?: Array<{ search: string; replace: string }>;
  pattern?: string;
  command?: string;
  query?: string;
  reason?: string;
}

interface ModelResponse {
  intent?: string;
  tools?: ToolRequest[];
  response?: string;
}

function parseModelResponse(text: string): { parsed: ModelResponse | null; trailing: string } {
  let cleaned = text.trim();

  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  cleaned = cleaned.trim();

  const jsonLineMatch = cleaned.match(/^(\{[^\n]*\})\s*\n?([\s\S]*)$/);
  if (jsonLineMatch) {
    try {
      const parsed = JSON.parse(jsonLineMatch[1]) as ModelResponse;
      return { parsed, trailing: jsonLineMatch[2] || "" };
    } catch {}
  }

  try {
    return { parsed: JSON.parse(cleaned), trailing: "" };
  } catch {}

  const jsonMatch = cleaned.match(/(\{[\s\S]*?\})\s*([\s\S]*)$/);
  if (jsonMatch) {
    try {
      return { parsed: JSON.parse(jsonMatch[1]), trailing: jsonMatch[2] || "" };
    } catch {}

    try {
      const fixed = jsonMatch[1]
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/'/g, '"');
      return { parsed: JSON.parse(fixed), trailing: jsonMatch[2] || "" };
    } catch {}
  }

  return { parsed: null, trailing: "" };
}

function enrichToolsFromTrailing(tools: ToolRequest[], trailing: string): void {
  if (!trailing.trim()) return;

  for (const tool of tools) {
    if (tool.tool === "edit_file" && (!tool.edits || tool.edits.length === 0)) {
      const blockRe = /<{3,7}\s*SEARCH\s*\n([\s\S]*?)\n={3,7}\s*\n([\s\S]*?)\n>{3,7}\s*REPLACE/g;
      const edits: Array<{ search: string; replace: string }> = [];
      let bm: RegExpExecArray | null;
      while ((bm = blockRe.exec(trailing)) !== null) {
        edits.push({ search: bm[1], replace: bm[2] });
      }
      if (edits.length > 0) {
        tool.edits = edits;
      }
    }

    if (tool.tool === "write_file" && !tool.content) {
      const contentMatch = trailing.match(/CONTENT:\s*\n([\s\S]*?)(?:\nEND_CONTENT|$)/);
      if (contentMatch) {
        tool.content = contentMatch[1].replace(/\n$/, "");
      }
    }
  }
}

function hasToolRequests(parsed: ModelResponse | null): parsed is ModelResponse & { tools: ToolRequest[] } {
  return !!parsed && Array.isArray(parsed.tools) && parsed.tools.length > 0;
}

// ── Legacy XML fallback ─────────────────────────────────────────────────────────

function extractXmlToolTags(text: string): ToolRequest[] {
  const tools: ToolRequest[] = [];

  text = text.replace(
    /```(?:xml|html|plaintext)?\s*\n([\s\S]*?)\n```/g,
    (_match, inner: string) => {
      const trimmed = inner.trim();
      if (/^<(read_file|write_file|edit_file|delete_file|list_files|search_files|run_shell|web_search)\b/.test(trimmed)) {
        return trimmed;
      }
      return _match;
    },
  );

  text = text.replace(
    /<(read_file|write_file|edit_file|delete_file|list_files|search_files|run_shell|web_search)\s+([^>]*?)>/g,
    (_match, tag: string, attrs: string) => {
      const normalized = attrs.replace(/='([^']*)'/g, '="$1"');
      return `<${tag} ${normalized}>`;
    },
  );

  let m: RegExpExecArray | null;

  const readRe = /<read_file\s+path="([^"]+)"\s*\/>/g;
  while ((m = readRe.exec(text)) !== null) {
    tools.push({ tool: "read_file", path: m[1] });
  }

  const writeRe = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
  while ((m = writeRe.exec(text)) !== null) {
    tools.push({ tool: "write_file", path: m[1], content: m[2].replace(/^\n/, "") });
  }

  const editRe = /<edit_file\s+path="([^"]+)">([\s\S]*?)<\/edit_file>/g;
  while ((m = editRe.exec(text)) !== null) {
    const body = m[2];
    const blockRe = /<{3,7}\s*SEARCH\s*\n([\s\S]*?)\n={3,7}\s*\n([\s\S]*?)\n>{3,7}\s*REPLACE/g;
    const edits: Array<{ search: string; replace: string }> = [];
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(body)) !== null) {
      edits.push({ search: bm[1], replace: bm[2] });
    }
    if (edits.length > 0) {
      tools.push({ tool: "edit_file", path: m[1], edits });
    }
  }

  const deleteRe = /<delete_file\s+path="([^"]+)"\s*\/>/g;
  while ((m = deleteRe.exec(text)) !== null) {
    tools.push({ tool: "delete_file", path: m[1] });
  }

  const listRe = /<list_files(?:\s+path="([^"]+)")?(?:\s+pattern="([^"]+)")?\s*\/>/g;
  while ((m = listRe.exec(text)) !== null) {
    tools.push({ tool: "list_files", path: m[1] || ".", pattern: m[2] });
  }

  const searchRe = /<search_files\s+pattern="([^"]+)"(?:\s+path="([^"]+)")?\s*\/>/g;
  while ((m = searchRe.exec(text)) !== null) {
    tools.push({ tool: "search_files", pattern: m[1], path: m[2] || "." });
  }

  const shellRe = /<run_shell\s+command="([^"]+)"\s*\/>/g;
  while ((m = shellRe.exec(text)) !== null) {
    tools.push({ tool: "run_shell", command: m[1] });
  }

  const webSearchRe = /<web_search\s+query="([^"]+)"\s*\/>/g;
  while ((m = webSearchRe.exec(text)) !== null) {
    tools.push({ tool: "web_search", query: m[1] });
  }

  return tools;
}

// ── Content invention detection ──────────────────────────────────────────────

function looksLikeInventedContent(response: string, userMessage: string): boolean {
  const fileRe = /[\w./-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|css|json|md|yaml|yml|gitignore|env|toml|lock)\b/g;
  const userMentionedFiles = userMessage.match(fileRe);
  if (!userMentionedFiles || userMentionedFiles.length === 0) return false;

  const codeBlockRe = /```[\s\S]*?\n([\s\S]{200,}?)\n```/;
  if (codeBlockRe.test(response)) return true;

  const hasStructuredContent = (response.match(/[{}[\]]/g) ?? []).length > 6;
  if (hasStructuredContent && response.length > 300) {
    const { parsed } = parseModelResponse(response);
    if (parsed && (hasToolRequests(parsed) || parsed.response)) return false;
    return true;
  }

  return false;
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

function trimOutput(text: string, max = MAX_SHELL_OUTPUT_BYTES): string {
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function listFilesGit(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.trim().split("\n").filter(Boolean).sort());
    });
  });
}

function runShell(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_SHELL_OUTPUT_BYTES }, (err, stdout, stderr) => {
      const exitCode = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve({
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        exitCode,
      });
    });
  });
}

function searchFiles(pattern: string, cwd: string, relPath: string): Promise<string[]> {
  const resolved = path.resolve(cwd, relPath || ".");
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    return Promise.reject(new Error("path outside project"));
  }
  return listFilesGit(cwd).then((files) => {
    const normalizedBase = relPath === "." ? "" : `${relPath.replace(/\/$/, "")}/`;
    const matches: string[] = [];
    for (const file of files) {
      if (normalizedBase && file !== relPath && !file.startsWith(normalizedBase)) {
        continue;
      }
      const abs = safePath(cwd, file);
      if (!abs) continue;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_READ_BYTES) continue;
        const content = fs.readFileSync(abs, "utf-8");
        if (content.includes(pattern)) {
          matches.push(file);
        }
      } catch {
      }
      if (matches.length >= MAX_SEARCH_MATCHES) break;
    }
    return matches;
  });
}

async function executeToolRequests(
  toolRequests: ToolRequest[],
  cwd: string,
  sessionState: SessionState,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  let ops = 0;

  function emitToolStart(toolUseId: string, toolName: string, input: Record<string, unknown>) {
    log("OLLAMA_EVENT", `tool:start ${toolName} id=${toolUseId}`);
    safeSend(getMainWindow, "ollama:event", {
      _sessionId: sessionId, type: "tool:start",
      payload: { toolUseId, toolName, input }, _seq: 0,
    });
  }

  function emitToolResult(toolUseId: string, toolName: string, result: Record<string, unknown>) {
    log("OLLAMA_EVENT", `tool:result ${toolName} id=${toolUseId} error=${!!(result as { error?: unknown }).error}`);
    safeSend(getMainWindow, "ollama:event", {
      _sessionId: sessionId, type: "tool:result",
      payload: { toolUseId, toolName, result }, _seq: 0,
    });
  }

  for (const req of toolRequests) {
    if (ops >= MAX_TOOL_OPS) break;
    ops++;
    sessionState.toolCallCount++;

    switch (req.tool) {
      case "read_file": {
        const rel = req.path ?? "";
        const id = `ollama-read-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Read", { file_path: rel });
        const abs = safePath(cwd, rel);
        if (!abs) {
          const r = "Error: path outside project";
          results.push({ toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: ${r}` });
          emitToolResult(id, "Read", { error: r });
          break;
        }
        try {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_READ_BYTES) {
            const r = `file too large (${stat.size} bytes, max ${MAX_FILE_READ_BYTES})`;
            results.push({ toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: ${r}` });
            emitToolResult(id, "Read", { error: r });
            break;
          }
          const content = fs.readFileSync(abs, "utf-8");
          log("OLLAMA_TOOL", `read_file ${rel} (${stat.size} bytes)`);
          if (!sessionState.filesRead.includes(rel)) sessionState.filesRead.push(rel);
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
        break;
      }

      case "write_file": {
        const rel = req.path ?? "";
        const content = req.content ?? "";
        const id = `ollama-write-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Write", { file_path: rel });
        const abs = safePath(cwd, rel);
        if (!abs) {
          const r = "path outside project";
          results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: ${r}` });
          emitToolResult(id, "Write", { error: r });
          break;
        }
        try {
          const dir = path.dirname(abs);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(abs, content, "utf-8");
          log("OLLAMA_TOOL", `write_file ${rel} (${content.length} chars)`);
          if (!sessionState.filesCreated.includes(rel)) sessionState.filesCreated.push(rel);
          results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: OK (${content.length} bytes)` });
          emitToolResult(id, "Write", { status: "ok", bytesWritten: content.length });
        } catch (err) {
          const r = (err as Error).message;
          results.push({ toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: ${r}` });
          emitToolResult(id, "Write", { error: r });
        }
        break;
      }

      case "edit_file": {
        const rel = req.path ?? "";
        const id = `ollama-edit-${crypto.randomUUID().slice(0, 8)}`;
        const abs = safePath(cwd, rel);
        if (!abs) {
          emitToolStart(id, "Edit", { file_path: rel });
          const r = "path outside project";
          results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: ${r}` });
          emitToolResult(id, "Edit", { error: r });
          break;
        }
        try {
          let fileContent = fs.readFileSync(abs, "utf-8");
          const edits = req.edits ?? [];
          let replacements = 0;
          const oldParts: string[] = [];
          const newParts: string[] = [];
          for (const edit of edits) {
            if (fileContent.includes(edit.search)) {
              fileContent = fileContent.replace(edit.search, edit.replace);
              oldParts.push(edit.search);
              newParts.push(edit.replace);
              replacements++;
            }
          }
          if (replacements > 0) {
            fs.writeFileSync(abs, fileContent, "utf-8");
            const oldStr = oldParts.join("\n...\n");
            const newStr = newParts.join("\n...\n");
            emitToolStart(id, "Edit", { file_path: rel, old_string: oldStr, new_string: newStr });
            log("OLLAMA_TOOL", `edit_file ${rel} (${replacements} replacements)`);
            if (!sessionState.filesModified.includes(rel)) sessionState.filesModified.push(rel);
            results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: OK (${replacements} replacement${replacements > 1 ? "s" : ""})` });
            emitToolResult(id, "Edit", { status: "ok", replacements, oldString: oldStr, newString: newStr, filePath: rel });
          } else {
            emitToolStart(id, "Edit", { file_path: rel });
            results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: no matching search blocks found — read the file first to get exact content` });
            emitToolResult(id, "Edit", { error: "no matching blocks" });
          }
        } catch (err) {
          emitToolStart(id, "Edit", { file_path: rel });
          const r = (err as Error).message;
          results.push({ toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: ${r}` });
          emitToolResult(id, "Edit", { error: r });
        }
        break;
      }

      case "delete_file": {
        const rel = req.path ?? "";
        const id = `ollama-delete-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Delete", { file_path: rel });
        const abs = safePath(cwd, rel);
        if (!abs) {
          const r = "path outside project";
          results.push({ toolName: "Delete", input: { file_path: rel }, result: `Delete ${rel}: ${r}` });
          emitToolResult(id, "Delete", { error: r });
          break;
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
        break;
      }

      case "list_files": {
        const rel = req.path || ".";
        const pattern = req.pattern || "";
        const id = `ollama-glob-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Glob", { path: rel, pattern });
        try {
          const files = await listFilesGit(cwd);
          const normalizedBase = rel === "." ? "" : `${rel.replace(/\/$/, "")}/`;
          const filtered = files
            .filter((file) => !normalizedBase || file === rel || file.startsWith(normalizedBase))
            .filter((file) => !pattern || file.includes(pattern.replace(/\*/g, "")))
            .slice(0, MAX_LIST_FILES);
          results.push({
            toolName: "Glob",
            input: { path: rel, pattern },
            result: `List ${rel}: OK (${filtered.length} file${filtered.length === 1 ? "" : "s"})`,
          });
          emitToolResult(id, "Glob", { filenames: filtered, numFiles: filtered.length, mode: "files_with_matches" });
        } catch (err) {
          const error = (err as Error).message;
          results.push({ toolName: "Glob", input: { path: rel, pattern }, result: `List ${rel}: ${error}` });
          emitToolResult(id, "Glob", { error });
        }
        break;
      }

      case "search_files": {
        const pattern = req.pattern ?? "";
        const rel = req.path || ".";
        const id = `ollama-grep-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Grep", { pattern, path: rel });
        try {
          const matches = await searchFiles(pattern, cwd, rel);
          results.push({
            toolName: "Grep",
            input: { pattern, path: rel },
            result: `Search "${pattern}" in ${rel}: OK (${matches.length} match${matches.length === 1 ? "" : "es"})`,
          });
          emitToolResult(id, "Grep", { filenames: matches, numFiles: matches.length, mode: "files_with_matches" });
        } catch (err) {
          const error = (err as Error).message;
          results.push({ toolName: "Grep", input: { pattern, path: rel }, result: `Search "${pattern}" in ${rel}: ${error}` });
          emitToolResult(id, "Grep", { error });
        }
        break;
      }

      case "web_search": {
        const query = req.query ?? "";
        const id = `ollama-web-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "WebSearch", { query });
        try {
          const searchResult = await webSearch(query);
          const formatted = formatWebResults(searchResult);
          log("OLLAMA_TOOL", `web_search "${query}" (${searchResult.results.length} results)`);
          results.push({ toolName: "WebSearch", input: { query }, result: formatted });
          emitToolResult(id, "WebSearch", {
            query,
            abstract: searchResult.abstract,
            abstractUrl: searchResult.abstractUrl,
            results: searchResult.results,
          });
        } catch (err) {
          const error = (err as Error).message;
          results.push({ toolName: "WebSearch", input: { query }, result: `Web search failed: ${error}` });
          emitToolResult(id, "WebSearch", { error });
        }
        break;
      }

      case "run_shell": {
        const command = req.command ?? "";
        const id = `ollama-bash-${crypto.randomUUID().slice(0, 8)}`;
        emitToolStart(id, "Bash", { command });
        const shellResult = await runShell(command, cwd);
        const summary = `Shell "${command}": exit ${shellResult.exitCode}`;
        results.push({
          toolName: "Bash",
          input: { command },
          result: [summary, shellResult.stdout, shellResult.stderr].filter(Boolean).join("\n"),
        });
        emitToolResult(id, "Bash", {
          stdout: shellResult.stdout,
          stderr: shellResult.stderr,
          exitCode: shellResult.exitCode,
          output: [shellResult.stdout, shellResult.stderr].filter(Boolean).join("\n"),
        });
        break;
      }
    }
  }

  return results;
}

// ── Build structured feedback ───────────────────────────────────────────────────

function buildToolFeedback(results: ToolResult[], sessionState: SessionState): string {
  const feedback: Record<string, unknown> = {
    type: "tool_results",
    results: results.map((r) => {
      const entry: Record<string, unknown> = {
        tool: r.toolName,
        status: r.result,
      };
      if (r.attachment) {
        entry.content = r.attachment.content;
        entry.path = r.attachment.path;
      }
      return entry;
    }),
    session: {
      files_read: sessionState.filesRead,
      files_modified: sessionState.filesModified,
      files_created: sessionState.filesCreated,
      total_tool_calls: sessionState.toolCallCount,
      original_request: sessionState.originalRequest,
    },
    instruction: "Now answer or apply changes. For edits use exact text from tool results. If you just edited or wrote a file, verify the change is correct and has no syntax errors — if you suspect a problem, use read_file to check. Respond in JSON. Use the user's language.",
  };
  return JSON.stringify(feedback, null, 2);
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
      model: session.model,
      messages: compressConversation(session.messages),
      stream: true,
      temperature: 0.1,
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
      }
    }
  }

  return fullText;
}

// ── Extract display text from model response ────────────────────────────────────

function extractDisplayText(fullText: string, parsed: ModelResponse | null): string {
  if (parsed?.response) return parsed.response;

  let cleaned = fullText;

  try {
    const jsonMatch = cleaned.match(/^\s*\{[^\n]*\}/m);
    if (jsonMatch) {
      cleaned = cleaned.replace(jsonMatch[0], "");
    }
  } catch {}

  cleaned = cleaned
    .replace(/<{3,7}\s*SEARCH\s*\n[\s\S]*?\n>{3,7}\s*REPLACE/g, "")
    .replace(/CONTENT:\s*\n[\s\S]*?(?:\nEND_CONTENT|$)/g, "")
    .replace(/<read_file\s+path="[^"]+"\s*\/>/g, "")
    .replace(/<write_file\s+path="[^"]+">([\s\S]*?)<\/write_file>/g, "")
    .replace(/<edit_file\s+path="[^"]+">([\s\S]*?)<\/edit_file>/g, "")
    .replace(/<delete_file\s+path="[^"]+"\s*\/>/g, "")
    .replace(/<list_files(?:\s+path="[^"]+")?(?:\s+pattern="[^"]+")?\s*\/>/g, "")
    .replace(/<search_files\s+pattern="[^"]+"(?:\s+path="[^"]+")?\s*\/>/g, "")
    .replace(/<run_shell\s+command="[^"]+"\s*\/>/g, "")
    .replace(/<web_search\s+query="[^"]+"\s*\/>/g, "")
    .replace(/^\s*[,;]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

// ── IPC registration ───────────────────────────────────────────────────────────

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("ollama:start", async (_event, { cwd, model }: { cwd: string; model?: string }) => {
    const sessionId = crypto.randomUUID();
    const sessionModel = model || getDefaultModel();
    sessions.set(sessionId, {
      messages: [{ role: "system", content: buildSystemPrompt(cwd) }],
      cwd,
      model: sessionModel,
      abortController: null,
      state: freshState(),
    });

    triggerIndex(cwd);

    return { sessionId, model: sessionModel };
  });

  ipcMain.handle("ollama:send", async (_event, { sessionId, text }: { sessionId: string; text: string }) => {
    const session = sessions.get(sessionId);
    if (!session) return { error: "Session not found" };

    session.state.originalRequest = text;

    const isWebQuery = /\b(pesquise na web|busque na web|search the web|busca online|web search|na internet|on the internet|look up online|pesquisa|pesquisar|buscar)\b/i.test(text);

    try {
      if (isWebQuery) {
        const searchQuery = text
          .replace(/\b(pesquise na web|busque na web|search the web|busca online|web search|na internet|on the internet|look up online|pesquisa|pesquisar|buscar)\b/gi, "")
          .replace(/\b(sobre|about|for|por|de|do|da)\b/gi, "")
          .trim() || text;
        const searchId = `ollama-web-${crypto.randomUUID().slice(0, 8)}`;
        emit(getMainWindow, sessionId, "tool:start", { toolUseId: searchId, toolName: "WebSearch", input: { query: searchQuery } });
        try {
          const searchResult = await webSearch(searchQuery);
          const formatted = formatWebResults(searchResult);
          log("OLLAMA_WEB", `query="${searchQuery}" results=${searchResult.results.length}`);
          emit(getMainWindow, sessionId, "tool:result", {
            toolUseId: searchId, toolName: "WebSearch",
            result: { query: searchQuery, abstract: searchResult.abstract, abstractUrl: searchResult.abstractUrl, results: searchResult.results },
          });
          session.messages.push({ role: "user", content: text });
          session.messages.push({
            role: "user",
            content: `Web search results for "${searchQuery}":\n\n${formatted}\n\nUsing ONLY the information above, answer the user's question. If the results are insufficient, say so. Respond in JSON format.`,
          });
        } catch (searchErr) {
          log("OLLAMA_WEB", `search failed: ${(searchErr as Error).message}`);
          emit(getMainWindow, sessionId, "tool:result", {
            toolUseId: searchId, toolName: "WebSearch",
            result: { error: (searchErr as Error).message },
          });
          session.messages.push({ role: "user", content: text });
        }
      } else {
        session.messages.push({ role: "user", content: text });
      }
    } catch (err) {
      log("RAG", `failed, using plain message: ${(err as Error).message}`);
      session.messages.push({ role: "user", content: text });
    }

    const controller = new AbortController();
    session.abortController = controller;

    emit(getMainWindow, sessionId, "lifecycle:start", {});

    try {
      let loopCount = 0;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        const fullText = await streamOllamaResponse(session, controller, getMainWindow, sessionId);

        const { parsed, trailing } = parseModelResponse(fullText);
        let toolRequests: ToolRequest[] = [];

        if (hasToolRequests(parsed)) {
          toolRequests = parsed.tools;
          enrichToolsFromTrailing(toolRequests, trailing);
          log("OLLAMA", `JSON protocol: ${toolRequests.length} tool(s) requested`);
        } else {
          toolRequests = extractXmlToolTags(fullText);
          if (toolRequests.length > 0) {
            log("OLLAMA", `XML fallback: ${toolRequests.length} tool(s) detected`);
          }
        }

        if (toolRequests.length === 0) {
          if (loopCount === 1 && looksLikeInventedContent(fullText, text)) {
            log("OLLAMA", "model invented content instead of using tools — re-prompting");
            session.messages.push({ role: "assistant", content: fullText });
            emit(getMainWindow, sessionId, "chat:clear-streaming", {});
            session.messages.push({
              role: "user",
              content: JSON.stringify({
                type: "correction",
                error: "You are guessing file content. You MUST use read_file to see real content.",
                instruction: "Try again. Output ONLY a JSON object with tools array.",
                example: '{"tools":[{"tool":"read_file","path":"the_file"}]}',
              }),
            });
            emit(getMainWindow, sessionId, "lifecycle:start", {});
            continue;
          }

          const finalDisplay = extractDisplayText(fullText, parsed);
          session.messages.push({ role: "assistant", content: fullText });
          emit(getMainWindow, sessionId, "chat:final", { message: finalDisplay || fullText });
          break;
        }

        session.messages.push({ role: "assistant", content: fullText });

        const displayText = extractDisplayText(fullText, parsed);
        if (displayText) {
          emit(getMainWindow, sessionId, "chat:mid-final", { message: displayText });
        } else {
          emit(getMainWindow, sessionId, "chat:clear-streaming", {});
        }

        const results = await executeToolRequests(toolRequests, session.cwd, session.state, getMainWindow, sessionId);

        const feedback = buildToolFeedback(results, session.state);
        session.messages.push({ role: "user", content: feedback });

        emit(getMainWindow, sessionId, "lifecycle:start", {});
      }

      if (loopCount >= MAX_TOOL_LOOPS) {
        emit(getMainWindow, sessionId, "chat:error", { message: "Limite de chamadas de ferramentas atingido (6 loops)" });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        const last = [...session.messages].reverse().find((m) => m.role === "assistant");
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
