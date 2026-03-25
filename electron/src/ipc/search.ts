import { ipcMain } from "electron";
import { execFile } from "child_process";
import path from "path";
import { reportError } from "../lib/error-utils";

interface FileResult {
  path: string;
  name: string;
  dir: string;
  score: number;
}

interface ContentResult {
  file: string;
  line: number;
  column: number;
  match: string;
  preview: string;
}

function getFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        resolve(stdout.split("\n").filter((f) => f.trim()));
      },
    );
  });
}

function scoreMatch(filePath: string, query: string): number {
  if (!query) return 0;
  const lp = filePath.toLowerCase();
  const lq = query.toLowerCase();
  const fn = path.basename(filePath).toLowerCase();

  if (lp === lq) return 1000;
  if (fn === lq) return 900;

  const qSegs = lq.split("/").filter(Boolean);
  const pSegs = lp.split("/").filter(Boolean);

  if (qSegs.length > 1) {
    const joined = qSegs.join("/");
    const idx = lp.indexOf(joined);
    if (idx !== -1) return 800 + (idx === 0 || lp[idx - 1] === "/" ? 50 : 0);

    let matched = 0;
    let lastIdx = -1;
    for (const seg of qSegs) {
      const found = pSegs.indexOf(seg, lastIdx + 1);
      if (found !== -1) { matched++; lastIdx = found; }
    }
    if (matched === qSegs.length) return 600;
    if (matched > 0) return 300 + matched * 50;
  }

  const fnIdx = fn.indexOf(lq);
  if (fnIdx !== -1) return fnIdx === 0 ? 750 : 500;

  const fullIdx = lp.indexOf(lq);
  if (fullIdx !== -1) return lp[fullIdx - 1] === "/" ? 400 : 200;

  let fuzzy = 0;
  let qi = 0;
  let lastPos = -1;
  for (let pi = 0; pi < lp.length && qi < lq.length; pi++) {
    if (lp[pi] === lq[qi]) {
      fuzzy += pi === 0 || lp[pi - 1] === "/" ? 10 : pi === lastPos + 1 ? 5 : 1;
      lastPos = pi;
      qi++;
    }
  }
  return qi === lq.length && fuzzy > 0 ? fuzzy : -1;
}

function runContentSearch(
  cwd: string,
  pattern: string,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults: number,
  include?: string,
  exclude?: string,
): Promise<{ results: ContentResult[]; totalCount: number }> {
  return new Promise((resolve) => {
    const args: string[] = ["--line-number", "--column", "--no-heading", `--max-count=${maxResults}`];
    if (!isRegex) args.push("--fixed-strings");
    if (!caseSensitive) args.push("--ignore-case");
    if (include) args.push("--glob", include);
    if (exclude) args.push("--glob", `!${exclude}`);
    args.push("--", pattern, ".");

    execFile("rg", args, { cwd, maxBuffer: 5 * 1024 * 1024 }, (rgErr, rgOut) => {
      if (rgErr && (rgErr as NodeJS.ErrnoException).code === "ENOENT") {
        const gitArgs = ["grep", "--line-number", "--column", "-n"];
        if (!isRegex) gitArgs.push("--fixed-strings");
        if (!caseSensitive) gitArgs.push("--ignore-case");
        gitArgs.push("--", pattern);
        execFile("git", gitArgs, { cwd, maxBuffer: 5 * 1024 * 1024 }, (_gitErr, gitOut) => {
          resolve(parseLines(gitOut || "", maxResults, true));
        });
        return;
      }
      resolve(parseLines(rgOut || "", maxResults, false));
    });
  });
}

function parseLines(stdout: string, max: number, isGitGrep: boolean): { results: ContentResult[]; totalCount: number } {
  const results: ContentResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line || results.length >= max) continue;
    if (isGitGrep) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const file = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx + 1);
      const m = rest.match(/^(\d+)(?::(\d+))?:(.*)$/);
      if (!m) continue;
      results.push({ file, line: parseInt(m[1], 10), column: m[2] ? parseInt(m[2], 10) : 1, match: m[3].trim(), preview: m[3] });
    } else {
      const m = line.match(/^([^:]+):(\d+):(\d+):(.*)$/);
      if (!m) continue;
      results.push({ file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10), match: m[4].trim(), preview: m[4] });
    }
  }
  return { results, totalCount: results.length };
}

export function register(): void {
  ipcMain.handle(
    "search:files",
    async (_event, { cwd, query, maxResults = 50 }: { cwd: string; query: string; maxResults?: number }) => {
      try {
        const allFiles = await getFiles(cwd);
        const scored: FileResult[] = [];
        for (const fp of allFiles) {
          const s = scoreMatch(fp, query);
          if (s > 0) scored.push({ path: fp, name: path.basename(fp), dir: path.dirname(fp) === "." ? "" : path.dirname(fp), score: s });
        }
        scored.sort((a, b) => b.score - a.score);
        return { results: scored.slice(0, maxResults) };
      } catch (err) {
        return { results: [], error: reportError("SEARCH_FILES", err) };
      }
    },
  );

  ipcMain.handle(
    "search:content",
    async (
      _event,
      { cwd, pattern, isRegex = false, caseSensitive = false, maxResults = 200, include, exclude }:
      { cwd: string; pattern: string; isRegex?: boolean; caseSensitive?: boolean; maxResults?: number; include?: string; exclude?: string },
    ) => {
      try {
        return await runContentSearch(cwd, pattern, isRegex, caseSensitive, maxResults, include, exclude);
      } catch (err) {
        return { results: [], totalCount: 0, error: reportError("SEARCH_CONTENT", err) };
      }
    },
  );
}
