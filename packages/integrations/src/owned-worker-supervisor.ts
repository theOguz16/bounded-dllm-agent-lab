import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const OWNED_WORKER_SUPERVISOR_VERSION = "owned-worker-supervisor/v1" as const;

export type OwnedWorkerTimeline = Readonly<{
  deadlineAt: string;
  abortRequestedAt: string | null;
  exitedAt: string | null;
}>;

export type OwnedWorkerResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeline: OwnedWorkerTimeline;
}>;

export type OwnedWorkerSupervisor = Readonly<{
  run(command: string, args: readonly string[], options: Readonly<{
    timeoutMs: number;
    graceMs: number;
    spawnOptions?: SpawnOptions;
  }>): Promise<OwnedWorkerResult>;
  shutdown(): void;
  isShutdown(): boolean;
}>;

export function createOwnedWorkerSupervisor(dependencies: Readonly<{
  now?: () => Date;
  spawnChild?: typeof spawn;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
}> = {}): OwnedWorkerSupervisor {
  const now = dependencies.now ?? (() => new Date());
  const spawnChild = dependencies.spawnChild ?? spawn;
  const killGroup = dependencies.killGroup ?? ((pid, signal) => process.kill(-pid, signal));
  let shutdown = false;
  let active: ChildProcess | null = null;

  return Object.freeze({
    async run(command, args, options) {
      if (shutdown) throw new Error("Worker supervisor is shut down; no later invocation is allowed.");
      if (active !== null) throw new Error("Worker supervisor already owns an active child.");
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
          !Number.isSafeInteger(options.graceMs) || options.graceMs < 0) {
        throw new TypeError("timeoutMs must be positive and graceMs must be non-negative safe integers.");
      }
      const startedMs = now().getTime();
      const deadlineAt = new Date(startedMs + options.timeoutMs).toISOString();
      let abortRequestedAt: string | null = null;
      let exitedAt: string | null = null;
      const child = spawnChild(command, [...args], {
        ...options.spawnOptions,
        detached: process.platform !== "win32"
      });
      active = child;
      if (child.pid == null) {
        active = null;
        throw new Error("Owned child did not expose a process id.");
      }
      const ownedPid = child.pid;

      return await new Promise<OwnedWorkerResult>((resolvePromise, rejectPromise) => {
        let killTimer: NodeJS.Timeout | null = null;
        const deadlineTimer = setTimeout(() => {
          abortRequestedAt = now().toISOString();
          try { killGroup(ownedPid, "SIGTERM"); } catch { /* child may already be exiting */ }
          killTimer = setTimeout(() => {
            if (active === child) {
              try { killGroup(ownedPid, "SIGKILL"); } catch { /* already exited */ }
            }
          }, options.graceMs);
        }, options.timeoutMs);

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
          clearTimeout(deadlineTimer);
          if (killTimer !== null) clearTimeout(killTimer);
          exitedAt = now().toISOString();
          active = null;
          resolvePromise(Object.freeze({ exitCode, signal, timeline: Object.freeze({ deadlineAt, abortRequestedAt, exitedAt }) }));
        };
        child.once("exit", finish);
        child.once("error", (error) => {
          clearTimeout(deadlineTimer);
          if (killTimer !== null) clearTimeout(killTimer);
          active = null;
          rejectPromise(error);
        });
      });
    },
    shutdown() {
      shutdown = true;
      if (active?.pid != null) {
        try { killGroup(active.pid, "SIGTERM"); } catch { /* already exited */ }
      }
    },
    isShutdown() { return shutdown; }
  });
}
