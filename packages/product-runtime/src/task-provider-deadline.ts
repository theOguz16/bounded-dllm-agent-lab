import type { RuntimeStage } from "./runtime-contract-foundation.js";

export type TaskProviderControl = Readonly<{
  signal: AbortSignal;
  /** Absolute Unix time in milliseconds; shared by every provider in this task. */
  deadlineAt: number;
  /** Stable durable retry key when the provider declares idempotency support. */
  providerIdempotencyKey?: string;
}>;

export class TaskProviderInterruption extends Error {
  constructor(
    readonly code: "bounded_task_deadline_exceeded" | "bounded_task_cancelled",
    readonly stage: RuntimeStage
  ) {
    super(code === "bounded_task_cancelled" ? "Task cancelled by caller." : "Task deadline exceeded.");
  }
}

export function createTaskProviderDeadline(deadlineAt: number, callerSignal?: AbortSignal) {
  const controller = new AbortController();
  let stage: RuntimeStage = "planning";
  let interruption: TaskProviderInterruption | null = null;
  const stop = (code: TaskProviderInterruption["code"]) => {
    if (interruption !== null) return;
    interruption = new TaskProviderInterruption(code, stage);
    controller.abort(interruption);
  };
  const cancel = () => stop("bounded_task_cancelled");
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const timer = setTimeout(() => stop("bounded_task_deadline_exceeded"), Math.max(0, deadlineAt - Date.now()));
  const check = () => {
    if (Date.now() >= deadlineAt) stop("bounded_task_deadline_exceeded");
    if (interruption !== null) throw interruption;
  };
  const control: TaskProviderControl = { signal: controller.signal, deadlineAt };
  return {
    check,
    setStage(value: RuntimeStage) { stage = value; },
    async call<T>(value: RuntimeStage, provider: (control: TaskProviderControl) => Promise<T>): Promise<T> {
      stage = value;
      check();
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(interruption);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        // Attach both handlers even if cancellation wins: late rejections are consumed.
        Promise.resolve().then(() => { check(); return provider(control); }).then(
          (result) => {
            try { check(); resolve(result); } catch (error) { reject(error); }
          },
          reject
        ).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
    },
    dispose() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  };
}
