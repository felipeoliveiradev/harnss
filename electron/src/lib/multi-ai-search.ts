import path from "path";
import crypto from "crypto";
import fs from "fs";
import { app } from "electron";
import { log } from "./logger";

interface ModelResponse {
  model: string;
  answer: string;
  latencyMs: number;
  error?: string;
}

interface MoltbookReply {
  agentName: string;
  content: string;
  karma: number;
}

interface MultiAIResult {
  query: string;
  responses: ModelResponse[];
  moltbookReplies?: MoltbookReply[];
  fromCache: boolean;
  cachedAt?: number;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MOLTBOOK_BASE = "https://www.moltbook.com/api/v1";

const DEFAULT_MODELS = [
  "anthropic/claude-3-5-sonnet",
  "openai/gpt-4o",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.3-70b-instruct:free",
];

const cacheDir = () =>
  path.join(app.getPath("userData"), "openacpui-data", "multi-ai-cache");

function queryHash(query: string, models: string[]): string {
  return crypto
    .createHash("sha256")
    .update(query + JSON.stringify(models.sort()))
    .digest("hex")
    .slice(0, 16);
}

function getCachedResult(
  hash: string,
  ttlHours: number
): MultiAIResult | null {
  const cachePath = path.join(cacheDir(), `${hash}.json`);
  try {
    if (!fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (Date.now() - data.cachedAt > ttlHours * 3600000) return null;
    return { ...data, fromCache: true };
  } catch {
    return null;
  }
}

function setCachedResult(hash: string, result: MultiAIResult): void {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${hash}.json`),
    JSON.stringify({ ...result, cachedAt: Date.now() }),
    "utf-8"
  );
}

async function queryOpenRouter(
  query: string,
  model: string,
  apiKey: string
): Promise<ModelResponse> {
  const start = Date.now();
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/OpenSource03/harnss",
        "X-Title": "Harnss Research",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: query }],
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return {
      model,
      answer: data.choices?.[0]?.message?.content ?? "(no response)",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      model,
      answer: "",
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

async function postToMoltbook(
  query: string,
  apiKey: string
): Promise<MoltbookReply[]> {
  try {
    const postRes = await fetch(`${MOLTBOOK_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        submolt: "research",
        title: `[Research] ${query.slice(0, 100)}`,
        content: query,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const post = await postRes.json();

    await new Promise((r) => setTimeout(r, 30000));

    const repliesRes = await fetch(
      `${MOLTBOOK_BASE}/posts/${post.id}/comments`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      }
    );
    const replies = await repliesRes.json();
    return (replies.comments ?? []).map(
      (c: Record<string, unknown>) => ({
        agentName:
          (c.agent as Record<string, unknown>)?.name ?? "unknown",
        content: String(c.content),
        karma: Number(c.karma ?? 0),
      })
    );
  } catch (err) {
    log("MOLTBOOK", `post failed: ${(err as Error).message}`);
    return [];
  }
}

export async function multiAiSearch(options: {
  query: string;
  models?: string[];
  useMoltbook?: boolean;
  cacheTtlHours?: number;
  openRouterApiKey: string;
  moltbookApiKey?: string;
}): Promise<MultiAIResult> {
  const {
    query,
    models = DEFAULT_MODELS,
    useMoltbook = false,
    cacheTtlHours = 24,
    openRouterApiKey,
    moltbookApiKey,
  } = options;
  const hash = queryHash(query, models);

  const cached = getCachedResult(hash, cacheTtlHours);
  if (cached) {
    log("MULTI_AI", `cache hit for "${query.slice(0, 50)}..."`);
    return cached;
  }

  log(
    "MULTI_AI",
    `querying ${models.length} models for "${query.slice(0, 50)}..."`
  );

  const [modelResponses, moltbookReplies] = await Promise.all([
    Promise.all(
      models.map((m) => queryOpenRouter(query, m, openRouterApiKey))
    ),
    useMoltbook && moltbookApiKey
      ? postToMoltbook(query, moltbookApiKey)
      : Promise.resolve(undefined),
  ]);

  const result: MultiAIResult = {
    query,
    responses: modelResponses,
    moltbookReplies: moltbookReplies ?? undefined,
    fromCache: false,
  };
  setCachedResult(hash, result);

  log(
    "MULTI_AI",
    `completed: ${modelResponses.filter((r) => !r.error).length}/${models.length} models responded`
  );
  return result;
}

export type { MultiAIResult, ModelResponse, MoltbookReply };
