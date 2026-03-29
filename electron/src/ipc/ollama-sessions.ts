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
import { crawlUrl } from "../lib/rag/web-crawl";
import { filterFiles } from "../lib/harnssignore";
import { getMcpToolsForOllama, executeMcpTool, disconnectMcpBridge, type McpBridgeState } from "../lib/mcp-bridge";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface SessionState {
  filesRead: string[];
  filesModified: string[];
  filesCreated: string[];
  originalRequest: string;
  toolCallCount: number;
  recentToolSignatures: string[];
  pendingPages: Map<string, string[]>;
}

interface OllamaSession {
  messages: OllamaMessage[];
  cwd: string;
  model: string;
  contextSize: number;
  abortController: AbortController | null;
  state: SessionState;
  mcpBridge: McpBridgeState | null;
  mcpTools: Array<{ type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } } }>;
}

interface ToolResult {
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  content: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, OllamaSession>();

const MAX_FILE_READ_BYTES = 200_000;
const MAX_TOOL_LOOPS = 50;
const MAX_TOOL_OPS = MAX_TOOL_LOOPS * 3;
const MAX_SHELL_OUTPUT_BYTES = 16_000;
const SHELL_TIMEOUT_MS = 15_000;
const MAX_LIST_FILES = 500;
const MAX_SEARCH_MATCHES = 100;
const PAGE_SIZE = 50;
const TREE_COLLAPSE_THRESHOLD = 30;

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
  return { filesRead: [], filesModified: [], filesCreated: [], originalRequest: "", toolCallCount: 0, recentToolSignatures: [], pendingPages: new Map() };
}

// ── Native tool definitions ────────────────────────────────────────────────────

const OLLAMA_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read file contents. You MUST call this before edit_file. You can read multiple files in parallel.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create a NEW file or overwrite an existing file. USE THIS to create project files. Call multiple write_file in parallel to create all files at once. ALWAYS use this instead of describing code.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file content" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Replace exact text in an existing file. You MUST read_file first. old_string must match the file EXACTLY.",
      parameters: {
        type: "object",
        required: ["path", "old_string", "new_string"],
        properties: {
          path: { type: "string", description: "Relative file path" },
          old_string: { type: "string", description: "Exact text to find (must match file content exactly)" },
          new_string: { type: "string", description: "Replacement text" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Delete a file.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files in a directory. Returns a tree view of the project structure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: '.')" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_files",
      description: "Search for text pattern in project files.",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Text to search for" },
          path: { type: "string", description: "Directory to search in (default: '.')" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description: "Execute a shell command (npm install, mkdir, git, etc). Use for project setup and running commands.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for information.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_url",
      description: "Read a web page and extract its content as markdown. Use after web_search to read a specific result page.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "Full URL to read (https://...)" },
        },
      },
    },
  },
];

// ── System prompt (behavior only, no tool format) ──────────────────────────────

