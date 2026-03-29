import { useCallback, useEffect, useRef, useState } from "react";

export interface ExecutionEntry {
  id: string;
  label: string;
  command: string;
  output: string;
  exitCode: number | null;
  startedAt: Date;
}

export interface DetectedRunner {
  source: string;
  scripts: Record<string, string>;
}

export function useExecutions(cwd?: string) {
  const [runners, setRunners] = useState<DetectedRunner[]>([]);
  const [executions, setExecutions] = useState<Map<string, ExecutionEntry>>(new Map());
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const executionsRef = useRef(executions);
  executionsRef.current = executions;

  const detectRunners = useCallback(async (dir: string) => {
    if (!window.claude?.executions) return;
    const result = await window.claude.executions.detectRunners(dir);
    if (result.runners) setRunners(result.runners);
  }, []);

  useEffect(() => {
    if (cwd) detectRunners(cwd);
  }, [cwd, detectRunners]);

  const runCommand = useCallback(async (dir: string, command: string, label?: string) => {
    if (!window.claude?.executions) return { error: "Not available" };
    const result = await window.claude.executions.run({ cwd: dir, command, label });
    if (result.executionId) {
      const entry: ExecutionEntry = {
        id: result.executionId,
        label: label || command,
        command,
        output: "",
        exitCode: null,
        startedAt: new Date(),
      };
      setExecutions((prev) => {
        const next = new Map(prev);
        next.set(result.executionId!, entry);
        return next;
      });
      setActiveExecutionId(result.executionId);
    }
    return result;
  }, []);

  const stopExecution = useCallback(async (id: string) => {
    if (!window.claude?.executions) return;
    await window.claude.executions.stop(id);
  }, []);

  const clearExecution = useCallback((id: string) => {
    setExecutions((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setActiveExecutionId((prev) => (prev === id ? null : prev));
  }, []);

  useEffect(() => {
    if (!window.claude?.executions) return;

    const unsubData = window.claude.executions.onData((data: { executionId: string; data: string }) => {
      setExecutions((prev) => {
        const entry = prev.get(data.executionId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(data.executionId, { ...entry, output: entry.output + data.data });
        return next;
      });
    });

    const unsubExit = window.claude.executions.onExit((data: { executionId: string; exitCode: number }) => {
      setExecutions((prev) => {
        const entry = prev.get(data.executionId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(data.executionId, { ...entry, exitCode: data.exitCode });
        return next;
      });
    });

    return () => { unsubData(); unsubExit(); };
  }, []);

  return {
    runners,
    executions,
    activeExecutionId,
    setActiveExecutionId,
    detectRunners,
    runCommand,
    stopExecution,
    clearExecution,
  };
}
