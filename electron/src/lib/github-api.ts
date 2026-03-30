import { Octokit } from "@octokit/rest";
import { spawn } from "child_process";

export interface SearchReposOptions {
  query: string;
  language?: string;
  topics?: string[];
  isTemplate?: boolean;
  sort?: "stars" | "forks" | "updated" | "help-wanted-issues" | "best-match";
  order?: "asc" | "desc";
  perPage?: number;
  page?: number;
}

export interface RepoSearchResult {
  id: number;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  stargazersCount: number;
  forksCount: number;
  language: string | null;
  topics: string[];
  isTemplate: boolean;
  updatedAt: string | null;
  owner: {
    login: string;
    avatarUrl: string;
  };
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
  size: number;
  encoding: string;
}

export interface CodeSearchOptions {
  perPage?: number;
  page?: number;
  sort?: "indexed";
  order?: "asc" | "desc";
}

export interface CodeSearchResult {
  name: string;
  path: string;
  sha: string;
  htmlUrl: string;
  repository: {
    fullName: string;
    description: string | null;
    htmlUrl: string;
  };
  textMatches?: Array<{
    fragment: string;
    matches: Array<{
      text: string;
      indices: number[];
    }>;
  }>;
}

export interface CloneOptions {
  url: string;
  targetDir: string;
  branch?: string;
  depth?: number;
  onProgress?: (data: string) => void;
}

export async function searchRepositories(
  octokit: Octokit,
  options: SearchReposOptions,
): Promise<{ totalCount: number; items: RepoSearchResult[] }> {
  let q = options.query;
  if (options.language) q += ` language:${options.language}`;
  if (options.topics) {
    for (const topic of options.topics) {
      q += ` topic:${topic}`;
    }
  }
  if (options.isTemplate !== undefined) {
    q += ` template:${options.isTemplate}`;
  }

  const response = await octokit.search.repos({
    q,
    sort: options.sort === "best-match" ? undefined : options.sort,
    order: options.order ?? "desc",
    per_page: options.perPage ?? 20,
    page: options.page ?? 1,
  });

  return {
    totalCount: response.data.total_count,
    items: response.data.items.map((item) => ({
      id: item.id,
      fullName: item.full_name,
      description: item.description,
      htmlUrl: item.html_url,
      stargazersCount: item.stargazers_count,
      forksCount: item.forks_count,
      language: item.language ?? null,
      topics: item.topics ?? [],
      isTemplate: item.is_template ?? false,
      updatedAt: item.updated_at,
      owner: {
        login: item.owner.login,
        avatarUrl: item.owner.avatar_url,
      },
    })),
  };
}

export async function listRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<TreeEntry[]> {
  const treeSha = ref ?? "HEAD";
  const response = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "1",
  });

  return (response.data.tree as Array<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>).map((entry) => ({
    path: entry.path ?? "",
    mode: entry.mode ?? "",
    type: entry.type ?? "",
    sha: entry.sha ?? "",
    size: entry.size,
  }));
}

export async function readFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  ref?: string,
): Promise<FileContent> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref,
  });

  const data = response.data as {
    path: string;
    sha: string;
    size: number;
    encoding: string;
    content: string;
  };

  const content = Buffer.from(data.content, "base64").toString("utf-8");

  return {
    path: data.path,
    content,
    sha: data.sha,
    size: data.size,
    encoding: data.encoding,
  };
}

export async function searchCode(
  octokit: Octokit,
  query: string,
  options?: CodeSearchOptions,
): Promise<{ totalCount: number; items: CodeSearchResult[] }> {
  const response = await octokit.search.code({
    q: query,
    sort: options?.sort,
    order: options?.order ?? "desc",
    per_page: options?.perPage ?? 20,
    page: options?.page ?? 1,
    headers: {
      accept: "application/vnd.github.text-match+json",
    },
  });

  return {
    totalCount: response.data.total_count,
    items: response.data.items.map((item) => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      htmlUrl: item.html_url,
      repository: {
        fullName: item.repository.full_name,
        description: item.repository.description ?? null,
        htmlUrl: item.repository.html_url,
      },
      textMatches: (item.text_matches as Array<{
        fragment: string;
        matches: Array<{ text: string; indices: number[] }>;
      }> | undefined)?.map((match) => ({
        fragment: match.fragment,
        matches: match.matches.map((m) => ({
          text: m.text,
          indices: m.indices,
        })),
      })),
    })),
  };
}

export function cloneRepository(options: CloneOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["clone"];

    if (options.branch) {
      args.push("--branch", options.branch);
    }
    if (options.depth) {
      args.push("--depth", String(options.depth));
    }

    args.push("--progress", options.url, options.targetDir);

    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      options.onProgress?.(text);
    });

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      options.onProgress?.(text);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git clone exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
