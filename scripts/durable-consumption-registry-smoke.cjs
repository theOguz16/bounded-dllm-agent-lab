#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function hashCanonical(value) {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return `sha256:${require("node:crypto").createHash("sha256").update(JSON.stringify(sort(value))).digest("hex")}`;
}
function handoff() {
  const h = (label) => hashCanonical({ label });
  const constraints = Object.fromEntries([
    "requireCurrentArtifact","requireAutoContinueRoute","requireApplyEligibleArtifact",
    "requireRepositoryIdentityMatch","requireBaseRevisionMatch","requireWorktreeStateMatch",
    "restrictWritesToChangedFiles","forbidAdditionalFiles","requireAtomicApply",
    "requireRollbackPreparation","requirePostApplyValidation","requireExternalConsumptionRegistry",
  ].map((k) => [k, true]));
  const executorRequirements = Object.fromEntries([
    "recomputeArtifactFreshnessImmediatelyBeforeApply","recomputeMutationHashImmediatelyBeforeApply",
    "recomputeRepositoryIdentityImmediatelyBeforeApply","recomputeBaseRevisionImmediatelyBeforeApply",
    "recomputeWorktreeStateImmediatelyBeforeApply","rejectChangedFileScopeExpansion",
    "rejectUnlistedFileWrites","prepareRollbackBeforeFirstWrite","applyAtomicallyWhenSupported",
    "validateAfterApply","rollbackOnValidationFailure","rejectPreviouslyConsumedKey",
  ].map((k) => [k, true]));
  const mutation = { changeKind: "repair_draft", mutationHash: h("mutation"), changedFiles: ["src/a.ts"],
    patchDryRunResultHash: h("dry"), temporaryApplyResultHash: h("temp"), executionVerificationResultHash: h("exec") };
  const evidence = { governedArtifactHash: h("artifact"), currentSnapshotHash: h("snapshot"), runId: "run-1",
    objectiveHash: h("objective"), preShadowTraceHash: h("trace"), observationHash: h("observation"),
    governanceHash: h("governance"), adminDecisionHash: h("admin"), routeHash: h("route"),
    governancePolicyHash: h("g-policy"), routerPolicyHash: h("r-policy"), finalLedgerRootHash: h("ledger"),
    finalLedgerEventCount: 14, phaseVFinalDecision: "temp_validation_passed", workflowRoute: "auto_continue" };
  const target = { repositoryIdentityHash: h("repo"), baseRevisionHash: h("revision"), worktreeStateHash: h("worktree") };
  const constraintsHash = hashCanonical(constraints);
  const consumptionKey = hashCanonical({ artifactType: "controlled_apply_consumption_key",
    governedArtifactHash: evidence.governedArtifactHash, currentSnapshotHash: evidence.currentSnapshotHash,
    mutationHash: mutation.mutationHash, changedFiles: mutation.changedFiles,
    repositoryIdentityHash: target.repositoryIdentityHash, baseRevisionHash: target.baseRevisionHash,
    worktreeStateHash: target.worktreeStateHash, constraintsHash });
  const material = { handoffVersion: "1", mutation, evidence, target, constraints, executorRequirements,
    singleUse: { consumptionKey, enforcement: "external_consumption_registry_required" }, constraintsHash };
  return { ...material, handoffHash: hashCanonical(material) };
}

(async () => {
  const runtime = await import("../dist/packages/product-runtime/src/durable-consumption-registry.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-registry-"));
  const db = path.join(dir, "registry.sqlite");
  const plan = handoff();
  const before = runtime.inspectDurableConsumption({ registryPath: db, consumptionKey: plan.singleUse.consumptionKey });
  assert.equal(before.decision, "durable_consumption_available");
  const first = runtime.reserveDurableConsumption({ registryPath: db, handoff: plan, reservedBy: "smoke-a", reservedAt: "2026-07-20T10:00:00.000Z" });
  assert.equal(first.decision, "durable_consumption_reserved"); assert.equal(first.reserved, true);
  const second = runtime.reserveDurableConsumption({ registryPath: db, handoff: plan, reservedBy: "smoke-b", reservedAt: "2026-07-20T10:00:01.000Z" });
  assert.equal(second.decision, "durable_consumption_already_reserved"); assert.equal(second.reserved, false);
  const reopened = runtime.inspectDurableConsumption({ registryPath: db, consumptionKey: plan.singleUse.consumptionKey });
  assert.equal(reopened.decision, "durable_consumption_reserved"); assert.equal(reopened.integrityVerified, true);
  const failed = runtime.finalizeDurableConsumption({ registryPath: db, consumptionKey: plan.singleUse.consumptionKey,
    handoffHash: plan.handoffHash, reservationId: first.record.reservationId, reservedBy: "smoke-a",
    outcome: "failed", failureCode: "apply_not_executed", finalizedAt: "2026-07-20T10:00:02.000Z" });
  assert.equal(failed.decision, "durable_consumption_failed_requires_review");
  const retry = runtime.reserveDurableConsumption({ registryPath: db, handoff: plan, reservedBy: "smoke-c" });
  assert.equal(retry.decision, "durable_consumption_failed_requires_review");
  const tampered = structuredClone(plan); tampered.handoffHash = hashCanonical({ tampered: true });
  const invalid = runtime.reserveDurableConsumption({ registryPath: path.join(dir, "other.sqlite"), handoff: tampered, reservedBy: "smoke-d" });
  assert.equal(invalid.decision, "durable_consumption_reservation_invalid");
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.record), true);
  assert.equal(JSON.stringify(first.record).includes("proposedPatch"), false);
  console.log("durable consumption registry smoke passed (10 checks)");
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
