import { ChildProcess, spawn } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import net from "net"

type ProjectType = "vite" | "nextjs" | "html" | "unknown"
type ServerStatus = "starting" | "running" | "stopped" | "error"

interface PreviewServer {
  process: ChildProcess
  port: number
  status: ServerStatus
  cwd: string
}

const servers = new Map<string, PreviewServer>()

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

function detectProjectType(cwd: string): { type: ProjectType; entryFile?: string } {
  for (const ext of ["ts", "js", "mts", "mjs"]) {
    if (existsSync(join(cwd, `vite.config.${ext}`))) return { type: "vite" }
  }
  for (const ext of ["ts", "js", "mjs"]) {
    if (existsSync(join(cwd, `next.config.${ext}`))) return { type: "nextjs" }
  }
  const pkgPath = join(cwd, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (allDeps?.vite) return { type: "vite" }
      if (allDeps?.next) return { type: "nextjs" }
    } catch {}
  }
  if (existsSync(join(cwd, "index.html"))) return { type: "html", entryFile: "index.html" }
  return { type: "unknown" }
}

function detectPackageManager(cwd: string): "pnpm" | "yarn" | "npx" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn"
  return "npx"
}

async function waitForPort(port: number, timeout: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1")
        socket.on("connect", () => { socket.destroy(); resolve() })
        socket.on("error", reject)
      })
      return
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error(`Server did not start within ${timeout}ms`)
}

async function startServer(sessionId: string, cwd: string): Promise<{ port: number; pid: number; type: ProjectType }> {
  const existing = servers.get(sessionId)
  if (existing && existing.status === "running") {
    return { port: existing.port, pid: existing.process.pid!, type: detectProjectType(cwd).type }
  }

  const port = await findFreePort()
  const detection = detectProjectType(cwd)
  const pm = detectPackageManager(cwd)

  let cmd: string
  let args: string[]

  switch (detection.type) {
    case "vite":
      cmd = pm === "npx" ? "npx" : pm
      args = pm === "npx"
        ? ["vite", "--port", String(port), "--host"]
        : ["vite", "--port", String(port), "--host"]
      break
    case "nextjs":
      cmd = pm === "npx" ? "npx" : pm
      args = ["next", "dev", "--port", String(port)]
      break
    case "html":
      cmd = "npx"
      args = ["serve", "-l", String(port), "-s", cwd]
      break
    default:
      cmd = "npx"
      args = ["serve", "-l", String(port), "-s", cwd]
  }

  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, BROWSER: "none", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  })

  const server: PreviewServer = {
    process: child,
    port,
    status: "starting",
    cwd,
  }
  servers.set(sessionId, server)

  child.on("exit", () => {
    server.status = "stopped"
  })

  child.on("error", () => {
    server.status = "error"
  })

  await waitForPort(port, 30000)
  server.status = "running"

  return { port, pid: child.pid!, type: detection.type }
}

function stopServer(sessionId: string): void {
  const server = servers.get(sessionId)
  if (!server) return
  try { server.process.kill() } catch {}
  servers.delete(sessionId)
}

function getServerStatus(sessionId: string): { status: ServerStatus; port?: number } | null {
  const server = servers.get(sessionId)
  if (!server) return null
  return { status: server.status, port: server.port }
}

function stopAllServers(): void {
  for (const [id] of servers) {
    stopServer(id)
  }
}

export { startServer, stopServer, getServerStatus, stopAllServers, detectProjectType }
export type { ProjectType, ServerStatus }
