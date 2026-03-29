import { ipcMain, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { reportError } from "../lib/error-utils";

interface Execution {
  id: string;
  process: ChildProcess;
  command: string;
  label: string;
  startedAt: number;
}

interface DetectedRunner {
  source: string;
  scripts: Record<string, string>;
}

const executions = new Map<string, Execution>();
let nextId = 1;

function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, data);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageJson(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "package.json");
  if (!(await fileExists(filePath))) return null;
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) return null;
    const scripts: Record<string, string> = {};
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      scripts[name] = `npm run ${name}`;
    }
    return { source: "package.json", scripts };
  } catch {
    return null;
  }
}

async function detectMakefile(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "Makefile");
  if (!(await fileExists(filePath))) return null;
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const scripts: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
      if (match && !match[1].startsWith(".") && !match[1].startsWith("_")) {
        scripts[match[1]] = `make ${match[1]}`;
      }
    }
    if (Object.keys(scripts).length === 0) return null;
    return { source: "Makefile", scripts };
  } catch {
    return null;
  }
}

async function detectComposerJson(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "composer.json");
  if (!(await fileExists(filePath))) return null;
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const composer = JSON.parse(raw);
    const scripts: Record<string, string> = {};
    if (composer.scripts) {
      for (const name of Object.keys(composer.scripts)) {
        scripts[name] = `composer run ${name}`;
      }
    }
    const artisanPath = path.join(cwd, "artisan");
    if (await fileExists(artisanPath)) {
      scripts["serve"] = "php artisan serve";
      scripts["migrate"] = "php artisan migrate";
      scripts["migrate:fresh"] = "php artisan migrate:fresh";
      scripts["tinker"] = "php artisan tinker";
      scripts["test"] = "php artisan test";
      scripts["queue:work"] = "php artisan queue:work";
      scripts["cache:clear"] = "php artisan cache:clear";
    }
    if (Object.keys(scripts).length === 0) return null;
    return { source: "composer.json (Laravel)", scripts };
  } catch {
    return null;
  }
}

async function detectCargoToml(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "Cargo.toml");
  if (!(await fileExists(filePath))) return null;
  return {
    source: "Cargo.toml",
    scripts: {
      build: "cargo build",
      run: "cargo run",
      test: "cargo test",
      check: "cargo check",
      clippy: "cargo clippy",
      fmt: "cargo fmt",
      "build --release": "cargo build --release",
    },
  };
}

async function detectPyproject(cwd: string): Promise<DetectedRunner | null> {
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  const setupPath = path.join(cwd, "setup.py");
  const managePath = path.join(cwd, "manage.py");
  const hasPyproject = await fileExists(pyprojectPath);
  const hasSetup = await fileExists(setupPath);
  const hasManage = await fileExists(managePath);
  if (!hasPyproject && !hasSetup && !hasManage) return null;

  const scripts: Record<string, string> = {};

  if (hasManage) {
    scripts["runserver"] = "python manage.py runserver";
    scripts["migrate"] = "python manage.py migrate";
    scripts["makemigrations"] = "python manage.py makemigrations";
    scripts["shell"] = "python manage.py shell";
    scripts["test"] = "python manage.py test";
    scripts["collectstatic"] = "python manage.py collectstatic";
  }

  if (hasPyproject) {
    try {
      const raw = await fs.promises.readFile(pyprojectPath, "utf-8");
      if (raw.includes("[tool.poetry]")) {
        scripts["install"] = "poetry install";
        scripts["run"] = "poetry run python -m app";
        scripts["test"] = "poetry run pytest";
      } else {
        scripts["install"] = "pip install -e .";
        scripts["test"] = "pytest";
      }
    } catch { /* skip */ }
  }

  if (Object.keys(scripts).length === 0) return null;
  return { source: hasManage ? "Django" : "Python", scripts };
}

async function detectGoMod(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "go.mod");
  if (!(await fileExists(filePath))) return null;
  return {
    source: "go.mod",
    scripts: {
      build: "go build ./...",
      run: "go run .",
      test: "go test ./...",
      vet: "go vet ./...",
      fmt: "go fmt ./...",
      tidy: "go mod tidy",
    },
  };
}

async function detectGemfile(cwd: string): Promise<DetectedRunner | null> {
  const filePath = path.join(cwd, "Gemfile");
  if (!(await fileExists(filePath))) return null;
  const rakePath = path.join(cwd, "Rakefile");
  const hasRake = await fileExists(rakePath);
  const scripts: Record<string, string> = {
    install: "bundle install",
  };
  if (hasRake) {
    scripts["default"] = "bundle exec rake";
    scripts["test"] = "bundle exec rake test";
  }
  const binRailsPath = path.join(cwd, "bin", "rails");
  if (await fileExists(binRailsPath)) {
    scripts["server"] = "bin/rails server";
    scripts["console"] = "bin/rails console";
    scripts["migrate"] = "bin/rails db:migrate";
    scripts["test"] = "bin/rails test";
  }
  return { source: "Ruby/Rails", scripts };
}

export function register(): void {
  ipcMain.handle(
    "executions:detect-runners",
    async (_event, cwd: string) => {
      try {
        const detectors = [
          detectPackageJson,
          detectMakefile,
          detectComposerJson,
          detectCargoToml,
          detectPyproject,
          detectGoMod,
          detectGemfile,
        ];
        const results = await Promise.all(detectors.map((fn) => fn(cwd)));
        const runners = results.filter((r): r is DetectedRunner => r !== null);
        return { runners };
      } catch (err) {
        return { runners: [], error: reportError("EXEC_DETECT", err) };
      }
    },
  );

  ipcMain.handle(
    "executions:run",
    async (
      _event,
      { cwd, command, label }: { cwd: string; command: string; label?: string },
    ) => {
      try {
        const id = `exec-${nextId++}`;
        const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
        const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

        const child = spawn(shell, shellArgs, {
          cwd,
          env: { ...process.env, FORCE_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const execution: Execution = {
          id,
          process: child,
          command,
          label: label || command,
          startedAt: Date.now(),
        };
        executions.set(id, execution);

        child.stdout?.on("data", (data: Buffer) => {
          broadcast("executions:data", { executionId: id, data: data.toString() });
        });

        child.stderr?.on("data", (data: Buffer) => {
          broadcast("executions:data", { executionId: id, data: data.toString() });
        });

        child.on("exit", (code) => {
          broadcast("executions:exit", { executionId: id, exitCode: code ?? 1 });
          executions.delete(id);
        });

        child.on("error", (err) => {
          broadcast("executions:data", {
            executionId: id,
            data: `\x1b[31mError: ${err.message}\x1b[0m\n`,
          });
          broadcast("executions:exit", { executionId: id, exitCode: 1 });
          executions.delete(id);
        });

        return { executionId: id };
      } catch (err) {
        return { error: reportError("EXEC_RUN", err) };
      }
    },
  );

  ipcMain.handle("executions:stop", async (_event, executionId: string) => {
    const execution = executions.get(executionId);
    if (!execution) return { error: "Execution not found" };
    try {
      execution.process.kill("SIGTERM");
      setTimeout(() => {
        if (executions.has(executionId)) {
          execution.process.kill("SIGKILL");
        }
      }, 3000);
      return { ok: true };
    } catch (err) {
      return { error: reportError("EXEC_STOP", err) };
    }
  });
}
