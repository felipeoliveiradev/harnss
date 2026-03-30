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
import { multiAiSearch } from "../lib/multi-ai-search";
import { saveMessage, saveSessionMeta, updateSessionSummary, searchProjectMessages, getSessionMessages } from "../lib/conversation-db";

let ollamaClient: any = null;
let ollamaClientHost: string = "";
let ollamaCloudClient: any = null;

async function getOllamaClient(forceCloud = false, hostOverride?: string): Promise<any> {
  if (forceCloud) {
    if (!ollamaCloudClient) {
      const { Ollama } = await import("ollama");
      const apiKey = getAppSetting("ollamaApiKey") || "";
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      ollamaCloudClient = new Ollama({ host: "https://ollama.com", ...(apiKey ? { headers } : {}) });
      log("OLLAMA", `cloud client created: host=https://ollama.com auth=${!!apiKey}`);
    }
    return ollamaCloudClient;
  }
  if (hostOverride) {
    const { Ollama } = await import("ollama");
    const apiKey = getAppSetting("ollamaApiKey") || "";
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return new Ollama({ host: hostOverride.replace(/\/$/, ""), ...(apiKey ? { headers } : {}) });
  }
  const host = getBaseUrl();
  if (!ollamaClient || ollamaClientHost !== host) {
    const { Ollama } = await import("ollama");
    const apiKey = getAppSetting("ollamaApiKey") || "";
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    ollamaClient = new Ollama({ host, ...(apiKey ? { headers } : {}) });
    ollamaClientHost = host;
    log("OLLAMA", `client created: host=${host} auth=${!!apiKey}`);
  }
  return ollamaClient;
}

function isCloudModel(model: string): boolean {
  return model.endsWith(":cloud");
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
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
  progressSummary: string;
  lastSummaryAtLoop: number;
}

interface OllamaSession {
  messages: OllamaMessage[];
  cwd: string;
  model: string;
  host?: string;
  contextSize: number;
  abortController: AbortController | null;
  state: SessionState;
  mcpBridge: McpBridgeState | null;
  mcpTools: Array<{ type: "function"; function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } } }>;
  pendingUserResponse: { resolve: (text: string) => void } | null;
  supportsTools: boolean;
  supportsThinking: boolean;
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
  return { filesRead: [], filesModified: [], filesCreated: [], originalRequest: "", toolCallCount: 0, recentToolSignatures: [], pendingPages: new Map(), progressSummary: "", lastSummaryAtLoop: 0 };
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
  {
    type: "function" as const,
    function: {
      name: "ask_user",
      description: "Ask the user a question and wait for their response. Use this to clarify requirements, preferences, or get decisions before proceeding. Examples: 'Should I use dark or light theme?', 'Which database do you prefer: PostgreSQL or MongoDB?', 'Do you want authentication included?'",
      parameters: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string", description: "The question to ask the user" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recall_conversation",
      description: "Search your conversation history for this project. Use this when you need to remember what was discussed, what files were created, or what the user asked in previous sessions. Also useful to check what you already did in this session.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search term to find in conversation history (e.g. 'landing page', 'package.json', 'dark theme')" },
          sessionId: { type: "string", description: "Specific session ID to search (omit to search all sessions in this project)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_multiple_ais",
      description: "Query multiple AI models (Claude, GPT-4, Gemini, Llama) with the same question and get their different perspectives. Use for research, cross-validation, or getting diverse opinions on technical decisions.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The research question to ask all models" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_search",
      description: "Search GitHub repositories for starter templates, boilerplates, and open-source projects.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query" },
          language: { type: "string", description: "Filter by language" },
          sort: { type: "string", description: "Sort by: stars, forks, updated" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_clone",
      description: "Clone a GitHub repository. IMPORTANT: Before cloning, ALWAYS verify the repo exists by calling read_url on its GitHub URL first. Use clone URLs from github_search results — do NOT invent URLs.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "GitHub repo URL (e.g. https://github.com/user/repo). Use the html_url or clone_url from github_search results." },
          destination: { type: "string", description: "Folder name to clone into (default: repo name). Use a simple name like 'my-project', NOT an absolute path." },
          depth: { type: "number", description: "Shallow clone depth (1 for latest only)" },
        },
      },
    },
  },
];