function buildSystemPrompt(cwd: string, skillContents?: string[], mcpToolNames?: string[]): string {
  let prompt = `You are an expert software engineer operating as a coding agent inside Harnss, a desktop IDE.
Your current working directory is: ${cwd}

====

CAPABILITIES

You have access to tools that let you execute CLI commands, list files, search code, read and write files. These tools help you accomplish tasks such as writing code, making edits, understanding projects, setting up new projects, and performing system operations.

IMPORTANT: You can ONLY interact with the project through tool calls. Writing code directly in your response text has NO EFFECT on the file system. Only tool calls actually create or modify files.

====

HOW TO CALL TOOLS

You call tools using function calling — NOT by writing tool names in your text. When you want to use a tool, you must make a proper function call through the API, not type the tool name in your message.

WRONG (do NOT do this):
  run_shell[ARGS]{"command": "npm install"}
  write_file[ARGS]{"path": "index.ts", "content": "..."}

These text representations do NOTHING. They are just text. The system cannot execute them.

RIGHT:
Call the tool through the function calling mechanism. The system will show you the available functions. When you want to create a file, CALL the write_file function. When you want to run a command, CALL the run_shell function. Do not write about calling them — actually invoke them.

The difference: writing "run_shell" in your text is like writing the word "phone" on paper — it doesn't make a call. You need to actually USE the function calling mechanism provided to you.

====

AVAILABLE TOOLS

You have these tools. Call them through function calling (not by writing their names in text):

## write_file
Write content to a file, creating it if it does not exist. This tool will automatically create any directories needed.
Parameters:
- path: (required) File path relative to ${cwd}
- content: (required) The COMPLETE file content. Always provide the full content, never truncate or use placeholders.
WHEN TO USE: To create new files or completely replace existing files. This is your PRIMARY tool for building projects.

## read_file
Read the contents of a file.
Parameters:
- path: (required) File path relative to ${cwd}
WHEN TO USE: Before editing a file with edit_file, to get its exact current content.

## edit_file
Replace exact text in an existing file. You MUST call read_file first.
Parameters:
- path: (required) File path relative to ${cwd}
- old_string: (required) The exact text to find. Must match the file content EXACTLY, including whitespace and punctuation.
- new_string: (required) The replacement text.
WHEN TO USE: To make targeted changes to existing files. ALWAYS read_file first.

## delete_file
Delete a file.
Parameters:
- path: (required) File path relative to ${cwd}

## list_files
List files in a directory as a tree view.
Parameters:
- path: Directory path (default: ".")

## search_files
Search for a text pattern across project files.
Parameters:
- pattern: Text or regex pattern to search for
- path: Directory to search in (default: ".")

## run_shell
Execute a shell command in ${cwd}. Commands run non-interactively — they cannot ask for user input.
Parameters:
- command: (required) The shell command to execute.
WHEN TO USE: For npm/pnpm install, npx commands, mkdir, git, running scripts, etc.
IMPORTANT RULES:
- If you need to run a command in a subdirectory, prepend with cd: "cd my-project && npm install"
- ALWAYS use non-interactive flags: --yes, -y, --no-input, --default
- For create-next-app: ALWAYS use "npx create-next-app@latest my-app --yes --typescript --tailwind --eslint --src-dir --use-npm"
- NEVER run the same command twice. If it failed, try a DIFFERENT approach.
- If a scaffold command fails, create the project manually with mkdir + write_file instead.

## web_search
Search the web for information. Use this when you encounter an error you don't know how to fix, need documentation, or need to find solutions.
Parameters:
- query: (required) Search query. Be specific, e.g., "next.js 14 app router dynamic routes tutorial".

## read_url
Fetch and read the content of a web page. Use this after web_search to read a specific page with a solution or documentation.
Parameters:
- url: (required) The full URL to fetch.

====

WORKFLOW

You MUST always follow this structured workflow. NEVER skip steps.

STEP 1 — ALWAYS PLAN AND BREAK INTO TASKS FIRST:
Before ANY code or tool calls, you MUST create a detailed plan. Break the work into small, numbered tasks. This is MANDATORY for EVERY request, no matter how simple. Even a "create a button" request needs tasks.

Format your plan EXACTLY like this:
"Plan:
1. [Task description]
2. [Task description]
3. [Task description]
...
N. Verify build and fix any errors"

The LAST task must ALWAYS be verification (build/lint check). Example plan:
"Plan:
1. Scaffold Next.js project with TypeScript and Tailwind
2. Create layout.tsx with header navigation and footer
3. Create HeroSection component with heading, subtext, and CTA button
4. Create FeaturesSection component with 3 feature cards
5. Create TestimonialsSection component with testimonial cards
6. Create CTASection component with call-to-action
7. Wire all components into page.tsx
8. Add global styles and design tokens
9. Install dependencies (framer-motion, lucide-react)
10. Run build and fix any errors"

STEP 2 — EXECUTE EACH TASK:
After planning, execute tasks ONE BY ONE. For EACH task:
- Say "Task X/N: [description]" before starting it
- Call the necessary tools (write_file, run_shell, etc.) to complete it
- After the tool result comes back, immediately move to the next task
- Do NOT wait for user confirmation. Keep going autonomously until ALL tasks are done.
- NEVER stop in the middle. Complete ALL tasks in your plan.

STEP 3 — PROJECT SETUP (if creating a new project):
Use run_shell to scaffold: e.g., "npx create-next-app@latest my-app --typescript --tailwind --eslint --src-dir --use-npm"
Wait for the result. If it fails, analyze the error and retry.

STEP 4 — WRITE ALL FILES:
Use write_file for EACH file. Provide complete, runnable content. Create files one by one. Each file = one write_file call.

STEP 5 — INSTALL DEPENDENCIES (if needed):
Detect the project type and use the appropriate package manager:
- Node.js/TypeScript: run_shell "cd project && npm install package1 package2"
- Python: run_shell "cd project && pip install package1 package2" or create requirements.txt
- Go: run_shell "cd project && go mod tidy"
- Rust: run_shell "cd project && cargo build"
- Ruby: run_shell "cd project && bundle install"
- Other: use the appropriate package manager for the language

STEP 6 — VERIFY BUILD:
ALWAYS run verification at the end. Detect the project type and run the appropriate check:
- Node.js/TypeScript: run_shell "cd project && npm run build" or "cd project && npx tsc --noEmit"
- Python: run_shell "cd project && python -m py_compile main.py" or "cd project && python -c 'import main'"
- Go: run_shell "cd project && go build ./..."
- Rust: run_shell "cd project && cargo check"
- HTML/CSS/JS (no build): run_shell "ls -la project/" to verify files exist
- If the build fails, READ the error, FIX the files causing errors using edit_file, and run build again
- Repeat until the build passes or you've tried 3 times
- This step is MANDATORY. Never skip it.

STEP 7 — FINAL SUMMARY:
After ALL tasks are done and build passes, give a 1-2 line summary of what you built.

CRITICAL RULES:
- NEVER write code in your response text. ALWAYS use write_file or edit_file tools.
- NEVER tell the user to do something manually. YOU do everything. The user is non-technical — they cannot edit files, run commands, install packages, or configure anything. YOU must do ALL of it using your tools. If something needs to be done, call the appropriate tool yourself.
- NEVER say "you can do X", "you should run X", "add this to your file", "run this command", "create a file called X with this content". Instead, DO IT yourself by calling write_file, edit_file, or run_shell.
- When you want to show the user what a file should contain, call write_file instead of pasting the code.
- Create directories automatically by writing files with path like "src/components/Header.tsx" — write_file creates parent dirs.
- Always provide COMPLETE file content in write_file. Never use comments like "// rest of code here" or "// ...".
- After using run_shell, check the output. If it shows an error, analyze and fix it.
- You cannot cd into a different directory permanently. You operate from ${cwd}. Use "cd subdir && command" for subdirectory commands.
- When creating a new project, organize files in a dedicated project directory.
- Generate beautiful, production-quality, responsive code with proper imports and dependencies.
- Keep going until the task is FULLY complete. Do not stop halfway and ask the user to continue. Finish the entire task autonomously.

====

ERROR HANDLING

When a tool call returns an error:
1. Read the error message carefully.
2. Fix the issue and retry. Examples:
   - Directory not found → run_shell "mkdir -p path/to/dir", then retry.
   - Package not found → run_shell "cd project && npm install package-name".
   - edit_file old_string not found → read_file first, then retry with exact content.
3. If you don't understand the error or don't know how to fix it, use web_search to search for a solution. For example: web_search "next.js error MODULE_NOT_FOUND solution". Then read the results and apply the fix.
4. If web_search gives you a link with a solution, use read_url to fetch the page content and extract the fix.
5. NEVER give up after one error. Always try at least 3 different approaches before reporting failure.
6. NEVER tell the user to fix the error themselves. YOU fix it.

====

COMMUNICATION

- Reply in the same language as the user.
- Keep explanations to 1-2 lines maximum. Let your tool calls do the talking.
- After completing a task, give a one-line summary of what was created/changed.
- Do NOT start messages with "Great", "Sure", "Certainly". Be direct and technical.
- Your goal is to accomplish the task, NOT have a conversation.`;

  if (mcpToolNames && mcpToolNames.length > 0) {
    prompt += `\n\nMCP TOOLS (external services) — PREFER these over builtin tools when relevant:\n${mcpToolNames.map((n) => `- ${n}`).join("\n")}`;
  }

  if (skillContents && skillContents.length > 0) {
    prompt += "\n\n--- ACTIVE SKILLS ---\n\n" + skillContents.join("\n\n---\n\n");
  }

  return prompt;
}

