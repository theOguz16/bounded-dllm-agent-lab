import os from "node:os";
import path from "node:path";

import {
  BoundedTaskStateError,
  hashCanonicalJson,
  readDurableBoundedTaskState,
  resumeBoundedTask,
  runBoundedTask,
  type DurableBoundedTaskState,
  type RunBoundedTaskInput,
  type RunBoundedTaskResult
} from "../../../../packages/product-runtime/src/canonical-runtime.js";
import {
  PRODUCT_RUN_CHECKPOINT_AUTHORITY,
  storeProductRunCheckpoint,
  type ProductRunCheckpoint,
  type ProductRunCheckpointSource,
  type ProductRunPersistPoint
} from "../run-artifact-store.js";
import {
  BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
  BOUNDED_CODEX_REASONING,
  BOUNDED_CODEX_VALIDATION_PROFILE,
  codexCommand as coreCodexCommand,
  type CodexCommandDependencies as CoreCodexCommandDependencies,
  type CodexExplicitScopeCommandInput
} from "./codex-core.js";

export {
  BOUNDED_CODEX_EXPLICIT_SCOPE_VERSION,
  BOUNDED_CODEX_REASONING,
  BOUNDED_CODEX_VALIDATION_PROFILE
} from "./codex-core.js";
export type { CodexExplicitScopeCommandInput } from "./codex-core.js";

export const BOUNDED_CODEX_DURABLE_VERSION = "bounded-codex-durable/v1" as const;

export type CodexCommandDependencies = Readonly<
  Omit<CoreCodexCommandDependencies, "runTask"> & {
    runTask?: (input: RunBoundedTaskInput) => Promise<RunBoundedTaskResult>;
    resumeTask?: (input: RunBoundedTaskInput) => Promise<RunBoundedTaskResult>;
    durableRegistryRoot?: string;
    durableLeaseTimeoutMs?: number;
    checkpointObserver?: (checkpoint: ProductRunCheckpoint) => void;
  }
>;

type DurableBinding = Readonly<{
  registryRoot: string;
  idempotencyKey: string;
  runId: string;
  resumed: boolean;
}>;

function pathOverlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function durableRegistryRoot(repositoryRoot: string, override?: string): string {
  const configured = override ?? process.env.BOUNDED_DURABLE_REGISTRY;
  const selected = path.resolve(configured?.trim() || path.join(os.homedir(), ".bounded", "durable-tasks"));
  if (pathOverlaps(path.resolve(repositoryRoot), selected)) {
    throw new BoundedTaskStateError(
      "bounded_task_state_registry_overlap",
      "Codex durable registry must be outside the source repository."
    );
  }
  return selected;
}

function idempotencyKey(input: RunBoundedTaskInput): string {
  return `codex.${hashCanonicalJson({
    version: BOUNDED_CODEX_DURABLE_VERSION,
    taskId: input.taskId,
    objectiveHash: input.objectiveHash,
    reasoning: BOUNDED_CODEX_REASONING
  }).slice("sha256:".length, "sha256:".length + 32)}`;
}

function readState(
  registryRoot: string,
  taskId: string,
  durableIdempotencyKey: string
): DurableBoundedTaskState | null {
  try {
    return readDurableBoundedTaskState({
      registryRoot,
      taskId,
      idempotencyKey: durableIdempotencyKey
    });
  } catch (error) {
    if (error instanceof BoundedTaskStateError && error.code === "bounded_task_state_missing") {
      return null;
    }
    throw error;
  }
}

