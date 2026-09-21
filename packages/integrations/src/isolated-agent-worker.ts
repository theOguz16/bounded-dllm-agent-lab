import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentProcessControl } from "./agent-process-control.js";

export const ISOLATED_AGENT_WORKER_VERSION = "isolated-agent-worker/v1" as const;
export const DEFAULT_AGENT_WORKER_GRACE_MS = 1_500;
export const DEFAULT_AGENT_WORKER_FORCE_GRACE_MS = 1_500;

export type WorkerTerminationSignal = "SIGTERM" | "SIGKILL";

export type IsolatedAgentWorkerResult = Readonly<{
  version: typeof ISOLATED_AGENT_WORKER_VERSION;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderr: string;
  terminationConfirmed: boolean;
}>;

type KillProcessGroup = (child: ChildProcessWithoutNullStreams, signal: WorkerTerminationSignal) => boolean;

export type IsolatedAgentWorkerInput = Readonly<{
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  processControl: AgentProcessControl;
  onStdoutLine?: (line: string) => void;
  graceMs?: number;
  forceGraceMs?: number;
  /** Deterministic fake-hang tests may inject a non-killing terminator. */
  killProcessGroup?: KillProcessGroup;
}>;

function positiveMs(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return resolved;
}

function defaultKillProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: WorkerTerminationSignal
): boolean {
  if (child.pid === undefined) return false;
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      // The worker is spawned detached, therefore -pid targets only its process group.
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
}

function safeCallback(callback: (() => void) | undefined): void {
  if (!callback) return;
  try { callback(); } catch {
    // Process-control failures abort the worker through the shared AbortSignal.
  }
}

export async function runIsolatedAgentWorker(
  input: IsolatedAgentWorkerInput
): Promise<IsolatedAgentWorkerResult> {
  const graceMs = positiveMs(input.graceMs, DEFAULT_AGENT_WORKER_GRACE_MS, "graceMs");
  const forceGraceMs = positiveMs(
    input.forceGraceMs,
    DEFAULT_AGENT_WORKER_FORCE_GRACE_MS,
    "forceGraceMs"
  );
  const killProcessGroup = input.killProcessGroup ?? defaultKillProcessGroup;
  const detached = process.platform === "linux" || process.platform === "darwin";
  const child = spawn(input.command, [...(input.args ?? [])], {
    cwd: input.cwd,
    env: input.env,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stderr = "";
  let stdoutRemainder = "";
  let graceTimer: NodeJS.Timeout | null = null;
  let forceTimer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  const clearTimers = (): void => {
    if (graceTimer) clearTimeout(graceTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (settleTimer) clearTimeout(settleTimer);
    graceTimer = null;
    forceTimer = null;
    settleTimer = null;
  };

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    exitSignal = signal;
    input.processControl.markWorkerExited(signal);
    clearTimers();
    settle();
  };

  child.once("exit", finish);
  child.once("error", () => {
    if (!exited) {
      input.processControl.markWorkerTerminationFailed("Isolated agent worker failed to start or report an exit.");
      clearTimers();
      settle();
    }
  });

  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    safeCallback(() => input.processControl.observeStdout(text));
    stdoutRemainder += text;
    for (;;) {
      const newline = stdoutRemainder.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutRemainder.slice(0, newline);
      stdoutRemainder = stdoutRemainder.slice(newline + 1);
      if (line.length > 0) safeCallback(() => input.onStdoutLine?.(line));
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    safeCallback(() => input.processControl.observeStderr(text));
    if (stderr.length < input.processControl.limits.maxStderrBytes) stderr += text;
  });

  const forceKill = (): void => {
    if (exited) return;
    input.processControl.markForcedTermination();
    killProcessGroup(child, "SIGKILL");
    forceTimer = setTimeout(() => {
      if (exited) return;
      input.processControl.markWorkerTerminationFailed();
      // Fail closed and return control to orchestration. Callers must not start another arm/task.
      settle();
    }, forceGraceMs);
  };

  const requestTermination = (): void => {
    if (exited || graceTimer || forceTimer) return;
    input.processControl.markAbortRequested();
    killProcessGroup(child, "SIGTERM");
    graceTimer = setTimeout(forceKill, graceMs);
  };

  input.processControl.signal.addEventListener("abort", requestTermination, { once: true });
  if (input.processControl.signal.aborted) requestTermination();

  child.stdin.end(input.stdin, "utf8");
  await settled;
  input.processControl.signal.removeEventListener("abort", requestTermination);
  clearTimers();

  if (stdoutRemainder.length > 0) safeCallback(() => input.onStdoutLine?.(stdoutRemainder));

  return Object.freeze({
    version: ISOLATED_AGENT_WORKER_VERSION,
    exitCode,
    exitSignal,
    stderr,
    terminationConfirmed: exited
  });
}