// ── Auto-extract files from model response ──────────────────────────────────────

function isValidFilePath(p: string): boolean {
  if (p.length > 150 || p.length < 3) return false;
  if (p.includes("..") || p.includes(" ") && !p.includes("\\ ")) return false;
  if (!/\.\w{1,10}$/.test(p)) return false;
  if (/^(In |The |Your |This |Here |Note |For |If |When |Add |Create |Update )/i.test(p)) return false;
  return /^[a-zA-Z0-9@._\-/\\]+$/.test(p);
}

function extractFilesFromResponse(content: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  const codeBlockRegex = /```[\w]*\s*(?:(?:\/\/|#|<!--)\s*)?(?:file:\s*)?([^\n`]+\.\w{1,10})\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const filePath = match[1].trim().replace(/^["'`]|["'`]$/g, "");
    const fileContent = match[2].trimEnd();
    if (isValidFilePath(filePath) && fileContent.length > 10 && !seen.has(filePath)) {
      seen.add(filePath);
      files.push({ path: filePath, content: fileContent });
    }
  }

  if (files.length === 0) {
    const headerRegex = /(?:^|\n)(?:#+\s+)?`([a-zA-Z0-9@._\-/\\]+\.\w{1,10})`\s*(?::|\n)\s*```[\w]*\n([\s\S]*?)```/g;
    while ((match = headerRegex.exec(content)) !== null) {
      const filePath = match[1].trim();
      const fileContent = match[2].trimEnd();
      if (isValidFilePath(filePath) && fileContent.length > 10 && !seen.has(filePath)) {
        seen.add(filePath);
        files.push({ path: filePath, content: fileContent });
      }
    }
  }

  return files;
}

// ── File tree (bracket notation) ───────────────────────────────────────────────

function filesToTree(files: string[]): string {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const lastSlash = file.lastIndexOf("/");
    const dir = lastSlash === -1 ? "." : file.slice(0, lastSlash);
    const name = file.slice(lastSlash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(name);
  }

  const lines: string[] = [];

  const groupByExt = (names: string[]): string[] => {
    const extMap = new Map<string, string[]>();
    for (const name of names.sort()) {
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx !== -1 ? name.slice(dotIdx) : "";
      const base = dotIdx !== -1 ? name.slice(0, dotIdx) : name;
      if (!extMap.has(ext)) extMap.set(ext, []);
      extMap.get(ext)!.push(base);
    }
    const parts: string[] = [];
    for (const [ext, bases] of extMap) {
      if (bases.length === 1) {
        parts.push(`${bases[0]}${ext}`);
      } else {
        parts.push(`[${bases.join(",")}]${ext}`);
      }
    }
    return parts;
  };

  const sortedDirs = [...byDir.keys()].sort();
  const indexOnlyChildren = new Map<string, string[]>();
  for (const dir of sortedDirs) {
    const names = byDir.get(dir)!;
    if (names.length === 1 && names[0] === "index.ts") {
      const lastSlash = dir.lastIndexOf("/");
      if (lastSlash !== -1) {
        const parent = dir.slice(0, lastSlash);
        const child = dir.slice(lastSlash + 1);
        if (!indexOnlyChildren.has(parent)) indexOnlyChildren.set(parent, []);
        indexOnlyChildren.get(parent)!.push(child);
      }
    }
  }

  const rendered = new Set<string>();
  for (const dir of sortedDirs) {
    if (rendered.has(dir)) continue;
    const names = byDir.get(dir)!;
    if (names.length === 1 && names[0] === "index.ts") {
      const lastSlash = dir.lastIndexOf("/");
      if (lastSlash !== -1) {
        const parent = dir.slice(0, lastSlash);
        if (indexOnlyChildren.has(parent)) continue;
      }
    }
    const merged = indexOnlyChildren.get(dir);
    if (merged && merged.length > 0) {
      const own = groupByExt(names);
      if (own.length > 0) lines.push(`${dir}/ ${own.join(", ")}`);
      lines.push(`${dir}/[${merged.sort().join(",")}]/index.ts`);
      for (const c of merged) rendered.add(`${dir}/${c}`);
    } else {
      const grouped = groupByExt(names);
      lines.push(dir === "." ? grouped.join(", ") : `${dir}/ ${grouped.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Expand [a,b,c] to get paths. Example: src/[foo,bar].ts = src/foo.ts, src/bar.ts");
  return lines.join("\n");
}

// ── Loop detection ─────────────────────────────────────────────────────────────

function toolSignature(calls: OllamaToolCall[]): string {
  return calls.map((c) => `${c.function.name}:${(c.function.arguments as Record<string, unknown>).path ?? (c.function.arguments as Record<string, unknown>).command ?? (c.function.arguments as Record<string, unknown>).query ?? ""}`).sort().join("|");
}

function detectLoop(state: SessionState, calls: OllamaToolCall[]): boolean {
  const sig = toolSignature(calls);
  state.recentToolSignatures.push(sig);
  if (state.recentToolSignatures.length > 6) state.recentToolSignatures.shift();
  const recent = state.recentToolSignatures;
  if (recent.length < 3) return false;
  const last3 = recent.slice(-3);
  return last3[0] === last3[1] && last3[1] === last3[2];
}

// ── Context size ───────────────────────────────────────────────────────────────

async function fetchModelContextSize(model: string): Promise<number> {
  try {
    const response = await fetch(`${getBaseUrl()}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log("OLLAMA", `api/show HTTP ${response.status} for ${model}, using default 32768`);
      return 32768;
    }
    const data = (await response.json()) as { model_info?: Record<string, unknown>; parameters?: string };
    if (data.model_info) {
      for (const [key, val] of Object.entries(data.model_info)) {
        if (key.endsWith(".context_length") && typeof val === "number" && val > 0) {
          log("OLLAMA", `model ${model} ${key}=${val} (from api/show)`);
          return val;
        }
      }
    }
    const numCtxMatch = data.parameters?.match(/num_ctx\s+(\d+)/);
    if (numCtxMatch) {
      const numCtx = parseInt(numCtxMatch[1]);
      log("OLLAMA", `model ${model} num_ctx=${numCtx} (from parameters)`);
      return numCtx;
    }
    log("OLLAMA", `model ${model} no context_length in api/show, using default 32768`);
  } catch (err) {
    log("OLLAMA", `fetchModelContextSize failed: ${(err as Error).message}, using default 32768`);
  }
  return 32768;
}

function estimateTokens(messages: OllamaMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

function emitContextUsage(getMainWindow: () => BrowserWindow | null, sessionId: string, session: OllamaSession): void {
  const used = estimateTokens(session.messages);
  emit(getMainWindow, sessionId, "context:usage", { used, limit: session.contextSize });
}

// ── Utility functions ──────────────────────────────────────────────────────────

function safePath(cwd: string, relPath: string): string | null {
  const abs = path.resolve(cwd, relPath);
  if (!abs.startsWith(cwd + path.sep) && abs !== cwd) return null;
  return abs;
}

function trimOutput(text: string, max = MAX_SHELL_OUTPUT_BYTES): string {
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

function listFilesGit(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        listFilesWalk(cwd, cwd, 0).then(resolve).catch(() => resolve([]));
        return;
      }
      resolve(stdout.trim().split("\n").filter(Boolean).sort());
    });
  });
}

