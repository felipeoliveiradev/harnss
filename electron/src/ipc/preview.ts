import { ipcMain } from "electron"
import { readFileSync } from "fs"
import { join, isAbsolute, normalize } from "path"
import { log } from "../lib/logger"
import { reportError } from "../lib/error-utils"
import {
  startServer,
  stopServer,
  getServerStatus,
  detectProjectType,
} from "../lib/preview-server"

export function register(): void {
  ipcMain.handle("preview:detect", (_event, cwd: string) => {
    try {
      return detectProjectType(cwd)
    } catch (err) {
      const errMsg = reportError("PREVIEW_DETECT", err)
      return { type: "unknown" as const, error: errMsg }
    }
  })

  ipcMain.handle("preview:start", async (_event, { sessionId, cwd }: { sessionId: string; cwd: string }) => {
    try {
      log("PREVIEW", `Starting dev server for session ${sessionId.slice(0, 8)} cwd=${cwd}`)
      const result = await startServer(sessionId, cwd)
      log("PREVIEW", `Server running on port ${result.port} pid=${result.pid} type=${result.type}`)
      return result
    } catch (err) {
      const errMsg = reportError("PREVIEW_START", err)
      return { error: errMsg }
    }
  })

  ipcMain.handle("preview:stop", (_event, sessionId: string) => {
    try {
      stopServer(sessionId)
      log("PREVIEW", `Stopped server for session ${sessionId.slice(0, 8)}`)
      return { ok: true }
    } catch (err) {
      const errMsg = reportError("PREVIEW_STOP", err)
      return { error: errMsg }
    }
  })

  ipcMain.handle("preview:status", (_event, sessionId: string) => {
    return getServerStatus(sessionId)
  })

  ipcMain.handle("preview:read-html", (_event, { cwd, filePath }: { cwd: string; filePath: string }) => {
    try {
      const resolved = isAbsolute(filePath) ? normalize(filePath) : normalize(join(cwd, filePath))
      if (!resolved.startsWith(normalize(cwd))) {
        return { error: "Path traversal not allowed" }
      }
      const content = readFileSync(resolved, "utf-8")
      return { content }
    } catch (err) {
      const errMsg = reportError("PREVIEW_READ_HTML", err)
      return { error: errMsg }
    }
  })
}