function createCheckpointBridge(input: Readonly<{
  runId: string;
  taskId: string;
  idempotencyKey: string;
  registryRoot: string;
  observer?: (checkpoint: ProductRunCheckpoint) => void;
}>): Readonly<{
  record: (point: ProductRunPersistPoint, source?: ProductRunCheckpointSource) => ProductRunCheckpoint | null;
  onCheckpoint: (state: DurableBoundedTaskState) => void;
  onProviderCheckpoint: (event: Readonly<{
    providerKind: string;
    phase: "prepared" | "started" | "response_received" | "completed";
    providerIdempotencyKey: string;
    attempt: number;
  }>) => void;
  onArtifactCheckpoint: (event: Readonly<{ name: string; contentHash: string }>) => void;
}> {
  const persist = (
    point: ProductRunPersistPoint,
    state: DurableBoundedTaskState,
    source: ProductRunCheckpointSource = {}
  ): ProductRunCheckpoint => {
    const checkpoint = storeProductRunCheckpoint({
      registryRoot: input.registryRoot,
      runId: input.runId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      point,
      state,
      source
    });
    input.observer?.(checkpoint);
    return checkpoint;
  };
  const current = (): DurableBoundedTaskState | null =>
    readState(input.registryRoot, input.taskId, input.idempotencyKey);
  const record = (
    point: ProductRunPersistPoint,
    source: ProductRunCheckpointSource = {}
  ): ProductRunCheckpoint | null => {
    const state = current();
    return state === null ? null : persist(point, state, source);
  };

  return Object.freeze({
    record,
    onCheckpoint(state) {
      if (state.currentState === "mutation_verified") {
        persist("after_verification", state);
      } else if (state.currentState === "governed_apply_prepared") {
        persist("before_apply", state);
      } else if (state.currentState === "x4_committed") {
        persist("after_apply", state);
      } else if (state.currentState === "validation_completed") {
        persist("after_validation", state);
      }
    },
    onProviderCheckpoint(event) {
      if (event.providerKind !== "planner" && event.providerKind !== "coder") return;
      if (event.phase === "started") {
        record("before_agent_call", {
          providerKind: event.providerKind,
          providerPhase: event.phase
        });
      } else if (event.phase === "completed") {
        record("after_agent_call", {
          providerKind: event.providerKind,
          providerPhase: event.phase
        });
      }
    },
    onArtifactCheckpoint(event) {
      if (event.name === "validated-mutation") {
        record("after_mutation_capture", { artifactName: event.name });
      }
    }
  });
}

export async function codexCommand(
  raw: CodexExplicitScopeCommandInput,
  startPath = process.cwd(),
  dependencies: CodexCommandDependencies = {}
) {
  let binding: DurableBinding | null = null;
  let finalState: DurableBoundedTaskState | null = null;

  const result = await coreCodexCommand(raw, startPath, {
    adapter: dependencies.adapter,
    model: dependencies.model,
    validationProfile: dependencies.validationProfile,
    runTask: async (coreInput) => {
      const registryRoot = durableRegistryRoot(coreInput.repositoryPath, dependencies.durableRegistryRoot);
      const durableIdempotencyKey = idempotencyKey(coreInput);
      const existing = readState(registryRoot, coreInput.taskId, durableIdempotencyKey);
      const bridge = createCheckpointBridge({
        runId: coreInput.taskId,
        taskId: coreInput.taskId,
        idempotencyKey: durableIdempotencyKey,
        registryRoot,
        observer: dependencies.checkpointObserver
      });
      binding = Object.freeze({
        registryRoot,
        idempotencyKey: durableIdempotencyKey,
        runId: coreInput.taskId,
        resumed: existing !== null
      });

      const durableInput: RunBoundedTaskInput = {
        ...coreInput,
        durableTask: {
          registryRoot,
          idempotencyKey: durableIdempotencyKey,
          resume: existing !== null,
          ...(dependencies.durableLeaseTimeoutMs === undefined
            ? {}
            : { leaseTimeoutMs: dependencies.durableLeaseTimeoutMs }),
          providerIdempotencySupport: {
            planner: false,
            coder: false,
            context: true
          },
          onCheckpoint: bridge.onCheckpoint,
          onProviderCheckpoint: bridge.onProviderCheckpoint,
          onArtifactCheckpoint: bridge.onArtifactCheckpoint
        }
      };

      const run = dependencies.runTask
        ? dependencies.runTask(durableInput)
        : existing !== null
          ? (dependencies.resumeTask ?? resumeBoundedTask)(durableInput)
          : runBoundedTask(durableInput);
      const runResult = await run;
      if (runResult.verifierResult?.validationEvidence !== undefined) {
        bridge.record("after_validation", { artifactName: "validation-evidence" });
      }
      finalState = readState(registryRoot, coreInput.taskId, durableIdempotencyKey);
      return runResult;
    }
  });

  if (binding === null) return result;
  const durableBinding = binding as DurableBinding;
  const durableState = finalState ?? readState(
    durableBinding.registryRoot,
    result.output.taskId as string,
    durableBinding.idempotencyKey
  );

  return Object.freeze({
    ...result,
    output: Object.freeze({
      ...result.output,
      durable: Object.freeze({
        version: BOUNDED_CODEX_DURABLE_VERSION,
        recoveryAuthority: PRODUCT_RUN_CHECKPOINT_AUTHORITY,
        idempotencyKey: durableBinding.idempotencyKey,
        productCheckpointRunId: durableBinding.runId,
        resumed: durableBinding.resumed,
        state: durableState?.currentState ?? null,
        canonicalRunId: durableState?.runId ?? null,
        transitionSequence: durableState?.transitionSequence ?? null
      })
    })
  });
}