function listFilesWalk(base: string, dir: string, depth: number): Promise<string[]> {
  if (depth > 5) return Promise.resolve([]);
  return new Promise((resolve) => {
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err) { resolve([]); return; }
      const skip = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".swc", "__pycache__"]);
      const promises: Promise<string[]>[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full);
        if (e.isDirectory()) {
          promises.push(listFilesWalk(base, full, depth + 1));
        } else {
          files.push(rel);
        }
      }
      Promise.all(promises).then((nested) => {
        resolve([...files, ...nested.flat()].sort());
      });
    });
  });
}

function runShell(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: MAX_SHELL_OUTPUT_BYTES }, (err, stdout, stderr) => {
      const exitCode = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout: trimOutput(stdout), stderr: trimOutput(stderr), exitCode });
    });
  });
}

function searchFiles(pattern: string, cwd: string, relPath: string): Promise<string[]> {
  const resolved = path.resolve(cwd, relPath || ".");
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    return Promise.reject(new Error("path outside project"));
  }
  return listFilesGit(cwd).then((rawFiles) => {
    const files = filterFiles(rawFiles, cwd);
    const normalizedBase = relPath === "." ? "" : `${relPath.replace(/\/$/, "")}/`;
    const matches: string[] = [];
    for (const file of files) {
      if (normalizedBase && file !== relPath && !file.startsWith(normalizedBase)) continue;
      const abs = safePath(cwd, file);
      if (!abs) continue;
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_READ_BYTES) continue;
        const content = fs.readFileSync(abs, "utf-8");
        if (content.includes(pattern)) matches.push(file);
      } catch {}
      if (matches.length >= MAX_SEARCH_MATCHES) break;
    }
    return matches;
  });
}

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeToolCall(
  call: OllamaToolCall,
  cwd: string,
  sessionState: SessionState,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<ToolResult> {
  const name = call.function.name;
  const args = call.function.arguments as Record<string, string>;
  const toolId = `ollama-${name}-${crypto.randomUUID().slice(0, 8)}`;

  function emitStart(toolName: string, input: Record<string, unknown>) {
    log("OLLAMA_EVENT", `tool:start ${toolName} id=${toolId} args=${JSON.stringify(input)}`);
    safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type: "tool:start", payload: { toolUseId: toolId, toolName, input }, _seq: 0 });
  }
  function emitResult(toolName: string, result: Record<string, unknown>) {
    log("OLLAMA_EVENT", `tool:result ${toolName} id=${toolId} error=${!!(result as { error?: unknown }).error}`);
    safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type: "tool:result", payload: { toolUseId: toolId, toolName, result }, _seq: 0 });
  }

  sessionState.toolCallCount++;

  switch (name) {
    case "read_file": {
      const rel = args.path ?? "";
      emitStart("Read", { file_path: rel });
      const abs = safePath(cwd, rel);
      if (!abs) {
        emitResult("Read", { error: "path outside project" });
        return { toolName: "Read", input: { file_path: rel }, result: `Error: path outside project`, content: "Error: path outside project" };
      }
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_FILE_READ_BYTES) {
          const msg = `file too large (${stat.size} bytes)`;
          emitResult("Read", { error: msg });
          return { toolName: "Read", input: { file_path: rel }, result: msg, content: msg };
        }
        const content = fs.readFileSync(abs, "utf-8");
        log("OLLAMA_TOOL", `read_file ${rel} (${stat.size} bytes)`);
        if (!sessionState.filesRead.includes(rel)) sessionState.filesRead.push(rel);
        emitResult("Read", { content: content.slice(0, 300) + (content.length > 300 ? "\n..." : "") });
        return { toolName: "Read", input: { file_path: rel }, result: `Read ${rel}: OK (${stat.size} bytes)`, content };
      } catch {
        emitResult("Read", { error: "file not found" });
        return { toolName: "Read", input: { file_path: rel }, result: "file not found", content: "file not found" };
      }
    }

    case "write_file": {
      const rel = args.path ?? "";
      const fileContent = args.content ?? "";
      emitStart("Write", { file_path: rel });
      const abs = safePath(cwd, rel);
      if (!abs) {
        emitResult("Write", { error: "path outside project" });
        return { toolName: "Write", input: { file_path: rel }, result: "path outside project", content: "path outside project" };
      }
      try {
        const dir = path.dirname(abs);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(abs, fileContent, "utf-8");
        log("OLLAMA_TOOL", `write_file ${rel} (${fileContent.length} chars)`);
        if (!sessionState.filesCreated.includes(rel)) sessionState.filesCreated.push(rel);
        emitResult("Write", { status: "ok", bytesWritten: fileContent.length });
        return { toolName: "Write", input: { file_path: rel }, result: `Write ${rel}: OK (${fileContent.length} bytes)`, content: `File written: ${rel}` };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("Write", { error: msg });
        return { toolName: "Write", input: { file_path: rel }, result: msg, content: msg };
      }
    }

    case "edit_file": {
      const rel = args.path ?? "";
      const oldStr = args.old_string ?? "";
      const newStr = args.new_string ?? "";
      const abs = safePath(cwd, rel);
      if (!abs) {
        emitStart("Edit", { file_path: rel });
        emitResult("Edit", { error: "path outside project" });
        return { toolName: "Edit", input: { file_path: rel }, result: "path outside project", content: "path outside project" };
      }
      try {
        let fileContent = fs.readFileSync(abs, "utf-8");
        if (fileContent.includes(oldStr)) {
          fileContent = fileContent.replace(oldStr, newStr);
          fs.writeFileSync(abs, fileContent, "utf-8");
          emitStart("Edit", { file_path: rel, old_string: oldStr, new_string: newStr });
          log("OLLAMA_TOOL", `edit_file ${rel} (1 replacement)`);
          if (!sessionState.filesModified.includes(rel)) sessionState.filesModified.push(rel);
          emitResult("Edit", { status: "ok", replacements: 1, oldString: oldStr, newString: newStr, filePath: rel });
          return { toolName: "Edit", input: { file_path: rel }, result: `Edit ${rel}: OK (1 replacement)`, content: `File edited: ${rel}` };
        } else {
          emitStart("Edit", { file_path: rel });
          emitResult("Edit", { error: "old_string not found in file — read the file first to get exact content" });
          return { toolName: "Edit", input: { file_path: rel }, result: "old_string not found — read_file first", content: "old_string not found in file" };
        }
      } catch (err) {
        emitStart("Edit", { file_path: rel });
        const msg = (err as Error).message;
        emitResult("Edit", { error: msg });
        return { toolName: "Edit", input: { file_path: rel }, result: msg, content: msg };
      }
    }

    case "delete_file": {
      const rel = args.path ?? "";
      emitStart("Delete", { file_path: rel });
      const abs = safePath(cwd, rel);
      if (!abs) {
        emitResult("Delete", { error: "path outside project" });
        return { toolName: "Delete", input: { file_path: rel }, result: "path outside project", content: "path outside project" };
      }
      try {
        fs.unlinkSync(abs);
        log("OLLAMA_TOOL", `delete_file ${rel}`);
        emitResult("Delete", { status: "ok" });
        return { toolName: "Delete", input: { file_path: rel }, result: `Delete ${rel}: OK`, content: `File deleted: ${rel}` };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("Delete", { error: msg });
        return { toolName: "Delete", input: { file_path: rel }, result: msg, content: msg };
      }
    }

    case "list_files": {
      const rel = args.path || ".";
      emitStart("Glob", { path: rel });
      try {
        const rawFiles = await listFilesGit(cwd);
        const normalizedBase = rel === "." ? "" : `${rel.replace(/\/$/, "")}/`;
        const allFiltered = filterFiles(rawFiles, cwd)
          .filter((file) => !normalizedBase || file === rel || file.startsWith(normalizedBase));

        let content: string;
        if (allFiltered.length > TREE_COLLAPSE_THRESHOLD) {
          content = filesToTree(allFiltered);
        } else {
          content = allFiltered.join("\n");
        }

        if (allFiltered.length > PAGE_SIZE) {
          sessionState.pendingPages.set(`list:${rel}`, allFiltered.slice(PAGE_SIZE));
        }

        emitResult("Glob", { filenames: allFiltered.slice(0, PAGE_SIZE), numFiles: allFiltered.length, mode: "files_with_matches" });
        return { toolName: "Glob", input: { path: rel }, result: `List ${rel}: ${allFiltered.length} files`, content };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("Glob", { error: msg });
        return { toolName: "Glob", input: { path: rel }, result: msg, content: msg };
      }
    }

    case "search_files": {
      const pattern = args.pattern ?? "";
      const rel = args.path || ".";
      emitStart("Grep", { pattern, path: rel });
      try {
        const matches = await searchFiles(pattern, cwd, rel);
        const content = matches.length > 0 ? matches.join("\n") : "No matches found.";
        emitResult("Grep", { filenames: matches, numFiles: matches.length, mode: "files_with_matches" });
        return { toolName: "Grep", input: { pattern, path: rel }, result: `Search "${pattern}": ${matches.length} matches`, content };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("Grep", { error: msg });
        return { toolName: "Grep", input: { pattern, path: rel }, result: msg, content: msg };
      }
    }

    case "web_search": {
      const query = args.query ?? "";
      emitStart("WebSearch", { query });
      try {
        const searchResult = await webSearch(query);
        const formatted = formatWebResults(searchResult);
        log("OLLAMA_TOOL", `web_search "${query}" (${searchResult.results.length} results)`);
        emitResult("WebSearch", { query, abstract: searchResult.abstract, abstractUrl: searchResult.abstractUrl, results: searchResult.results });
        return { toolName: "WebSearch", input: { query }, result: `Web search: ${searchResult.results.length} results`, content: formatted };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("WebSearch", { error: msg });
        return { toolName: "WebSearch", input: { query }, result: msg, content: `Web search failed: ${msg}` };
      }
    }

    case "read_url": {
      const targetUrl = args.url ?? "";
      emitStart("WebFetch", { url: targetUrl });
      try {
        const crawlResult = await crawlUrl(targetUrl);
        const truncated = crawlResult.content.length > 50000
          ? crawlResult.content.slice(0, 50000) + "\n\n... (truncated, content too long)"
          : crawlResult.content;
        log("OLLAMA_TOOL", `read_url "${targetUrl}" (${crawlResult.content.length} chars, provider=${crawlResult.provider})`);
        emitResult("WebFetch", { url: targetUrl, title: crawlResult.title, contentLength: crawlResult.content.length, provider: crawlResult.provider });
        return { toolName: "WebFetch", input: { url: targetUrl }, result: `Read URL: ${crawlResult.title} (${crawlResult.content.length} chars)`, content: truncated };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("WebFetch", { error: msg });
        return { toolName: "WebFetch", input: { url: targetUrl }, result: msg, content: `Failed to read URL: ${msg}` };
      }
    }

    case "run_shell": {
      const command = args.command ?? "";
      emitStart("Bash", { command });
      const shellResult = await runShell(command, cwd);
      const output = [shellResult.stdout, shellResult.stderr].filter(Boolean).join("\n");
      emitResult("Bash", { stdout: shellResult.stdout, stderr: shellResult.stderr, exitCode: shellResult.exitCode, output });
      return { toolName: "Bash", input: { command }, result: `exit ${shellResult.exitCode}`, content: output || "(no output)" };
    }

    default: {
      return { toolName: name, input: args, result: `Unknown tool: ${name}`, content: `Unknown tool: ${name}` };
    }
  }
}

