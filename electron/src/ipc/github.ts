import { BrowserWindow, ipcMain } from "electron";
import { execFile } from "child_process";
import https from "https";
import { log } from "../lib/logger";
import { reportError } from "../lib/error-utils";
import { safeSend } from "../lib/safe-send";

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const CACHE_5MIN = 5 * 60 * 1000;
const CACHE_10MIN = 10 * 60 * 1000;
const CACHE_2MIN = 2 * 60 * 1000;

function githubApi<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.github.com",
      path,
      method: "GET",
      headers: {
        "User-Agent": "Harnss-Desktop",
        Accept: "application/vnd.github.v3+json",
      },
    };

    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (ghToken) {
      options.headers!["Authorization"] = `Bearer ${ghToken}`;
    }

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${(err as Error).message}`));
          }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("GitHub API request timed out"));
    });
    req.end();
  });
}

interface GitHubSearchResult {
  total_count: number;
  items: Array<{
    full_name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    language: string | null;
    topics: string[];
    updated_at: string;
    default_branch: string;
    clone_url: string;
  }>;
}

interface GitHubTreeResult {
  tree: Array<{
    path: string;
    type: string;
    size?: number;
    sha: string;
  }>;
  truncated: boolean;
}

interface GitHubFileResult {
  content: string;
  encoding: string;
  size: number;
  name: string;
  path: string;
}

interface GitHubCodeSearchResult {
  total_count: number;
  items: Array<{
    name: string;
    path: string;
    repository: { full_name: string; html_url: string };
    html_url: string;
    text_matches?: Array<{ fragment: string }>;
  }>;
}

export function register(getMainWindow?: () => BrowserWindow | null): void {
  ipcMain.handle(
    "github:search",
    async (
      _event,
      options: { query: string; language?: string; sort?: string; per_page?: number },
    ) => {
      try {
        const cacheKey = `gh:search:${JSON.stringify(options)}`;
        const cached = getCached<GitHubSearchResult>(cacheKey);
        if (cached) return { ok: true, data: cached };

        let q = encodeURIComponent(options.query);
        if (options.language) q += `+language:${encodeURIComponent(options.language)}`;
        const sort = options.sort || "stars";
        const perPage = options.per_page || 10;
        const apiPath = `/search/repositories?q=${q}&sort=${sort}&per_page=${perPage}`;

        const data = await githubApi<GitHubSearchResult>(apiPath);
        setCache(cacheKey, data, CACHE_5MIN);
        log("GITHUB", `search "${options.query}": ${data.total_count} results`);
        return { ok: true, data };
      } catch (err) {
        const msg = reportError("GITHUB_SEARCH", err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "github:browse",
    async (_event, owner: string, repo: string, ref?: string) => {
      try {
        const cacheKey = `gh:browse:${owner}/${repo}:${ref || "HEAD"}`;
        const cached = getCached<GitHubTreeResult>(cacheKey);
        if (cached) return { ok: true, data: cached };

        const branch = ref || "HEAD";
        const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

        const data = await githubApi<GitHubTreeResult>(apiPath);
        setCache(cacheKey, data, CACHE_10MIN);
        log("GITHUB", `browse ${owner}/${repo}@${branch}: ${data.tree.length} entries`);
        return { ok: true, data };
      } catch (err) {
        const msg = reportError("GITHUB_BROWSE", err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "github:read",
    async (_event, owner: string, repo: string, filePath: string, ref?: string) => {
      try {
        const cacheKey = `gh:read:${owner}/${repo}:${filePath}:${ref || ""}`;
        const cached = getCached<GitHubFileResult>(cacheKey);
        if (cached) return { ok: true, data: cached };

        let apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}`;
        if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`;

        const data = await githubApi<GitHubFileResult>(apiPath);
        setCache(cacheKey, data, CACHE_10MIN);
        log("GITHUB", `read ${owner}/${repo}/${filePath}: ${data.size} bytes`);
        return { ok: true, data };
      } catch (err) {
        const msg = reportError("GITHUB_READ", err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "github:clone",
    async (
      _event,
      url: string,
      destination: string,
      options?: { depth?: number; branch?: string },
    ) => {
      try {
        const args = ["clone"];
        if (options?.depth) args.push("--depth", String(options.depth));
        if (options?.branch) args.push("--branch", options.branch);
        args.push("--progress", url, destination);

        return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const proc = execFile("git", args, { timeout: 120000 }, (err) => {
            if (err) {
              const msg = reportError("GITHUB_CLONE", err);
              resolve({ ok: false, error: msg });
            } else {
              log("GITHUB", `cloned ${url} -> ${destination}`);
              resolve({ ok: true });
            }
          });

          proc.stderr?.on("data", (data: Buffer) => {
            const line = data.toString().trim();
            if (line && getMainWindow) {
              safeSend(getMainWindow, "github:clone-progress", { url, destination, message: line });
            }
          });
        });
      } catch (err) {
        const msg = reportError("GITHUB_CLONE", err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "github:search-code",
    async (
      _event,
      query: string,
      options?: { language?: string; per_page?: number },
    ) => {
      try {
        const cacheKey = `gh:code:${query}:${JSON.stringify(options || {})}`;
        const cached = getCached<GitHubCodeSearchResult>(cacheKey);
        if (cached) return { ok: true, data: cached };

        let q = encodeURIComponent(query);
        if (options?.language) q += `+language:${encodeURIComponent(options.language)}`;
        const perPage = options?.per_page || 10;
        const apiPath = `/search/code?q=${q}&per_page=${perPage}`;

        const data = await githubApi<GitHubCodeSearchResult>(apiPath);
        setCache(cacheKey, data, CACHE_2MIN);
        log("GITHUB", `search-code "${query}": ${data.total_count} results`);
        return { ok: true, data };
      } catch (err) {
        const msg = reportError("GITHUB_SEARCH_CODE", err);
        return { ok: false, error: msg };
      }
    },
  );
}
