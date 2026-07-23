/**
 * Canonical post-v0.1 product runtime entrypoint.
 *
 * The historical research and mock workspace APIs remain in ./index.ts for
 * repository-internal fixtures only. Package consumers receive this entrypoint.
 */
export const CANONICAL_PRODUCT_RUNTIME_ENTRYPOINT =
  "canonical-product-runtime/v0.2-dev" as const;

export * from "./model-mutation-validator.js";
export * from "./context-sufficiency-contract.js";
export * from "./canonical-repo-intelligence.js";
export * from "./repo-intelligence-context-binding.js";
export * from "./task-to-seed-implementation-contract.js";
export * from "./context-expansion-resolver.js";
export * from "./coder-context-execution-gate.js";
export * from "./adaptive-context-orchestrator.js";
export * from "./context-sufficiency-authorization.js";
export * from "./acceptance-criteria-contract.js";
export * from "./context-to-apply-binding.js";
export * from "./integrated-disposable-apply-coordinator.js";
export * from "./deterministic-verifier-gate.js";
export * from "./repair-draft-verifier-gate.js";
export * from "./patch-application-dry-run-gate.js";
export * from "./temporary-workspace-apply-gate.js";
export * from "./temporary-workspace-execution-verifier.js";
export * from "./remask-request-builder.js";
export * from "./workspace-mutation.js";
export * from "./agent-event-ledger.js";
export * from "./agent-event-ledger-verifier.js";
export * from "./run-accountability-trace.js";
export * from "./shadow-observer-contract.js";
export * from "./shadow-observer-model-adapter.js";
export * from "./deterministic-governance-policy.js";
export * from "./admin-agent-contract.js";
export * from "./admin-agent-model-adapter.js";
export * from "./admin-invocation-policy.js";
export * from "./risk-based-approval-router.js";
export * from "./governed-change-artifact.js";
export * from "./controlled-apply-handoff.js";
export * from "./controlled-repository-inspection.js";
export * from "./controlled-rollback-bundle.js";
export * from "./controlled-apply-execution-gate.js";
export * from "./controlled-repository-apply.js";
export * from "./controlled-post-apply-validation.js";
export * from "./controlled-transaction-recovery.js";
export * from "./durable-consumption-registry.js";
