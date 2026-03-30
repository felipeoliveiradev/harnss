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

let ollamaClient: any = null;
async function getOllamaClient(): Promise<any> {
  if (!ollamaClient) {
    const { Ollama } = await import("ollama");
    ollamaClient = new Ollama({ host: getBaseUrl() });
  }
  return ollamaClient;
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

ENVIRONMENT — How This System Works

You run inside a desktop IDE. When you call a tool, the IDE executes it and returns the result. Here is how each part works:

SHELL EXECUTION (run_shell):
- Commands run in a NON-INTERACTIVE shell. There is NO terminal, NO stdin, NO user to type answers.
- If a command asks a question (y/n, choose option, confirm) — it will HANG FOREVER because nobody can respond.
- You must THINK before running any command: "Could this command ask me something?"

HOW TO REASON ABOUT COMMANDS:
When you need to run a command you haven't used before, follow this decision process:

1. ASK YOURSELF: "Does this command have interactive prompts?"
   - Setup/scaffold commands (create-app, init, new) → ALMOST ALWAYS interactive
   - Install commands (npm install, pip install) → usually safe
   - Build/run commands (build, dev, start) → usually safe
   - Config commands (init, setup) → often interactive

2. IF YOU'RE NOT SURE → search first: web_search "[command name] non-interactive CLI flags"
   - Read the results to find which flags skip prompts
   - Common patterns you'll find: --yes, -y, --no-input, --default, --non-interactive
   - Some tools use environment variables: CI=true, NONINTERACTIVE=1
   - Some tools accept piped input: "yes '' | command" sends empty answers to all prompts

3. CHOOSE YOUR APPROACH:
   - You found the flags → run the command with those flags
   - You're still unsure → create the project manually (mkdir + write_file for config files + install command)
   - The command hung/failed → DON'T retry the same command. Switch to manual creation.

4. WHY MANUAL CREATION ALWAYS WORKS:
   - write_file never asks questions. mkdir never asks questions. npm install never asks questions.
   - You can create ANY project by writing its config files directly
   - Search web_search "[framework] minimum files needed for project" to know what to create
   - This approach is SLOWER but 100% RELIABLE. Prefer it when you don't know the command well.

5. USEFUL LIBRARIES AND FRAMEWORKS TO KNOW:
   When the user asks to build AI-powered applications, consider these tools:
   - Vercel AI SDK (npm: "ai") — toolkit for building AI apps with React, Next.js, Svelte, Vue, Angular. Has useChat(), streamText(), tool calling, and providers for OpenAI, Anthropic, Google, Ollama, etc.
   - ollama-ai-provider — connects Vercel AI SDK to local Ollama models
   - LangChain — framework for LLM chains, agents, RAG
   - These are suggestions — always search the web for the best current solution for what the user needs.

6. SEARCH FOR BOILERPLATES AND TEMPLATES:
   - Before creating from scratch, search for existing templates: web_search "[framework] starter template github"
   - Look for official or popular boilerplates you can clone: run_shell "git clone [url] project-name"
   - Cloning a template is faster than creating files one by one and avoids config mistakes
   - After cloning, customize the files for the user's needs using edit_file
   - If you can't find a good template or clone fails, fall back to manual creation

FILE OPERATIONS (write_file, read_file, edit_file):
- write_file creates the file AND all parent directories automatically. No need to mkdir first.
- write_file REPLACES the entire file. Always provide COMPLETE content.
- read_file returns the full file content. Use it before edit_file.
- edit_file finds and replaces exact text. The old_string MUST match exactly.

WEB TOOLS (web_search, read_url):
- web_search returns a summary of search results (titles, URLs, snippets).
- read_url fetches a web page and returns its text content.
- Use these to find documentation, solutions to errors, correct command flags, etc.
- Results are truncated to save context. If you need more detail, call read_url on a specific result URL.

TOOL RESULTS:
- After you call a tool, the system executes it and returns the result in the next message.
- You see the result and then decide what to do next.
- If the result shows an error, analyze it and fix it. Do NOT ignore errors.
- If the result is empty or unexpected, try a different approach.

CONTEXT LIMITS:
- Your context window is limited. Do NOT request unnecessary information.
- Do NOT list files repeatedly. Check once, then work from memory.
- Do NOT make web searches you don't need. Search only when you don't know something.
- Keep your text responses SHORT (1-2 lines). Let tool calls do the work.

====

CAPABILITIES

You have access to tools that let you execute CLI commands, list files, search code, read and write files. These tools help you accomplish tasks such as writing code, making edits, understanding projects, setting up new projects, and performing system operations.

IMPORTANT: You can ONLY interact with the project through tool calls. Writing code directly in your response text has NO EFFECT on the file system. Only tool calls actually create or modify files.

====

AVAILABLE TOOLS

You have tools available as functions. Call them to interact with the project. Do NOT describe what you would do — call the function directly.

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
Execute a shell command in ${cwd}. Commands run non-interactively — they CANNOT ask for user input or confirmations.
Parameters:
- command: (required) The shell command to execute.
WHEN TO USE: Installing packages, scaffolding projects, running builds, git commands, creating directories, etc.
IMPORTANT RULES:
- If you need to run a command in a subdirectory, prepend with cd: "cd my-project && command"
- ALWAYS use non-interactive flags (--yes, -y, --no-input, --default) to avoid prompts
- NEVER run the same command more than once. If it failed, try a DIFFERENT approach or create files manually with write_file
- To explore files, use list_files instead of ls — it automatically filters build artifacts and dependencies
- Do NOT spend multiple turns exploring the project. Check once, then start writing code

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
Before ANY code or tool calls, you MUST create a detailed plan. Break the work into small, numbered tasks. This is MANDATORY for EVERY request.

Your plan MUST include these phases in order:
A. RESEARCH: Include a task to search the web for the correct setup commands and documentation before running them.
B. PROJECT STRUCTURE: Define the complete file tree of the project BEFORE writing any code. List every file and directory you will create. Example:
   "File tree:
   my-project/
     package.json
     src/
       app/
         layout.tsx
         page.tsx
       components/
         Header.tsx
         Hero.tsx
         Features.tsx
         Footer.tsx
     tailwind.config.ts
     tsconfig.json"
C. IMPLEMENTATION: One task per file/component to create.
D. DEPENDENCIES: Install any additional packages needed.
E. BUILD & FIX: Run build, fix ALL errors in a loop until build passes.

Format your plan EXACTLY like this:
"Plan:
1. Research the correct scaffold command for [framework]
2. Define project file tree
3. Scaffold project (or create manually if scaffold fails)
4. Create [file1]
5. Create [file2]
...
N-1. Install dependencies
N. Run build and fix all errors until build passes"

STEP 2 — EXECUTE EACH TASK:
After planning, execute tasks ONE BY ONE. For EACH task:
- Say "Task X/N: [description]" before starting it
- Call the necessary tools (write_file, run_shell, etc.) to complete it
- After the tool result comes back, immediately move to the next task
- Do NOT wait for user confirmation. Keep going autonomously until ALL tasks are done
- NEVER stop in the middle. Complete ALL tasks in your plan
- FOCUS ON WRITING CODE. Most of your tool calls should be write_file
- After scaffolding a project, you already know the structure from your plan. Go straight to writing files

STEP 3 — RESEARCH AND PROJECT SETUP:
Before running ANY scaffold or setup command, you MUST research thoroughly:

A. SEARCH MULTIPLE SOURCES:
   - web_search "[framework] create project command line non-interactive 2025"
   - web_search "[framework] official documentation getting started"
   - web_search "[framework] scaffold project without prompts"
   - Read at least 2-3 results using read_url to understand the correct approach

B. READ OFFICIAL DOCUMENTATION:
   - Find the official docs URL from search results
   - Use read_url to read the official getting started guide
   - Extract the exact command with all required flags

C. HANDLE INTERACTIVE PROMPTS:
   Commands run non-interactively — they CANNOT receive user input. If a command asks questions (y/n, choose options, etc.), it will hang or fail. To avoid this:
   - ALWAYS search for the non-interactive flags first: web_search "[tool] CLI non-interactive flags"
   - Common patterns: --yes, -y, --no-input, --default, --no-interactive
   - Pipe yes: "yes | command" or "echo y | command"
   - Set environment variables: "CI=true command" or "NONINTERACTIVE=1 command"
   - If you don't know the flags, search: web_search "[tool] skip prompts command line"
   - If the command STILL hangs or asks for input, ABANDON it and create the project manually

D. EXECUTE WITH CONFIDENCE:
   - Use the command with ALL non-interactive flags found in your research
   - If it fails or hangs, DO NOT retry the same command
   - Search the specific error: web_search "[tool] [error message] solution"
   - Try the solution found. If it still fails after 2 attempts, go to manual creation

E. FALLBACK — MANUAL CREATION (always works):
   - Search: web_search "[framework] minimal project structure files"
   - Read the docs to understand the minimum files needed
   - Use run_shell "mkdir -p" for directories
   - Use write_file for EVERY config file (package.json, tsconfig.json, etc.)
   - This ALWAYS works because there are no interactive prompts
   - PREFER this approach if you are unsure about the scaffold command

After setup, do NOT list files to verify. You defined the structure in your plan — trust it and start writing code.

STEP 4 — WRITE ALL FILES:
Use write_file for EACH file. Provide complete, runnable content. Create files one by one. Each file = one write_file call.

STEP 5 — INSTALL DEPENDENCIES:
Use run_shell with the appropriate package manager for the language/framework.

STEP 6 — BUILD & FIX LOOP (MANDATORY — NEVER SKIP):
This is the most important step. You MUST:
1. Run the build/compile command for the project
2. If it PASSES → go to Step 7
3. If it FAILS → read the error output carefully
4. For EACH error: read the failing file with read_file, fix it with edit_file
5. Run build AGAIN
6. Repeat steps 3-5 until build passes or you've tried 3 times
7. If still failing after 3 tries, use web_search to find solutions for the specific error
8. Apply the solution found and rebuild
9. NEVER finish without a passing build. NEVER tell the user "there are errors, please fix them"

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

When a tool call returns an error, follow this escalation path IN ORDER:

LEVEL 1 — FIX IT YOURSELF:
- Read the error message carefully
- Fix the issue and retry. Examples:
  - Directory not found → run_shell "mkdir -p path/to/dir", then retry
  - Package not found → run_shell "cd project && npm install package-name"
  - edit_file old_string not found → read_file first, then retry with exact content
  - Build error → read the error, fix the file with edit_file, rebuild

LEVEL 2 — DEEP SEARCH FOR SOLUTIONS:
- If you don't know how to fix it, search the web thoroughly:
  a) web_search "[error message] solution [framework] [year]"
  b) Read at least 2-3 results using read_url — do NOT just read the first one
  c) Compare solutions from different sources, pick the most recommended
  d) If first search doesn't help, try different search queries:
     - web_search "[error message] fix"
     - web_search "[framework] [feature] not working"
     - web_search "[error code] stackoverflow"
  e) Also check official docs: web_search "[framework] official docs [topic]" → read_url
  f) Apply the solution found. If it doesn't work, try the next solution from your research

