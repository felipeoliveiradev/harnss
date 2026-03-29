export interface QuickOpenMatch {
  path: string;
  score: number;
}

export interface ParsedQuickOpenQuery {
  query: string;
  line?: number;
}

/**
 * Accepts VS Code-like "path:line" while preserving Windows-style paths in this app
 * (relative project paths use forward slashes, so trailing :number is safe to parse).
 */
export function parseQuickOpenQuery(raw: string): ParsedQuickOpenQuery {
  const value = raw.trim();
  const lineMatch = value.match(/^(.*?):(\d+)$/);
  if (!lineMatch) return { query: value };

  const lineValue = Number(lineMatch[2]);
  if (!Number.isFinite(lineValue) || lineValue < 1) return { query: value };
  return { query: lineMatch[1], line: Math.floor(lineValue) };
}

function scorePath(path: string, query: string): number {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;

  const lastSegment = p.split("/").pop() ?? p;
  if (lastSegment === q) return 4000 - p.length;
  if (lastSegment.startsWith(q)) return 3200 - p.length;
  if (p.startsWith(q)) return 2600 - p.length;

  const contiguous = p.indexOf(q);
  if (contiguous >= 0) {
    const basenameBoost = lastSegment.includes(q) ? 500 : 0;
    return 2200 - contiguous * 3 - p.length + basenameBoost;
  }

  // Fuzzy subsequence fallback ("prfl" -> "project/files/list.ts")
  let qi = 0;
  let penalty = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) {
      qi += 1;
    } else {
      penalty += 1;
    }
  }
  if (qi !== q.length) return Number.NEGATIVE_INFINITY;

  return 1500 - penalty - p.length;
}

export function rankQuickOpenMatches(files: string[], rawQuery: string, limit = 200): QuickOpenMatch[] {
  const parsed = parseQuickOpenQuery(rawQuery);
  const q = parsed.query.trim();
  if (!q) {
    return files.slice(0, limit).map((path) => ({ path, score: 0 }));
  }

  const scored = files
    .map((path) => ({ path, score: scorePath(path, q) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
    .slice(0, limit);

  return scored;
}
