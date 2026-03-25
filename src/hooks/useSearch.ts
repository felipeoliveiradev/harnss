import { useCallback, useEffect, useRef, useState } from "react";

export interface FileSearchResult {
  path: string;
  name: string;
  dir: string;
  score: number;
}

export interface ContentSearchResult {
  file: string;
  line: number;
  column: number;
  match: string;
  preview: string;
}

export function useSearch(cwd?: string) {
  const [mode, setMode] = useState<"files" | "content" | "folders">("files");
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
  const [totalContentCount, setTotalContentCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const doSearch = useCallback(async (dir: string, q: string) => {
    if (!q.trim()) {
      setFileResults([]);
      setContentResults([]);
      setTotalContentCount(0);
      return;
    }
    if (!window.claude?.search) return;
    setIsSearching(true);
    try {
      if (mode === "files" || mode === "folders") {
        const result = await window.claude.search.files({ cwd: dir, query: q });
        if (queryRef.current === q) {
          let filtered = result.results || [];
          if (mode === "folders") {
            const seen = new Set<string>();
            filtered = filtered.filter((r) => {
              if (!r.dir || seen.has(r.dir)) return false;
              seen.add(r.dir);
              return true;
            });
          }
          setFileResults(filtered);
        }
      } else {
        const result = await window.claude.search.content({
          cwd: dir,
          pattern: q,
          isRegex,
          caseSensitive,
          include: include || undefined,
          exclude: exclude || undefined,
        });
        if (queryRef.current === q) {
          setContentResults(result.results || []);
          setTotalContentCount(result.totalCount || 0);
        }
      }
    } finally {
      setIsSearching(false);
    }
  }, [mode, isRegex, caseSensitive, include, exclude]);

  useEffect(() => {
    if (!cwd || !query.trim()) {
      setFileResults([]);
      setContentResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(cwd, query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [cwd, query, doSearch]);

  const toggleRegex = useCallback(() => setIsRegex((p) => !p), []);
  const toggleCaseSensitive = useCallback(() => setCaseSensitive((p) => !p), []);

  return {
    mode, setMode,
    query, setQuery,
    isRegex, toggleRegex,
    caseSensitive, toggleCaseSensitive,
    include, setInclude,
    exclude, setExclude,
    fileResults,
    contentResults,
    totalContentCount,
    isSearching,
  };
}
