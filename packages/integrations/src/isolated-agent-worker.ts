import { fork, spawnSync, type ChildProcess } from "node:child_process";

export const AGENT_WORKER_GRACE_MS = 750;
export const AGENT_WORKER_KILL_GRACE_MS = 750;

export type AgentWorkerLifecycle = Readonly<{
  deadlineTriggeredAt: number | null;
  abortRequestedAt: number | null;
  workerExitedAt: number | null;
  exitSignal: NodeJS.Signals | null;
  forcedTermination: boolean;
  workerTerminationVerified: boolean;
}>;

export type IsolatedAgentWorkerResult = Readonly<{
  completed: boolean;
  failureCode: string | null;
  lifecycle: AgentWorkerLifecycle;
}>;

export type IsolatedAgentWorkerInput = Readonly<{
  workerPath: string;
  payload: unknown;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  deadlineTriggeredAt?: () => number | null;
  onEvent: (value: unknown) => void;
  graceMs?: number;
  killGraceMs?: number;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A new POSIX session is created for EVERY invocation. Never signal a repository PID. */
function liveMembers(pgid: number): boolean | null {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return null;
  }
  const inspected = spawnSync("ps", ["-eo", "pgid=,stat="], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 4 * 1024 * 1024
  });
  if (inspected.error || inspected.status !== 0) return null;
  return String(inspected.stdout).split(/\r?\n/).some((line) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    return match !== null && Number(match[1]) === pgid && !match[2]!.startsWith("Z");
  });
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** The caller must NOT invoke another arm until this promise resolves with verified=true. */
export function runIsolatedAgentWorker(input: IsolatedAgentWorkerInput): Promise<IsolatedAgentWorkerResult> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return Promise.resolve(Object.freeze({ completed: false, failureCode: "worker_termination_failed",
      lifecycle: Object.freeze({ deadlineTriggeredAt: null, abortRequestedAt: null,
        workerExitedAt: null, exitSignal: null, forcedTermination: false,
        workerTerminationVerified: false }) }));
  }
  if (input.signal.aborted) {
    return Promise.resolve(Object.freeze({ completed: false, failureCode: "provider_outcome_ambiguous",
      lifecycle: Object.freeze({ deadlineTriggeredAt: input.deadlineTriggeredAt?.() ?? null,
        abortRequestedAt: Date.now(), workerExitedAt: null, exitSignal: null,
        forcedTermination: false, workerTerminationVerified: true }) }));
  }
  const graceMs = input.graceMs ?? AGENT_WORKER_GRACE_MS;
  const killGraceMs = input.killGraceMs ?? AGENT_WORKER_KILL_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 5_000 ||
      !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 5_000) {
    throw new TypeError("Worker grace limits must be bounded positive integers.");
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    let exited = false;
    let completed = false;
    let failureCode: string | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let workerExitedAt: number | null = null;
    let abortRequestedAt: number | null = null;
    let forcedTermination = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const snapshot = (verified: boolean): AgentWorkerLifecycle => Object.freeze({
      deadlineTriggeredAt: input.deadlineTriggeredAt?.() ?? null,
      abortRequestedAt, workerExitedAt, exitSignal, forcedTermination,
      workerTerminationVerified: verified
    });
    const settle = (verified: boolean): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      for (const timer of timers) clearTimeout(timer);
      try { child.disconnect?.(); } catch { /* already disconnected */ }
      if (!verified) child.unref();
      resolve(Object.freeze({
        completed: verified && completed && exitCode === 0 && abortRequestedAt === null && failureCode === null,
        failureCode: !verified ? "worker_termination_failed" : abortRequestedAt !== null
          ? "provider_outcome_ambiguous" : failureCode ??
            (completed && exitCode === 0 ? null : "provider_outcome_ambiguous"),
        lifecycle: snapshot(verified)
      }));
    };
    const groupPid = (): number | null => typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
    const terminate = (signal: NodeJS.Signals): void => {
      const pid = groupPid();
      if (pid === null) return;
      if (liveMembers(pid) === false) return;
      forcedTermination = true;
      if (!signalGroup(pid, signal)) failureCode = "worker_termination_failed";
    };
    const verifyAfterExit = async (): Promise<void> => {
      const pid = groupPid();
      if (pid === null) { settle(false); return; }
      let members = liveMembers(pid);
      if (members !== false) {
        terminate("SIGTERM");
        await delay(150);
        members = liveMembers(pid);
        if (members !== false) terminate("SIGKILL");
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (liveMembers(pid) === false) { settle(true); return; }
        await delay(50);
      }
      settle(false);
    };
    const abort = (): void => {
      if (settled || abortRequestedAt !== null) return;
      abortRequestedAt = Date.now();
      try { if (child.connected) child.send({ type: "abort" }); } catch { /* escalate */ }
      timers.push(setTimeout(() => {
        if (settled || exited) return;
        terminate("SIGTERM");
        timers.push(setTimeout(() => {
          if (settled || exited) return;
          terminate("SIGKILL");
          timers.push(setTimeout(() => {
            if (!settled && !exited) settle(false);
          }, killGraceMs));
        }, 200));
      }, graceMs));
    };
    try {
      child = fork(input.workerPath, [], {
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: input.environment, execArgv: []
      });
    } catch {
      // Fork failure is a failed invocation, never an assumption of clean shutdown.
      resolve(Object.freeze({ completed: false, failureCode: "worker_termination_failed",
        lifecycle: Object.freeze({ deadlineTriggeredAt: null, abortRequestedAt: null,
          workerExitedAt: null, exitSignal: null, forcedTermination: false,
          workerTerminationVerified: false }) }));
      return;
    }
    child.on("message", (message: unknown) => {
      if (settled || !message || typeof message !== "object") return;
      const item = message as { type?: string; value?: unknown; code?: unknown };
      if (item.type === "event" && abortRequestedAt === null) {
        try { input.onEvent(item.value); }
        catch { abort(); }
      } else if (item.type === "done") completed = true;
      else if (item.type === "error") {
        failureCode = typeof item.code === "string" && [
          "usage_limit_exceeded", "authentication_failed", "provider_overloaded",
          "provider_stream_error_unknown"
        ].includes(item.code) ? item.code : "provider_outcome_ambiguous";
      }
    });
    child.once("error", () => { failureCode = "worker_termination_failed"; abort(); });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      workerExitedAt = Date.now();
      void verifyAfterExit();
    });
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    try { child.send({ type: "start", payload: input.payload }, (error) => { if (error) abort(); }); }
    catch { abort(); }
  });
}
