import { ipcMain } from "electron";
import { log } from "../lib/logger";

const SKILLS_API = "https://skills.sh/api/search";

export function register(): void {
  ipcMain.handle("skills-registry:search", async (_event, query?: string, limit = 50) => {
    try {
      const url = new URL(SKILLS_API);
      if (query) url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: "application/json" },
      });

      if (!response.ok) return { ok: false, skills: [], error: `HTTP ${response.status}` };

      const data = (await response.json()) as {
        query: string;
        searchType: string;
        skills: Array<{ id: string; skillId: string; name: string; installs: number; source: string }>;
        count: number;
      };

      return {
        ok: true,
        skills: data.skills,
        count: data.count,
        query: data.query,
      };
    } catch (err) {
      log("SKILLS_REGISTRY", `search failed: ${(err as Error).message}`);
      return { ok: false, skills: [], error: (err as Error).message };
    }
  });
}