LEVEL 3 — CREATE CORRECTION TASKS:
- If the error is complex, break the fix into sub-tasks:
  "Correction plan:
  1. Read the failing file to understand the issue
  2. Search web for the specific error message
  3. Apply the fix from the solution found
  4. Rebuild to verify the fix works"
- Execute each correction task one by one

LEVEL 4 — ASK THE USER (last resort):
- ONLY after trying Levels 1-3 and failing
- Ask a clear, specific question: "I tried X, Y, and Z but the error persists. The error is: [error]. Do you want me to try a different approach, or do you have a preference?"
- You CAN also ask the user for clarification about requirements (e.g., "Should the landing page have a dark theme or light theme?", "Which sections do you want?")
- But NEVER ask about technical implementation — figure it out yourself

IMPORTANT: NEVER give up. NEVER tell the user to fix something. Always exhaust Levels 1-3 before asking.

====

COMMUNICATION

- Reply in the same language as the user.
- Keep explanations to 1-2 lines maximum. Let your tool calls do the talking.
- After completing a task, give a one-line summary of what was created/changed.
- Do NOT start messages with "Great", "Sure", "Certainly". Be direct and technical.
- Your goal is to accomplish the task, NOT have a conversation.
- You CAN ask the user questions about their preferences (design, features, scope) but NEVER about technical problems — solve those yourself.
- If you are unsure about what the user wants, ask ONE clear question and wait for the answer before proceeding.`;

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
    const client = await getOllamaClient();
    const data = await client.show({ model });
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
        const truncated = crawlResult.content.length > 8000
          ? crawlResult.content.slice(0, 8000) + "\n\n... (truncated)"
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
  const client = await getOllamaClient();
  let fullContent = "";

  const stream = await client.chat({
    model: session.model,
    messages: session.messages,
    stream: true,
    options: { temperature: 0.3 },
  });

  for await (const chunk of stream) {
    if (controller.signal.aborted) break;
    if (chunk.message?.content) {
      fullContent += chunk.message.content;
      const visible = fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
      if (visible) emit(getMainWindow, sessionId, "chat:delta", { text: visible });
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
  const client = await getOllamaClient();
  const allTools = [...OLLAMA_TOOLS, ...session.mcpTools];
  const supportsThinking = (session as OllamaSession & { supportsThinking?: boolean }).supportsThinking !== false;
  log("OLLAMA", `api/chat: model=${session.model} messages=${session.messages.length} tools=${allTools.length} think=${supportsThinking}`);

  let fullContent = "";
  let fullThinking = "";
  let toolCalls: OllamaToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  const chatOpts: Record<string, unknown> = {
    model: session.model,
    messages: session.messages,
    tools: allTools,
    stream: true,
    options: { temperature: 0.2 },
  };
  if (supportsThinking) chatOpts.think = true;

  try {
    const stream = await client.chat(chatOpts);

    for await (const chunk of stream) {
      if (controller.signal.aborted) break;

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
  } catch (err) {
    const errMsg = (err as Error).message || String(err);
    if (supportsThinking && errMsg.includes("does not support thinking")) {
      log("OLLAMA", "model does not support thinking — retrying without");
      (session as OllamaSession & { supportsThinking?: boolean }).supportsThinking = false;
      delete chatOpts.think;
      const stream = await client.chat(chatOpts);
      for await (const chunk of stream) {
        if (controller.signal.aborted) break;
        if (chunk.message?.content) {
          fullContent += chunk.message.content;
          const visible = fullContent.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
          if (visible) emit(getMainWindow, sessionId, "chat:delta", { text: visible });
        }
        if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          completionTokens = chunk.eval_count ?? 0;
        }
      }
    } else {
      throw err;
    }
  }

  const cleanContent = fullContent
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();

  if (toolCalls.length === 0) {
    const parsedFromText = parseToolCallsFromText(cleanContent);
    if (parsedFromText.length > 0) {
      log("OLLAMA", `parsed ${parsedFromText.length} tool call(s) from text (SDK didn't return native tool_calls)`);
      toolCalls = parsedFromText;
    }
  }

  return { content: cleanContent, thinking: fullThinking, toolCalls, promptTokens, completionTokens };
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
        log("OLLAMA", `planning turn complete — ${planResult.content.length} chars`);
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
            content: `Good plan. Now execute ALL tasks without stopping. Rules:
- If your first task is research, call web_search NOW to find the correct commands.
- After each tool result, move to the NEXT task immediately.
- Call write_file for EVERY file with COMPLETE content.
- Do NOT describe code in text — ONLY tool calls.
- After ALL files are created, install dependencies, then run build.
- If build fails, fix errors and rebuild.
- Keep going until ALL tasks are done and build passes.
GO.`,
          });
          log("OLLAMA", "execution phase starting — tools enabled");
        }
      }

      let loopCount = 0;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        log("OLLAMA", `tool loop iteration ${loopCount}/${MAX_TOOL_LOOPS} (messages=${session.messages.length})`);

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
            emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
            break;
          }
          const mentionsTaskComplete = /\b(all tasks|completed|done|summary|finished|that's it|all done)\b/i.test(streamResult.content);
          const mentionsBuildPass = /\b(build.*pass|build.*success|no errors|0 errors)\b/i.test(streamResult.content);
          const hasWrittenFiles = session.state.filesCreated.length > 0 || session.state.filesModified.length > 0;

          const emptyResponseCount = streamResult.content.length === 0 ? (session.state as SessionState & { emptyCount?: number }).emptyCount = ((session.state as SessionState & { emptyCount?: number }).emptyCount ?? 0) + 1 : ((session.state as SessionState & { emptyCount?: number }).emptyCount = 0);
          if (!mentionsTaskComplete && !mentionsBuildPass && loopCount < MAX_TOOL_LOOPS - 5 && emptyResponseCount < 3) {
            log("OLLAMA", `model stopped without completing tasks (loop ${loopCount}, empty=${emptyResponseCount}) — auto-continuing`);
            session.messages.push({ role: "assistant", content: streamResult.content });
            session.messages.push({
              role: "user",
              content: hasWrittenFiles
                ? "Continue with the next task in your plan. Do NOT replan or list files again. Call write_file for the next file you need to create."
                : "You have not created any files yet. Start writing code NOW. Call write_file to create the first file. Do NOT list files or describe code — just create the files.",
            });
            continue;
          }

          session.messages.push({ role: "assistant", content: streamResult.content });
          emit(getMainWindow, sessionId, "chat:final", { message: streamResult.content });
          break;
        }

        session.messages.push({
          role: "assistant",
          content: streamResult.content || "",
          tool_calls: streamResult.toolCalls,
        });

        if (streamResult.content) {
          emit(getMainWindow, sessionId, "chat:mid-final", { message: streamResult.content });
        } else {
          emit(getMainWindow, sessionId, "chat:clear-streaming", {});
        }

        let ops = 0;
        let lastToolResult = "";
        let lastToolName = "";
        for (const call of streamResult.toolCalls) {
          if (ops >= MAX_TOOL_OPS) break;
          ops++;
          const isMcp = call.function.name.startsWith("mcp_") && session.mcpBridge?.toolMap.has(call.function.name);
          const result = isMcp
            ? await executeMcpToolCall(call, session, getMainWindow, sessionId)
            : await executeToolCall(call, session.cwd, session.state, getMainWindow, sessionId);
          session.messages.push({ role: "tool", content: result.content, tool_name: call.function.name } as OllamaMessage);
          lastToolResult = result.content;
          lastToolName = call.function.name;
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
      const client = await getOllamaClient();
      await client.list();
      return { available: true };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("ollama:list-models", async () => {
    try {
      const client = await getOllamaClient();
      const data = await client.list();
      return { ok: true, models: (data.models ?? []).map((m: { name: string }) => m.name) };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });
}