async function executeMcpToolCall(
  call: OllamaToolCall,
  session: OllamaSession,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<ToolResult> {
  const name = call.function.name;
  const args = call.function.arguments as Record<string, unknown>;
  const toolId = `ollama-mcp-${crypto.randomUUID().slice(0, 8)}`;
  const mapping = session.mcpBridge?.toolMap.get(name);
  const displayName = mapping ? `mcp__${mapping.serverName}__${mapping.originalName}` : name;

  safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type: "tool:start", payload: { toolUseId: toolId, toolName: displayName, input: args }, _seq: 0 });

  try {
    const result = await executeMcpTool(session.mcpBridge!, name, args);
    safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type: "tool:result", payload: { toolUseId: toolId, toolName: displayName, result: { content: result.slice(0, 500) + (result.length > 500 ? "\n..." : "") } }, _seq: 0 });
    return { toolName: displayName, input: args as Record<string, string>, result: `${displayName}: OK`, content: result };
  } catch (err) {
    const msg = (err as Error).message;
    safeSend(getMainWindow, "ollama:event", { _sessionId: sessionId, type: "tool:result", payload: { toolUseId: toolId, toolName: displayName, result: { error: msg } }, _seq: 0 });
    return { toolName: displayName, input: args as Record<string, string>, result: msg, content: `Error: ${msg}` };
  }
}

