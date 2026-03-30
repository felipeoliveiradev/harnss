import { ipcMain } from "electron";
import { multiAiSearch } from "../lib/multi-ai-search";
import { getAppSetting } from "../lib/app-settings";
import { reportError } from "../lib/error-utils";

export function register(): void {
  ipcMain.handle("multi-ai:search", async (_event, options: { query: string; models?: string[]; useMoltbook?: boolean; cacheTtlHours?: number }) => {
    try {
      const openRouterApiKey = getAppSetting("openRouterApiKey") || "";
      const moltbookApiKey = getAppSetting("moltbookApiKey") || "";
      return await multiAiSearch({ ...options, openRouterApiKey, moltbookApiKey });
    } catch (err) {
      throw new Error(reportError("multi-ai:search", err));
    }
  });
}