function buildSystemPrompt(cwd: string, skillContents?: string[], mcpToolNames?: string[]): string {
  let prompt = `You are a coding agent. You operate inside a desktop IDE called Harnss.
Working directory: ${cwd}

# MANDATORY WORKFLOW — YOU MUST FOLLOW THIS EXACT ORDER

VIOLATION OF THIS ORDER IS FORBIDDEN. Each step MUST be completed before moving to the next.

## PHASE 1: RESEARCH (you are here when you receive the first message)

THINK BEFORE SEARCHING. Follow this exact process:

0. Call recall_conversation to check what was already discussed or done in this project
1. Call web_search ONCE with a focused query about the main topic
2. READ the results. Decide: do you have enough info? If yes → Phase 2. If no → one more search.
3. Maximum 3 searches total. After each search, STOP and THINK about what you learned.
4. Call github_search ONCE to find a good starter template (if building a new project)
5. If you found a good template, call read_url on its GitHub page to check the README

RULES:
- Call ONE tool at a time. Wait for the result. Think. Then decide next action.
- Do NOT call multiple web_search in the same turn.
- Do NOT search for the same thing twice with different words.
- After 2-3 searches you have enough info. Move on.
- Do NOT write code yet. Do NOT create files yet.

## PHASE 2: ASK THE USER

After research, call ask_user to clarify preferences:
- Design choices (dark/light theme, layout, sections)
- Technology preferences (if multiple valid options exist)
- Scope (what features to include/exclude)

Ask ONE question at a time. Wait for the answer.
Do NOT ask technical questions — solve those with research.
For simple tasks (bug fix, small edit), skip this phase.

## PHASE 3: PLAN

Only AFTER research and user clarification, write your plan:
- List the complete file tree
- Number each task
- Include dependency installation and build verification

## PHASE 4: EXECUTE

PRIORITY ORDER for creating new projects:
1. USE THE OFFICIAL CLI — research the exact non-interactive flags first (--yes, -y, --default, CI=true). Run it. If it hangs or fails, move to option 2.
2. CLONE A STARTER — github_search to find a well-maintained starter with high stars. BEFORE cloning: call read_url on the repo URL to verify it exists and check its README. Only use URLs returned by github_search — NEVER invent a URL. Then github_clone with just the folder name as destination (e.g. "my-project"), NOT an absolute path.
3. MANUAL CREATION — write_file for each config file + source file. Last resort only.

Now you may call write_file, edit_file, run_shell, github_clone.
Execute tasks one by one. Write COMPLETE file contents. Never truncate.
After all files: install dependencies, run build, fix errors until build passes.

## PHASE 5: VERIFY & CONCLUDE (MANDATORY — never skip)

After writing all files, you MUST verify the project works:

1. IDENTIFY the project: read_file on package.json (or equivalent) to find the tech stack and scripts
2. INSTALL dependencies: run_shell "cd PROJECT && npm install" (or pnpm/yarn)
3. RUN BUILD: run_shell "cd PROJECT && npm run build" (or the appropriate build/compile/typecheck command)
4. If build FAILS: read the errors, fix with edit_file, rebuild. Repeat until it passes.
5. If build PASSES: give a SHORT summary (2-3 lines):
   - What was created (e.g. "Next.js portfolio landing page with 6 sections")
   - Where it lives (e.g. "Project is in ./portfolio")
   - How to run it (e.g. "cd portfolio && npm run dev")
6. Call ask_user with 4-5 improvement suggestions. Example:
   ask_user "The landing page is ready and builds successfully! Here are some improvements we could add:\n1. Dark/light theme toggle\n2. Contact form with email integration\n3. Blog section with MDX\n4. SEO optimization with meta tags\n5. Animation with Framer Motion\n\nWhich would you like me to add? Or describe something else."

NEVER end without verifying the build passes. NEVER end silently.

# RULES

- You can ONLY affect the project through tool calls. Code in your text response does NOTHING.
- write_file auto-creates directories. Always provide COMPLETE content.
- edit_file requires read_file first. old_string must match EXACTLY.
- run_shell is NON-INTERACTIVE. No stdin. Use --yes/-y flags. If a command hangs, switch to manual file creation.
- Reply in the user's language. Keep text to 1-2 lines. Let tools do the work.
- NEVER tell the user to do something manually. YOU do everything.
- NEVER give up on errors. Search the web, try different approaches.`;

  if (mcpToolNames && mcpToolNames.length > 0) {
    prompt += `\n\n# MCP TOOLS (external services)\n${mcpToolNames.map((n) => `- ${n}`).join("\n")}`;
  }

  if (skillContents && skillContents.length > 0) {
    prompt += "\n\n# ACTIVE SKILLS\n\n" + skillContents.join("\n\n---\n\n");
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

interface ModelCapabilities {
  contextSize: number;
  supportsTools: boolean;
  supportsThinking: boolean;
}

async function fetchModelCapabilities(model: string, host?: string): Promise<ModelCapabilities> {
  try {
    const client = await getOllamaClient(isCloudModel(model), isCloudModel(model) ? undefined : host);
    const data = await client.show({ model });

    let contextSize = 32768;
    if (data.model_info) {
      for (const [key, val] of Object.entries(data.model_info)) {
        if (key.endsWith(".context_length") && typeof val === "number" && val > 0) {
          contextSize = val;
          break;
        }
      }
    }
    if (contextSize === 32768) {
      const numCtxMatch = data.parameters?.match(/num_ctx\s+(\d+)/);
      if (numCtxMatch) contextSize = parseInt(numCtxMatch[1]);
    }

    const caps: string[] = Array.isArray(data.capabilities) ? data.capabilities : [];
    const supportsTools = caps.includes("tools");
    const supportsThinking = caps.includes("thinking");

    log("OLLAMA", `model ${model}: ctx=${contextSize} tools=${supportsTools} thinking=${supportsThinking} caps=[${caps.join(",")}]`);
    return { contextSize, supportsTools, supportsThinking };
  } catch (err) {
    log("OLLAMA", `fetchModelCapabilities failed: ${(err as Error).message}, using defaults`);
    return { contextSize: 32768, supportsTools: true, supportsThinking: false };
  }
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

function runShell(command: string, cwd: string, timeoutMs = SHELL_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_SHELL_OUTPUT_BYTES }, (err, stdout, stderr) => {
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
      const rel = args.path ?? args.url ?? "";
      if (/^https?:\/\//i.test(rel)) {
        log("OLLAMA_TOOL", `read_file got URL "${rel}" — redirecting to read_url`);
        return executeToolCall({ function: { name: "read_url", arguments: { url: rel } } }, cwd, sessionState, getMainWindow, sessionId);
      }
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
      let rel = args.path || ".";
      if (path.isAbsolute(rel)) {
        const resolved = path.resolve(rel);
        rel = resolved.startsWith(cwd) ? path.relative(cwd, resolved) || "." : ".";
      }
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
      let rel = args.path || ".";
      if (path.isAbsolute(rel)) {
        const resolved = path.resolve(rel);
        rel = resolved.startsWith(cwd) ? path.relative(cwd, resolved) || "." : ".";
      }
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
        return { toolName: "WebSearch", input: { query }, result: `Web search: ${searchResult.results.length} results`, content: trimOutput(formatted, 3000) };
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
        const truncated = crawlResult.content.length > 3000
          ? crawlResult.content.slice(0, 3000) + "\n\n... (truncated)"
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

    case "ask_multiple_ais": {
      const query = args.query ?? "";
      emitStart("MultiAiSearch", { query });
      try {
        const openRouterApiKey = getAppSetting("openRouterApiKey") || "";
        const moltbookApiKey = getAppSetting("moltbookApiKey") || "";
        const searchResult = await multiAiSearch({ query, openRouterApiKey, moltbookApiKey });
        const results = (searchResult as { results: Array<{ model: string; response: string; error?: string }> }).results ?? [];
        const formatted = results
          .map((r: { model: string; response: string; error?: string }) =>
            r.error
              ? `### ${r.model}\nError: ${r.error}`
              : `### ${r.model}\n${r.response}`,
          )
          .join("\n\n---\n\n");
        log("OLLAMA_TOOL", `ask_multiple_ais "${query}" (${results.length} models)`);
        emitResult("MultiAiSearch", { query, modelCount: results.length, results });
        return { toolName: "MultiAiSearch", input: { query }, result: `Multi-AI search: ${results.length} models responded`, content: formatted || "No results" };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("MultiAiSearch", { error: msg });
        return { toolName: "MultiAiSearch", input: { query }, result: msg, content: `Multi-AI search failed: ${msg}` };
      }
    }

    case "github_search": {
      const query = args.query ?? "";
      const language = args.language as string | undefined;
      const sort = args.sort as string | undefined;
      emitStart("GitHubSearch", { query, language, sort });
      try {
        const https = await import("https");
        const data = await new Promise<{ total_count: number; items: Array<{ full_name: string; description: string | null; html_url: string; stargazers_count: number; language: string | null; clone_url: string }> }>((resolve, reject) => {
          let q = encodeURIComponent(query);
          if (language) q += `+language:${encodeURIComponent(language)}`;
          const apiPath = `/search/repositories?q=${q}&sort=${sort || "stars"}&per_page=10`;
          const options: Record<string, unknown> = {
            hostname: "api.github.com",
            path: apiPath,
            method: "GET",
            headers: { "User-Agent": "Harnss-Desktop", Accept: "application/vnd.github.v3+json" },
          };
          const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
          if (ghToken) (options.headers as Record<string, string>)["Authorization"] = `Bearer ${ghToken}`;
          const req = https.default.request(options as https.RequestOptions, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => { body += chunk; });
            res.on("end", () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
              } else { reject(new Error(`GitHub API ${res.statusCode}`)); }
            });
          });
          req.on("error", reject);
          req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
          req.end();
        });
        const formatted = data.items
          .map((r) => `${r.full_name} (${r.stargazers_count} stars) — ${r.description || "No description"}\n  ${r.html_url}\n  Clone: ${r.clone_url}`)
          .join("\n\n");
        log("OLLAMA_TOOL", `github_search "${query}" (${data.total_count} total)`);
        emitResult("GitHubSearch", { query, totalCount: data.total_count, items: data.items.slice(0, 5) });
        return { toolName: "GitHubSearch", input: { query }, result: `GitHub search: ${data.items.length} repos`, content: formatted || "No repositories found." };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("GitHubSearch", { error: msg });
        return { toolName: "GitHubSearch", input: { query }, result: msg, content: `GitHub search failed: ${msg}` };
      }
    }

    case "github_clone": {
      let url = (args.url ?? "").trim();
      let destination = (args.destination ?? "").trim();
      const depth = (args as Record<string, unknown>).depth as number | undefined;

      if (url.match(/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/) && !url.endsWith(".git")) {
        url = url.replace(/\/$/, "") + ".git";
      }

      if (!destination) {
        const repoName = url.replace(/\.git$/, "").split("/").pop() || "project";
        destination = repoName;
      }

      const absDestination = path.isAbsolute(destination) ? destination : path.resolve(cwd, destination);
      if (fs.existsSync(absDestination)) {
        const entries = fs.readdirSync(absDestination);
        if (entries.length > 0) {
          const repoName = url.replace(/\.git$/, "").split("/").pop() || "project";
          destination = path.join(destination, repoName);
        }
      }

      emitStart("GitHubClone", { url, destination, depth });
      try {
        const cloneArgs = ["clone"];
        if (depth) cloneArgs.push("--depth", String(depth));
        cloneArgs.push(url, destination);
        const result = await runShell(`git ${cloneArgs.join(" ")}`, cwd, 60_000);
        if (result.exitCode === 0) {
          log("OLLAMA_TOOL", `github_clone ${url} -> ${destination}`);
          let readme = "";
          const readmePath = path.resolve(cwd, destination, "README.md");
          try {
            if (fs.existsSync(readmePath)) {
              readme = fs.readFileSync(readmePath, "utf-8").slice(0, 3000);
            }
          } catch {}
          emitResult("GitHubClone", { status: "ok", url, destination });
          const content = [`Cloned ${url} → ${destination}`, result.stdout, readme ? `\n--- README.md ---\n${readme}` : ""].filter(Boolean).join("\n").trim();
          return { toolName: "GitHubClone", input: { url, destination }, result: `Cloned ${url} -> ${destination}`, content };
        }
        const errOutput = result.stderr || result.stdout || "clone failed";
        emitResult("GitHubClone", { error: errOutput });
        return { toolName: "GitHubClone", input: { url, destination }, result: errOutput, content: errOutput };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("GitHubClone", { error: msg });
        return { toolName: "GitHubClone", input: { url, destination }, result: msg, content: `Clone failed: ${msg}` };
      }
    }

    case "ask_user": {
      const question = args.question ?? "";
      const options = extractOptionsFromQuestion(question);
      emitStart("AskUser", { question });
      emit(getMainWindow, sessionId, "ask_user:request", { question, toolUseId: toolId, options });

      const response = await new Promise<string>((resolve) => {
        const session = sessions.get(sessionId);
        if (session) {
          session.pendingUserResponse = { resolve };
        }
      });

      emitResult("AskUser", { response });
      return { toolName: "AskUser", input: { question }, result: `User responded: ${response}`, content: response };
    }

    case "recall_conversation": {
      const query = args.query ?? "";
      const targetSessionId = args.sessionId as string | undefined;
      emitStart("RecallConversation", { query });
      try {
        const session = sessions.get(sessionId);
        const projectId = session?.cwd ?? cwd;

        let results;
        if (targetSessionId) {
          results = getSessionMessages(targetSessionId, 20);
        } else {
          results = searchProjectMessages(projectId, query, 20);
        }

        const formatted = results
          .map((r: { role: string; content: string; sessionId: string; timestamp: number }) =>
            `[${new Date(r.timestamp).toLocaleString()}] ${r.role}: ${r.content.slice(0, 300)}`,
          )
          .join("\n\n");

        emitResult("RecallConversation", { query, resultCount: results.length });
        return { toolName: "RecallConversation", input: { query }, result: `Found ${results.length} messages`, content: formatted || "No matching messages found in conversation history." };
      } catch (err) {
        const msg = (err as Error).message;
        emitResult("RecallConversation", { error: msg });
        return { toolName: "RecallConversation", input: { query }, result: msg, content: `Recall failed: ${msg}` };
      }
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

async function streamOllamaChat(
  session: OllamaSession,
  controller: AbortController,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
): Promise<StreamResult> {
  const client = await getOllamaClient(isCloudModel(session.model), isCloudModel(session.model) ? undefined : session.host);
  const allTools = [...OLLAMA_TOOLS, ...session.mcpTools];
  log("OLLAMA", `api/chat: model=${session.model} messages=${session.messages.length} tools=${allTools.length} nativeTools=${session.supportsTools} thinking=${session.supportsThinking}`);

  let fullContent = "";
  let fullThinking = "";
  let toolCalls: OllamaToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  const MAX_TOOL_CONTENT = 2000;
  const trimmedMessages = session.messages.map(m => {
    if (m.role === "tool" && m.content.length > MAX_TOOL_CONTENT) {
      return { ...m, content: m.content.slice(0, MAX_TOOL_CONTENT) + "\n... (truncated)" };
    }
    return m;
  });
  const compressed = compressConversation(trimmedMessages as Array<{ role: "user" | "assistant" | "system"; content: string }>);

  if (session.state.progressSummary) {
    compressed.splice(1, 0, { role: "system", content: session.state.progressSummary } as typeof compressed[0]);
  }

  const chatOpts: Record<string, unknown> = {
    model: session.model,
    messages: compressed,
    stream: true,
    options: { temperature: 0.2 },
  };
  if (session.supportsTools) chatOpts.tools = allTools;
  if (session.supportsThinking) chatOpts.think = true;

  let lastChunkTime = Date.now();
  let thinkingStartTime = 0;
  let hasContent = false;
  const STREAM_STALL_MS = 120_000;
  const MAX_THINKING_MS = 90_000;

  async function consumeStream(stream: AsyncIterable<Record<string, unknown>>): Promise<void> {
    for await (const chunk of stream as AsyncIterable<{ message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }; done?: boolean; prompt_eval_count?: number; eval_count?: number }>) {
      if (controller.signal.aborted) break;
      lastChunkTime = Date.now();

      if (chunk.message?.thinking && !hasContent && thinkingStartTime === 0) {
        thinkingStartTime = Date.now();
      }
      if (chunk.message?.content || chunk.message?.tool_calls?.length) {
        hasContent = true;
      }
      if (!hasContent && thinkingStartTime > 0 && Date.now() - thinkingStartTime > MAX_THINKING_MS) {
        log("OLLAMA", `thinking exceeded ${MAX_THINKING_MS / 1000}s without content — aborting`);
        controller.abort();
        break;
      }

      if (chunk.message?.thinking) {
        fullThinking += chunk.message.thinking;
        emit(getMainWindow, sessionId, "chat:thinking", { text: fullThinking });
      }

      if (chunk.message?.content) {
        fullContent += chunk.message.content;
        const visible = fullContent
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .replace(/<think>[\s\S]*$/, "")
          .trim();
        if (visible) {
          emit(getMainWindow, sessionId, "chat:delta", { text: visible });
        }
      }

      if (chunk.message?.tool_calls?.length) {
        toolCalls.push(...chunk.message.tool_calls);
      }

      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count ?? 0;
        completionTokens = chunk.eval_count ?? 0;
        if (promptTokens > 0) {
          emit(getMainWindow, sessionId, "context:usage", {
            used: promptTokens + completionTokens,
            limit: session.contextSize,
            promptTokens,
            completionTokens,
          });
        }
      }
    }
  }

  const stallTimer = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_STALL_MS) {
      log("OLLAMA", `stream stalled for ${STREAM_STALL_MS / 1000}s — aborting`);
      controller.abort();
      client.abort();
      clearInterval(stallTimer);
    } else if (!hasContent && thinkingStartTime > 0 && Date.now() - thinkingStartTime > MAX_THINKING_MS) {
      log("OLLAMA", `thinking timeout ${MAX_THINKING_MS / 1000}s — aborting from timer`);
      controller.abort();
      client.abort();
      clearInterval(stallTimer);
    } else if (!fullContent && !fullThinking && Date.now() - lastChunkTime > 5000) {
      emit(getMainWindow, sessionId, "chat:thinking", { text: "Thinking..." });
    }
  }, 3000);

  try {
    const stream = await client.chat(chatOpts);
    await consumeStream(stream);
    clearInterval(stallTimer);
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    log("OLLAMA", `chat error: ${errMsg}`);
    if (session.supportsThinking && errMsg.includes("does not support thinking")) {
      log("OLLAMA", "model does not support thinking — retrying without");
      session.supportsThinking = false;
      delete chatOpts.think;
      const stream = await client.chat(chatOpts);
      await consumeStream(stream);
    } else if (session.supportsTools && (errMsg.includes("does not support tools") || errMsg.includes("tools"))) {
      log("OLLAMA", "model does not support native tools — retrying without, will parse from text");
      session.supportsTools = false;
      delete chatOpts.tools;
      delete chatOpts.think;
      session.supportsThinking = false;
      const stream = await client.chat(chatOpts);
      await consumeStream(stream);
    } else if (errMsg.includes("Internal Server Error") || errMsg.includes("500")) {
      log("OLLAMA", "cloud 500 error — retrying without tools and thinking (known cloud bug with tool calling)");
      session.supportsTools = false;
      session.supportsThinking = false;
      delete chatOpts.tools;
      delete chatOpts.think;
      const stream = await client.chat(chatOpts);
      await consumeStream(stream);
    } else if (errMsg.includes("aborted") || errMsg.includes("AbortError")) {
      log("OLLAMA", "stream aborted (thinking timeout or user interrupt)");
    } else {
      clearInterval(stallTimer);
      throw err;
    }
    clearInterval(stallTimer);
  }

  const cleanContent = fullContent
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();

  if (toolCalls.length === 0) {
    const parsedFromText = parseToolCallsFromText(cleanContent);
    if (parsedFromText.length > 0) {
      log("OLLAMA", `parsed ${parsedFromText.length} tool call(s) from text (no native tool_calls)`);
      toolCalls = parsedFromText;
      emit(getMainWindow, sessionId, "chat:clear-streaming", {});
    }
  }

  const contentForHistory = toolCalls.length > 0 && !session.supportsTools
    ? stripToolCallText(cleanContent)
    : cleanContent;

  return { content: contentForHistory, thinking: fullThinking, toolCalls, promptTokens, completionTokens };
}