// ── Native streaming ───────────────────────────────────────────────────────────

interface StreamResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  promptTokens: number;
  completionTokens: number;
}

async function streamOllamaChatNoTools(
  session: OllamaSession,
  controller: AbortController,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<{ content: string }> {
  const compressed = compressConversation(session.messages as Array<{ role: string; content: string; images?: string[] }>);
  const response = await fetch(`${getBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: session.model,
      messages: compressed,
      stream: true,
      options: { temperature: 0.3 },
    }),
    signal: controller.signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(errText);
  }
  if (!response.body) throw new Error("No response body");
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          const visible = fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
          if (visible) emit(getMainWindow, sessionId, "chat:delta", { text: visible });
        }
      } catch {}
    }
  }
  return { content: fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "").trim() };
}

async function streamOllamaChat(
  session: OllamaSession,
  controller: AbortController,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<StreamResult> {
  const allTools = [...OLLAMA_TOOLS, ...session.mcpTools];
  const compressed = compressConversation(session.messages as Array<{ role: string; content: string; images?: string[] }>);
  const supportsThinking = (session as OllamaSession & { supportsThinking?: boolean }).supportsThinking !== false;
  log("OLLAMA", `api/chat: model=${session.model} messages=${session.messages.length} tools=${allTools.length} (builtin=${OLLAMA_TOOLS.length} mcp=${session.mcpTools.length}) think=${supportsThinking}`);

  const buildBody = (think: boolean) => JSON.stringify({
    model: session.model,
    messages: compressed,
    tools: allTools,
    ...(think ? { think: true } : {}),
    stream: true,
    options: { temperature: 0.2 },
  });

  let response = await fetch(`${getBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildBody(supportsThinking),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => `HTTP ${response.status}`);
    if (supportsThinking && errText.includes("does not support thinking")) {
      log("OLLAMA", `model does not support thinking — retrying without`);
      (session as OllamaSession & { supportsThinking?: boolean }).supportsThinking = false;
      response = await fetch(`${getBaseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildBody(false),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryErr = await response.text().catch(() => `HTTP ${response.status}`);
        throw new Error(retryErr);
      }
    } else {
      throw new Error(errText);
    }
  }
  if (!response.body) throw new Error("No response body from Ollama");

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  let fullThinking = "";
  let buffer = "";
  let toolCalls: OllamaToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          message?: { role?: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };

        if (parsed.message?.thinking) {
          fullThinking += parsed.message.thinking;
          emit(getMainWindow, sessionId, "chat:thinking", { text: fullThinking });
        }

        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          const visible = fullContent
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .replace(/<think>[\s\S]*$/, "")
            .trim();
          if (visible) {
            emit(getMainWindow, sessionId, "chat:delta", { text: visible });
          }
        }

        if (parsed.message?.tool_calls) {
          toolCalls = parsed.message.tool_calls;
        }

        if (parsed.done) {
          promptTokens = parsed.prompt_eval_count ?? 0;
          completionTokens = parsed.eval_count ?? 0;
          if (promptTokens > 0) {
            emit(getMainWindow, sessionId, "context:usage", {
              used: promptTokens + completionTokens,
              limit: session.contextSize,
              promptTokens,
              completionTokens,
            });
          }
        }
      } catch {}
    }
  }

  const cleanContent = fullContent
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();

  if (toolCalls.length === 0) {
    const parsedFromText = parseToolCallsFromText(cleanContent);
    if (parsedFromText.length > 0) {
      log("OLLAMA", `parsed ${parsedFromText.length} tool call(s) from text output (model didn't use native function calling)`);
      toolCalls = parsedFromText;
    }
  }

  return { content: cleanContent, thinking: fullThinking, toolCalls, promptTokens, completionTokens };
}

function parseToolCallsFromText(text: string): OllamaToolCall[] {
  const calls: OllamaToolCall[] = [];

  const patterns = [
    /(\w+)\[ARGS\]\s*(\{[\s\S]*?\})/g,
    /\[TOOL_CALLS\]\s*\[?([\s\S]*?)\]?\s*(?:<\/s>|$)/g,
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      try {
        if (pattern === patterns[0]) {
          const name = match[1];
          const args = JSON.parse(match[2]);
          calls.push({ function: { name, arguments: args } });
        } else if (pattern === patterns[1]) {
          const raw = match[1].trim();
          const items = raw.startsWith("[") ? JSON.parse(raw) : JSON.parse(`[${raw}]`);
          for (const item of Array.isArray(items) ? items : [items]) {
            if (item.name && item.arguments) {
              calls.push({ function: { name: item.name, arguments: item.arguments } });
            }
          }
        } else {
          const obj = JSON.parse(match[1]);
          if (obj.name && obj.arguments) {
            calls.push({ function: { name: obj.name, arguments: obj.arguments } });
          }
        }
      } catch {}
    }
    if (calls.length > 0) break;
  }

  return calls;
}

// ── IPC registration ───────────────────────────────────────────────────────────

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("ollama:start", async (_event, { cwd, model, projectId, activeSkills }: { cwd: string; model?: string; projectId?: string; activeSkills?: string[] }) => {
    const sessionId = crypto.randomUUID();
    const sessionModel = model || getDefaultModel();
    const contextSize = await fetchModelContextSize(sessionModel);

    let mcpBridge: McpBridgeState | null = null;
    let mcpTools: OllamaSession["mcpTools"] = [];

    if (projectId) {
      try {
        const result = await getMcpToolsForOllama(projectId);
        mcpBridge = result.state;
        mcpTools = result.tools;
        if (mcpTools.length > 0) {
          log("OLLAMA", `session ${sessionId}: ${mcpTools.length} MCP tool(s) loaded`);
        }
      } catch (err) {
        log("OLLAMA", `MCP init failed (continuing without): ${(err as Error).message}`);
      }
    }

    let skillContents: string[] = [];
    if (activeSkills && activeSkills.length > 0) {
      const skillsDir = path.join(cwd, ".harnss", "skills");
      for (const id of activeSkills) {
        const filePath = path.join(skillsDir, `${id}.md`);
        try {
          if (fs.existsSync(filePath)) {
            skillContents.push(fs.readFileSync(filePath, "utf-8"));
            log("OLLAMA", `skill loaded: ${id}`);
          }
        } catch {}
      }
      if (skillContents.length > 0) {
        log("OLLAMA", `${skillContents.length} skill(s) injected into system prompt`);
      }
    }

    const mcpToolNames = mcpTools.map((t) => `${t.function.name}: ${t.function.description}`);

    sessions.set(sessionId, {
      messages: [{ role: "system", content: buildSystemPrompt(cwd, skillContents, mcpToolNames) }],
      cwd,
      model: sessionModel,
      contextSize,
      abortController: null,
      state: freshState(),
      mcpBridge,
      mcpTools,
    });

    triggerIndex(cwd);

    return { sessionId, model: sessionModel };
  });

  ipcMain.handle("ollama:send", async (_event, { sessionId, text, cwd, model, images, activeSkills }: { sessionId: string; text: string; cwd?: string; model?: string; images?: string[]; activeSkills?: string[] }) => {
    let session = sessions.get(sessionId);
    if (!session && cwd) {
      const sessionModel = model || getDefaultModel();
      session = {
        messages: [{ role: "system", content: buildSystemPrompt(cwd) }],
        cwd,
        model: sessionModel,
        contextSize: await fetchModelContextSize(sessionModel),
        abortController: null,
        state: freshState(),
        mcpBridge: null,
        mcpTools: [],
      };
      sessions.set(sessionId, session);
      triggerIndex(cwd);
      log("OLLAMA", `auto-revived session ${sessionId} (cwd=${cwd}, model=${sessionModel})`);
    }
    if (!session) return { error: "Session expired — please start a new chat" };

    if (activeSkills && activeSkills.length > 0 && session.cwd) {
      const skillContents: string[] = [];
      const skillsDir = path.join(session.cwd, ".harnss", "skills");
      for (const id of activeSkills) {
        const filePath = path.join(skillsDir, `${id}.md`);
        try {
          if (fs.existsSync(filePath)) {
            skillContents.push(fs.readFileSync(filePath, "utf-8"));
          }
        } catch {}
      }
      if (skillContents.length > 0) {
        const mcpToolNames = session.mcpTools.map((t) => `${t.function.name}: ${t.function.description}`);
        session.messages[0] = { role: "system", content: buildSystemPrompt(session.cwd, skillContents, mcpToolNames) };
        log("OLLAMA", `${skillContents.length} skill(s) hot-reloaded into system prompt`);
      }
    }

    session.state.originalRequest = text;

    if (images?.length) {
      log("OLLAMA", `sending ${images.length} image(s) (${images.map(i => `${Math.round(i.length / 1024)}KB`).join(", ")})`);
    }

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
          session.messages.push({ role: "user", content: text, ...(images?.length ? { images } : {}) });
          session.messages.push({
            role: "user",
            content: `Web search results for "${searchQuery}":\n\n${formatted}\n\nUsing ONLY the information above, answer the user's question. If the results are insufficient, say so.`,
          });
        } catch (searchErr) {
          log("OLLAMA_WEB", `search failed: ${(searchErr as Error).message}`);
          emit(getMainWindow, sessionId, "tool:result", {
            toolUseId: searchId, toolName: "WebSearch",
            result: { error: (searchErr as Error).message },
          });
          session.messages.push({ role: "user", content: text, ...(images?.length ? { images } : {}) });
        }
      } else {
        session.messages.push({ role: "user", content: text, ...(images?.length ? { images } : {}) });
      }
    } catch (err) {
      log("RAG", `failed, using plain message: ${(err as Error).message}`);
      session.messages.push({ role: "user", content: text, ...(images?.length ? { images } : {}) });
    }

    const controller = new AbortController();
    session.abortController = controller;

    emit(getMainWindow, sessionId, "lifecycle:start", {});
    emitContextUsage(getMainWindow, sessionId, session);

    try {
      const isFirstMessage = session.messages.filter(m => m.role === "user").length === 1;
      if (isFirstMessage && text.length > 20) {
        log("OLLAMA", "planning turn — no tools, forcing task breakdown");
        const planResult = await streamOllamaChatNoTools(session, controller, getMainWindow, sessionId);
        if (planResult.content) {
          session.messages.push({ role: "assistant", content: planResult.content });

          const taskLines = planResult.content.split("\n")
            .filter(l => /^\d+\.\s/.test(l.trim()))
            .map(l => l.trim().replace(/^\d+\.\s*/, ""));
          if (taskLines.length > 0) {
            emit(getMainWindow, sessionId, "task:plan", { tasks: taskLines });
            log("OLLAMA", `plan: ${taskLines.length} tasks extracted`);
          }

          emit(getMainWindow, sessionId, "chat:mid-final", { message: planResult.content });
          session.messages.push({
            role: "user",
            content: `Good plan. Now execute it. Follow these rules strictly:
1. Start with task 1 and work through ALL tasks in order
2. For EACH task, call the appropriate tool (write_file, run_shell, edit_file)
3. Do NOT describe code — call write_file with the full content
4. After ALL tasks are done, run the build/verify step
5. If the build shows errors, READ the error output carefully, FIX the files with edit_file, and run build AGAIN
6. Keep fixing and rebuilding until there are ZERO errors
7. Only give your final summary after the build passes with no errors`,
          });
        }
      }

      let loopCount = 0;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;

        const streamResult = await streamOllamaChat(session, controller, getMainWindow, sessionId);

        if (streamResult.toolCalls.length === 0) {
          const extractedFiles = extractFilesFromResponse(streamResult.content);
          if (extractedFiles.length > 0) {
            log("OLLAMA", `model did not use tools — auto-extracting ${extractedFiles.length} file(s) from response`);
            for (const file of extractedFiles) {
              const toolId = `ollama-auto-${crypto.randomUUID().slice(0, 8)}`;
              const absPath = path.resolve(session.cwd, file.path);
              if (!absPath.startsWith(path.resolve(session.cwd))) continue;
              emit(getMainWindow, sessionId, "tool:start", {
                toolUseId: toolId, toolName: "Write", input: { file_path: file.path },
              });
              try {
                fs.mkdirSync(path.dirname(absPath), { recursive: true });
                fs.writeFileSync(absPath, file.content, "utf-8");
                emit(getMainWindow, sessionId, "tool:result", {
                  toolUseId: toolId, toolName: "Write",
                  result: `Created ${file.path}`, content: `Created ${file.path} (${file.content.length} bytes)`,
                });
                log("OLLAMA", `auto-created: ${file.path} (${file.content.length} bytes)`);
              } catch (err) {
                emit(getMainWindow, sessionId, "tool:result", {
                  toolUseId: toolId, toolName: "Write",
                  result: `Error: ${(err as Error).message}`, content: `Error: ${(err as Error).message}`,
                });
              }
            }
            session.messages.push({ role: "assistant", content: streamResult.content });
            emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
            break;
          }
          session.messages.push({ role: "assistant", content: streamResult.content });
          emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
          break;
        }

        session.messages.push({
          role: "assistant",
          content: streamResult.content,
          tool_calls: streamResult.toolCalls,
        });

        if (streamResult.content) {
          emit(getMainWindow, sessionId, "chat:mid-final", { message: streamResult.content });
        } else {
          emit(getMainWindow, sessionId, "chat:clear-streaming", {});
        }

        let ops = 0;
        for (const call of streamResult.toolCalls) {
          if (ops >= MAX_TOOL_OPS) break;
          ops++;
          const isMcp = call.function.name.startsWith("mcp_") && session.mcpBridge?.toolMap.has(call.function.name);
          const result = isMcp
            ? await executeMcpToolCall(call, session, getMainWindow, sessionId)
            : await executeToolCall(call, session.cwd, session.state, getMainWindow, sessionId);
          session.messages.push({ role: "tool", content: result.content });
        }

        const isLoop = detectLoop(session.state, streamResult.toolCalls);
        if (isLoop) {
          log("OLLAMA", `repetitive loop detected at iteration ${loopCount} — asking model to reconsider`);
          session.messages.push({
            role: "user",
            content: "STOP — you are repeating the same command. It is not working. Try a COMPLETELY DIFFERENT approach. For example: if npx create-next-app keeps failing, create the project manually using mkdir and write_file instead. If a build keeps failing on the same error, search the web for a solution. Move on to the next task in your plan.",
          });
        }

        emit(getMainWindow, sessionId, "lifecycle:start", {});
        emitContextUsage(getMainWindow, sessionId, session);
      }

      if (loopCount >= MAX_TOOL_LOOPS) {
        log("OLLAMA", `hard limit reached (${MAX_TOOL_LOOPS})`);
        const lastAssistant = session.messages.filter((m) => m.role === "assistant").pop()?.content ?? "";
        emit(getMainWindow, sessionId, "chat:final", { message: lastAssistant });
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
      if (session.mcpBridge) disconnectMcpBridge(session.mcpBridge);
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