function extractOptionsFromQuestion(question: string): string[] {
  const orMatch = question.match(/[:?]\s*(.+?)(?:\?|$)/);
  if (!orMatch) return [];
  const optionsPart = orMatch[1];
  const items = optionsPart.split(/,\s*|\s+or\s+|\s+ou\s+/).map(s => s.replace(/[()'"?.]/g, "").trim()).filter(s => s.length > 1 && s.length < 60);
  return items.length >= 2 && items.length <= 8 ? items : [];
}

function stripToolCallText(text: string): string {
  return text
    .replace(/\{"name":\s*"\w+",\s*"arguments":\s*\{[\s\S]*?\}\s*\}/g, "")
    .replace(/[-*]*\w+\[ARGS\](?:\[ARGS\])?\s*\{[\s\S]*?\}/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/\[TOOL_CALLS\][\s\S]*?(?:<\/s>|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractJsonFromPosition(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function parseToolCallsFromText(text: string): OllamaToolCall[] {
  const calls: OllamaToolCall[] = [];

  const jsonCallPattern = /\{"name":\s*"(\w+)",\s*"arguments":\s*\{/g;
  let match;
  while ((match = jsonCallPattern.exec(text)) !== null) {
    const jsonStart = match.index;
    const obj = extractJsonFromPosition(text, jsonStart);
    if (obj && typeof obj.name === "string" && obj.arguments) {
      calls.push({ function: { name: obj.name as string, arguments: obj.arguments as Record<string, unknown> } });
    }
  }

  if (calls.length === 0) {
    const toolNamePattern = /[-*]*(\w+)\[ARGS\](?:\[ARGS\])?\s*\{/g;
    while ((match = toolNamePattern.exec(text)) !== null) {
      const name = match[1];
      const jsonStart = match.index + match[0].length - 1;
      const args = extractJsonFromPosition(text, jsonStart);
      if (args) {
        calls.push({ function: { name, arguments: args } });
      }
    }
  }

  if (calls.length === 0) {
    const toolCallTag = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    while ((match = toolCallTag.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1]);
        if (obj.name && obj.arguments) {
          calls.push({ function: { name: obj.name, arguments: obj.arguments } });
        }
      } catch {}
    }
  }

  if (calls.length === 0) {
    const toolCallsTag = /\[TOOL_CALLS\]\s*\[?([\s\S]*?)\]?\s*(?:<\/s>|$)/g;
    while ((match = toolCallsTag.exec(text)) !== null) {
      try {
        const raw = match[1].trim();
        const items = raw.startsWith("[") ? JSON.parse(raw) : JSON.parse(`[${raw}]`);
        for (const item of Array.isArray(items) ? items : [items]) {
          if (item.name && item.arguments) {
            calls.push({ function: { name: item.name, arguments: item.arguments } });
          }
        }
      } catch {}
    }
  }

  return calls;
}

// ── IPC registration ───────────────────────────────────────────────────────────

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("ollama:start", async (_event, { cwd, model, projectId, activeSkills, host }: { cwd: string; model?: string; projectId?: string; activeSkills?: string[]; host?: string }) => {
    const sessionId = crypto.randomUUID();
    const sessionModel = model || getDefaultModel();
    const caps = await fetchModelCapabilities(sessionModel, host);

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
      const projectSkillsDir = path.join(cwd, ".harnss", "skills");
      const bundledSkillsDir = path.resolve(__dirname, "..", "src", "skills");
      const bundledSkillsDirAlt = path.resolve(__dirname, "skills");
      for (const id of activeSkills) {
        const candidates = [
          path.join(projectSkillsDir, `${id}.md`),
          path.join(bundledSkillsDir, `${id}.md`),
          path.join(bundledSkillsDirAlt, `${id}.md`),
        ];
        for (const filePath of candidates) {
          try {
            if (fs.existsSync(filePath)) {
              skillContents.push(fs.readFileSync(filePath, "utf-8"));
              log("OLLAMA", `skill loaded: ${id} (from ${filePath})`);
              break;
            }
          } catch {}
        }
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
      ...(host ? { host } : {}),
      contextSize: caps.contextSize,
      abortController: null,
      state: freshState(),
      mcpBridge,
      mcpTools,
      pendingUserResponse: null,
      supportsTools: caps.supportsTools,
      supportsThinking: caps.supportsThinking,
    });

    try { saveSessionMeta(sessionId, projectId || cwd, "", sessionModel, "ollama", Date.now()); } catch {}

    triggerIndex(cwd);

    return { sessionId, model: sessionModel };
  });

  ipcMain.handle("ollama:send", async (_event, { sessionId, text, cwd, model, images, activeSkills, host, contextSummary }: { sessionId: string; text: string; cwd?: string; model?: string; images?: string[]; activeSkills?: string[]; host?: string; contextSummary?: string }) => {
    let session = sessions.get(sessionId);
    if (!session && cwd) {
      const sessionModel = model || getDefaultModel();
      const reviveCaps = await fetchModelCapabilities(sessionModel, host);
      const msgs: OllamaMessage[] = [{ role: "system", content: buildSystemPrompt(cwd) }];
      if (contextSummary) {
        msgs.push({ role: "system", content: `=== PREVIOUS CONVERSATION CONTEXT (session was interrupted) ===\n${contextSummary}\n=== END CONTEXT ===\nContinue from where you left off. Do NOT ask the user to repeat themselves.` });
        log("OLLAMA", `auto-revive: injected ${contextSummary.length} chars of context summary`);
      }
      session = {
        messages: msgs,
        cwd,
        model: sessionModel,
        ...(host ? { host } : {}),
        contextSize: reviveCaps.contextSize,
        abortController: null,
        state: freshState(),
        mcpBridge: null,
        mcpTools: [],
        pendingUserResponse: null,
        supportsTools: reviveCaps.supportsTools,
        supportsThinking: reviveCaps.supportsThinking,
      };
      sessions.set(sessionId, session);
      triggerIndex(cwd);
      log("OLLAMA", `auto-revived session ${sessionId} (cwd=${cwd}, model=${sessionModel})`);
    }
    if (!session) return { error: "Session expired — please start a new chat" };

    if (activeSkills && activeSkills.length > 0 && session.cwd) {
      const skillContents: string[] = [];
      const projectSkillsDir = path.join(session.cwd, ".harnss", "skills");
      const bundledSkillsDir = path.resolve(__dirname, "..", "src", "skills");
      const bundledSkillsDirAlt = path.resolve(__dirname, "skills");
      for (const id of activeSkills) {
        const candidates = [
          path.join(projectSkillsDir, `${id}.md`),
          path.join(bundledSkillsDir, `${id}.md`),
          path.join(bundledSkillsDirAlt, `${id}.md`),
        ];
        for (const filePath of candidates) {
          try {
            if (fs.existsSync(filePath)) {
              skillContents.push(fs.readFileSync(filePath, "utf-8"));
              break;
            }
          } catch {}
        }
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
        try { saveMessage(sessionId, session.cwd, { role: "user", content: text, timestamp: Date.now() }); } catch {}
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
        log("OLLAMA", "research phase — tools enabled, model will research then ask questions");
        session.messages.push({
          role: "user",
          content: `You are in PHASE 1 (RESEARCH). Call ONE tool at a time:
1. web_search once about the main topic
2. Read the result. If you need more info, search once more.
3. github_search once for a starter template (if new project)
4. Then ask_user to clarify user preferences
Do NOT call multiple tools at once. ONE tool, wait for result, think, then next.`,
        });
      }

      let loopCount = 0;
      let researchLoops = 0;
      const MAX_RESEARCH_LOOPS = 8;
      let forcedExecution = false;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        const inResearch = session.state.filesCreated.length === 0 && session.state.filesModified.length === 0;
        if (inResearch) researchLoops++;

        if (inResearch && researchLoops > MAX_RESEARCH_LOOPS && !forcedExecution) {
          forcedExecution = true;
          log("OLLAMA", `research budget exhausted (${MAX_RESEARCH_LOOPS} loops) — forcing execution`);
          session.messages.push({
            role: "user",
            content: `STOP RESEARCHING. You have done enough research (${researchLoops} rounds). Move to execution NOW.
Use the official CLI: run_shell with the appropriate create command and non-interactive flags.
If you already ran the CLI, start writing/editing files NOW. Do NOT search the web again.`,
          });
        }

        log("OLLAMA", `tool loop iteration ${loopCount}/${MAX_TOOL_LOOPS} (messages=${session.messages.length} research=${researchLoops})`);

        const streamResult = await streamOllamaChat(session, controller, getMainWindow, sessionId);
        log("OLLAMA", `stream result: toolCalls=${streamResult.toolCalls.length} content=${streamResult.content.length} chars`);

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
            try { if (streamResult.content) saveMessage(sessionId, session.cwd, { role: "assistant", content: streamResult.content.slice(0, 2000), timestamp: Date.now() }); } catch {}
            emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
            break;
          }
          const mentionsTaskComplete = /\b(all tasks|completed|done|summary|finished|that's it|all done)\b/i.test(streamResult.content);
          const mentionsBuildPass = /\b(build.*pass|build.*success|no errors|0 errors)\b/i.test(streamResult.content);
          const hasWrittenFiles = session.state.filesCreated.length > 0 || session.state.filesModified.length > 0;
          const mentionsSuggestions = /\b(suggest|improvement|would you like|next steps|enhance)\b/i.test(streamResult.content);
          const hasAskedUser = session.messages.some(m => m.role === "tool" && m.tool_name === "ask_user");

          if ((mentionsTaskComplete || mentionsBuildPass) && hasWrittenFiles && !mentionsSuggestions) {
            log("OLLAMA", "task complete but no verification/conclusion — requesting Phase 5");
            session.messages.push({ role: "assistant", content: streamResult.content });
            try { if (streamResult.content) saveMessage(sessionId, session.cwd, { role: "assistant", content: streamResult.content.slice(0, 2000), timestamp: Date.now() }); } catch {}
            const projectDir = session.state.filesCreated[0]?.split("/")[0] || ".";
            session.messages.push({
              role: "user",
              content: `Good work! Now do PHASE 5 (VERIFY & CONCLUDE):
1. read_file "${projectDir}/package.json" to check the scripts and dependencies
2. run_shell "cd ${projectDir} && npm run build" to verify it compiles
3. If build fails, fix the errors and rebuild
4. If build passes, give a 2-3 line summary: what was built, where, how to run
5. Call ask_user with 4-5 improvement suggestions (dark mode, animations, SEO, contact form, etc.)
Do it now.`,
            });
            continue;
          }

          const emptyResponseCount = streamResult.content.length === 0 ? (session.state as SessionState & { emptyCount?: number }).emptyCount = ((session.state as SessionState & { emptyCount?: number }).emptyCount ?? 0) + 1 : ((session.state as SessionState & { emptyCount?: number }).emptyCount = 0);
          if (!mentionsTaskComplete && !mentionsBuildPass && loopCount < MAX_TOOL_LOOPS - 5 && emptyResponseCount < 3) {
            log("OLLAMA", `model stopped without completing tasks (loop ${loopCount}, empty=${emptyResponseCount}) — auto-continuing`);
            session.messages.push({ role: "assistant", content: streamResult.content });
            try { if (streamResult.content) saveMessage(sessionId, session.cwd, { role: "assistant", content: streamResult.content.slice(0, 2000), timestamp: Date.now() }); } catch {}

            const hadGithubSearch = session.messages.some(m => m.role === "tool" && m.content.includes("github.com") && m.content.includes("stars"));
            const mentionsClone = /clone|github_clone|git clone|starter|template|scaffold|boilerplate/i.test(streamResult.content);

            let continueMsg: string;
            if (hasWrittenFiles) {
              continueMsg = "Continue with the next task in your plan. Do NOT replan or list files again.";
            } else if (hadGithubSearch || mentionsClone) {
              continueMsg = `You already found GitHub templates in your research. Do this NOW:
1. Pick the best one from the github_search results (highest stars, most recently updated)
2. Call read_url on its GitHub URL to verify it exists and check its README
3. Call github_clone with that URL and a simple folder name like "my-project"
4. After cloning, read the README and follow the getting started instructions

Do NOT create files manually. Do NOT search again. Clone NOW.`;
            } else {
              continueMsg = `Execute your plan NOW. Priority order:
1. Use the official CLI with non-interactive flags (research the correct flags first with web_search if unsure)
2. If CLI fails, github_search for a starter template, verify with read_url, then github_clone
3. Manual creation with write_file only as absolute last resort`;
            }
            session.messages.push({ role: "user", content: continueMsg });
            continue;
          }

          session.messages.push({ role: "assistant", content: streamResult.content });
          try { if (streamResult.content) saveMessage(sessionId, session.cwd, { role: "assistant", content: streamResult.content.slice(0, 2000), timestamp: Date.now() }); } catch {}
          emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
          break;
        }

        session.messages.push({
          role: "assistant",
          content: streamResult.content || "",
          tool_calls: streamResult.toolCalls,
        });
        try { if (streamResult.content) saveMessage(sessionId, session.cwd, { role: "assistant", content: streamResult.content.slice(0, 2000), timestamp: Date.now() }); } catch {}

        if (streamResult.content) {
          emit(getMainWindow, sessionId, "chat:mid-final", { message: streamResult.content });
        } else {
          emit(getMainWindow, sessionId, "chat:clear-streaming", {});
        }

        const RESEARCH_TOOLS = new Set(["web_search", "read_url", "ask_multiple_ais", "github_search", "ask_user", "recall_conversation", "list_files", "read_file", "search_files"]);
        const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete_file", "run_shell", "github_clone"]);
        const inResearchPhase = session.state.filesCreated.length === 0 && session.state.filesModified.length === 0;

        let callsToExecute = streamResult.toolCalls;
        let droppedWriteCalls = false;
        if (inResearchPhase && !session.supportsTools) {
          const hasResearch = streamResult.toolCalls.some(c => RESEARCH_TOOLS.has(c.function.name));
          const hasWrite = streamResult.toolCalls.some(c => WRITE_TOOLS.has(c.function.name));
          if (hasResearch && hasWrite) {
            callsToExecute = streamResult.toolCalls.filter(c => RESEARCH_TOOLS.has(c.function.name));
            droppedWriteCalls = true;
            log("OLLAMA", `research phase: executing ${callsToExecute.length} research tools, holding back ${streamResult.toolCalls.length - callsToExecute.length} write tools`);
          }
        }

        let ops = 0;
        let lastToolResult = "";
        let lastToolName = "";
        for (const call of callsToExecute) {
          if (ops >= MAX_TOOL_OPS) break;
          ops++;
          const isMcp = call.function.name.startsWith("mcp_") && session.mcpBridge?.toolMap.has(call.function.name);
          const result = isMcp
            ? await executeMcpToolCall(call, session, getMainWindow, sessionId)
            : await executeToolCall(call, session.cwd, session.state, getMainWindow, sessionId);
          session.messages.push({ role: "tool", content: result.content, tool_name: call.function.name } as OllamaMessage);
          try { saveMessage(sessionId, session.cwd, { role: "tool", content: result.content.slice(0, 2000), toolName: call.function.name, toolInput: JSON.stringify(call.function.arguments).slice(0, 500), timestamp: Date.now() }); } catch {}
          lastToolResult = result.content;
          lastToolName = call.function.name;
        }

        if (droppedWriteCalls) {
          session.messages.push({
            role: "user",
            content: "STOP. Review the research results above. Before writing ANY code:\n1. Do you need more research? If yes, call web_search or read_url.\n2. Do you have questions for the user? If yes, call ask_user.\n3. Only when you have ALL the information you need, create your plan and THEN start writing code.",
          });
        }

        const buildFailed = lastToolName === "run_shell"
          && /\b(build|compile|tsc|check)\b/i.test(JSON.stringify(streamResult.toolCalls[streamResult.toolCalls.length - 1]?.function?.arguments ?? {}))
          && /error|Error|ERROR|failed|FAILED/i.test(lastToolResult);
        if (buildFailed) {
          log("OLLAMA", "build failed — injecting correction prompt");
          const errorLines = lastToolResult.split("\n").filter(l => /error|Error/i.test(l)).slice(0, 10).join("\n");
          session.messages.push({
            role: "user",
            content: `The build FAILED with these errors:\n${errorLines}\n\nCreate a correction plan:\n1. Read each file that has errors\n2. Fix each error with edit_file\n3. Run build again\n\nStart fixing NOW. Do NOT give up.`,
          });
        }

        const isLoop = detectLoop(session.state, streamResult.toolCalls);
        if (isLoop) {
          log("OLLAMA", `repetitive loop detected at iteration ${loopCount} — asking model to reconsider`);
          session.messages.push({
            role: "user",
            content: "STOP — you are repeating the same command. It is not working. Try a COMPLETELY DIFFERENT approach. For example: if npx create-next-app keeps failing, create the project manually using mkdir and write_file instead. If a build keeps failing on the same error, search the web for a solution. Move on to the next task in your plan.",
          });
        }

        const SUMMARY_INTERVAL = 5;
        if (loopCount - session.state.lastSummaryAtLoop >= SUMMARY_INTERVAL && session.state.toolCallCount > 3) {
          session.state.lastSummaryAtLoop = loopCount;
          const summaryParts: string[] = ["=== SESSION PROGRESS (do NOT repeat completed work) ==="];
          summaryParts.push(`Original request: ${session.state.originalRequest}`);
          if (session.state.filesCreated.length > 0) {
            summaryParts.push(`Project created: ${session.state.filesCreated.slice(0, 5).join(", ")}${session.state.filesCreated.length > 5 ? ` (+${session.state.filesCreated.length - 5} more)` : ""}`);
            summaryParts.push("WARNING: Project already exists. Do NOT run create-next-app, github_clone, or scaffold commands again. Edit the EXISTING files.");
          }
          if (session.state.filesModified.length > 0) {
            summaryParts.push(`Files modified: ${session.state.filesModified.join(", ")}`);
          }
          const lastAssistantMsgs = session.messages.filter(m => m.role === "assistant" && m.content.length > 50).slice(-2);
          if (lastAssistantMsgs.length > 0) {
            summaryParts.push(`Last actions: ${lastAssistantMsgs.map(m => m.content.slice(0, 150)).join(" | ")}`);
          }
          summaryParts.push("Continue from where you left off. Do NOT start over.");
          session.state.progressSummary = summaryParts.join("\n");
          try { updateSessionSummary(sessionId, session.state.progressSummary); } catch {}
          log("OLLAMA", `progress summary updated at loop ${loopCount}: ${session.state.filesCreated.length} created, ${session.state.filesModified.length} modified`);
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
      try {
        const client = await getOllamaClient(isCloudModel(session.model));
        client.abort();
      } catch {}
      if (session.mcpBridge) disconnectMcpBridge(session.mcpBridge);
      sessions.delete(sessionId);
    }
    safeSend(getMainWindow, "ollama:exit", { _sessionId: sessionId });
    return { ok: true };
  });

  ipcMain.handle("ollama:interrupt", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.abortController?.abort();
      try {
        const client = await getOllamaClient(isCloudModel(session.model));
        client.abort();
      } catch {}
    }
    return { ok: true };
  });

  ipcMain.handle("ollama:status", async () => {
    try {
      const client = await getOllamaClient();
      await client.list();
      return { available: true };
    } catch (err) {
      const host = getBaseUrl();
      if (host.includes("ollama.com")) {
        try {
          const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) return { available: true };
        } catch {}
        const apiKey = getAppSetting("ollamaApiKey");
        if (apiKey) return { available: true };
      }
      return { available: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("ollama:search-models", async (_event, query: string) => {
    try {
      const url = query.trim()
        ? `https://ollama.com/search?q=${encodeURIComponent(query)}&c=cloud`
        : `https://ollama.com/search?c=cloud`;
      const res = await fetch(url, {
        headers: { "HX-Request": "true" },
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      const cards = [...html.matchAll(/<a[^>]*href="\/library\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const models = cards.map(m => {
        const name = m[1].trim();
        const cardHtml = m[2];
        const isCloudOnly = /text-cyan-500[^>]*>cloud<\/span>/i.test(cardHtml);
        return isCloudOnly ? `${name}:cloud` : name;
      }).filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  ipcMain.handle("ollama:list-models", async () => {
    try {
      const client = await getOllamaClient();
      const data = await client.list();
      const models = (data.models ?? []).map((m: { name: string }) => m.name);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  ipcMain.handle("ollama:user_response", async (_event, { sessionId, text }: { sessionId: string; text: string }) => {
    const session = sessions.get(sessionId);
    if (session?.pendingUserResponse) {
      session.pendingUserResponse.resolve(text);
      session.pendingUserResponse = null;
    }
    return { ok: true };
  });
}
