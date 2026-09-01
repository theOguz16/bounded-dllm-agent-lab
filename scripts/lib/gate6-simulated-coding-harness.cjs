"use strict";

const path = require("node:path");
const { resolveContext } = require("./gate6-context-strategies.cjs");
const { safeRelativePath, sha256 } = require("./gate6-simulated-workspace.cjs");

const HARNESS_VERSION = "gate6-simulated-coding-harness/v1";
const PROPOSAL_VERSION = "gate6-simulated-proposal/v1";

const FAILURE_CODES = Object.freeze({
  MODEL_OUTPUT_INVALID: "MODEL_OUTPUT_INVALID",
  REQUIRED_MUTATION_MISSING: "REQUIRED_MUTATION_MISSING",
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  AUTHORITY_VIOLATION: "AUTHORITY_VIOLATION",
  PATCH_APPLY_FAILED: "PATCH_APPLY_FAILED",
  TEST_FAILURE: "TEST_FAILURE",
  ACCEPTANCE_FAILURE: "ACCEPTANCE_FAILURE",
  UNNECESSARY_MUTATION: "UNNECESSARY_MUTATION",
  CONTEXT_RESOLUTION_FAILURE: "CONTEXT_RESOLUTION_FAILURE",
  UNAUTHORIZED_FILE_MUTATION: "UNAUTHORIZED_FILE_MUTATION",
  PROVIDER_FAILURE: "PROVIDER_FAILURE",
  WORKSPACE_SETUP_FAILURE: "WORKSPACE_SETUP_FAILURE",
  ROLLBACK_FAILED: "ROLLBACK_FAILED"
});

class Gate6SimulatedCodingError extends Error {
  constructor(code, domain, detail, extra = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6SimulatedCodingError";
    this.code = code;
    this.domain = domain;
    Object.assign(this, extra);
  }
}

function fail(code, domain, detail, extra) {
  throw new Gate6SimulatedCodingError(code, domain, detail, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  return isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function pathMatchesRule(filePath, rule) {
  if (filePath === rule) return true;
  if (typeof rule !== "string" || !rule.endsWith("/**")) return false;
  const prefix = rule.slice(0, -3).replace(/\/+$/, "");
  return prefix.length > 0 && (filePath === prefix || filePath.startsWith(`${prefix}/`));
}

function validateProposal(value) {
  if (!sameKeys(value, ["schemaVersion", "action", "edits", "summary"])) return null;
  if (value.schemaVersion !== PROPOSAL_VERSION) return null;
  if (value.action !== "patch" && value.action !== "no_change") return null;
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 2000) return null;
  if (!Array.isArray(value.edits) || value.edits.length > 32) return null;
  if (value.action === "no_change" && value.edits.length !== 0) return null;
  if (value.action === "patch" && value.edits.length === 0) return null;

  const edits = [];
  for (const edit of value.edits) {
    if (!sameKeys(edit, ["path", "expectedContentHash", "oldText", "newText"])) return null;
    if (!safeRelativePath(edit.path)) return null;
    if (typeof edit.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(edit.expectedContentHash)) return null;
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" ||
        edit.oldText.length === 0 || edit.oldText === edit.newText ||
        edit.oldText.includes("\0") || edit.newText.includes("\0")) return null;
    edits.push(Object.freeze({ ...edit }));
  }
  return Object.freeze({
    schemaVersion: PROPOSAL_VERSION,
    action: value.action,
    edits: Object.freeze(edits),
    summary: value.summary.trim()
  });
}

function providerFailure(code, detail) {
  return new Gate6SimulatedCodingError(
    FAILURE_CODES.PROVIDER_FAILURE,
    "provider",
    detail ?? code,
    { providerFailureCode: code ?? "PROVIDER_UNKNOWN" }
  );
}

function defaultMetrics() {
  return {
    proposalGenerated: false,
    verifierReached: false,
    verifierAccepted: false,
    verifierRejected: false,
    patchApplied: false,
    relevantTestsExecuted: false,
    testsPassed: false,
    acceptancePassed: false,
    rollbackRequired: false,
    rollbackCompleted: false,
    scopeViolation: false,
    unauthorizedFileMutation: false,
    humanIntervention: false,
    noChangeAccepted: false
  };
}

function changedSetAllowed(changedFiles, baselineFiles, permittedFiles) {
  const baseline = new Set(baselineFiles);
  const permitted = new Set(permittedFiles);
  const unexpected = [];
  for (const filePath of changedFiles) {
    if (baseline.has(filePath)) continue;
    if (!permitted.has(filePath)) unexpected.push(filePath);
  }
  return unexpected.sort();
}

async function preflightEdits(task, proposal, workspace) {
  const candidateUniverse = new Set(task.candidateFiles);
  const allowedRules = task.authority.allowedChangePaths ?? [];
  const forbiddenRules = task.authority.forbiddenInspectionPaths ?? [];
  const prepared = new Map();
  const spansByPath = new Map();

  for (const edit of proposal.edits) {
    const authorityAllowed = allowedRules.some((rule) => pathMatchesRule(edit.path, rule)) &&
      !forbiddenRules.some((rule) => pathMatchesRule(edit.path, rule));
    if (!authorityAllowed) {
      fail(FAILURE_CODES.AUTHORITY_VIOLATION, "policy", edit.path);
    }
    if (!candidateUniverse.has(edit.path)) {
      fail(FAILURE_CODES.SCOPE_VIOLATION, "policy", edit.path);
    }

    let source;
    try {
      source = await workspace.read(edit.path);
    } catch (error) {
      fail(FAILURE_CODES.PATCH_APPLY_FAILED, "execution", `${edit.path}:${error.message}`);
    }
    if (sha256(source) !== edit.expectedContentHash) {
      fail(FAILURE_CODES.PATCH_APPLY_FAILED, "execution", `${edit.path}:content_hash_mismatch`);
    }
    const start = source.indexOf(edit.oldText);
    if (start < 0 || source.indexOf(edit.oldText, start + edit.oldText.length) >= 0) {
      fail(FAILURE_CODES.PATCH_APPLY_FAILED, "execution", `${edit.path}:old_text_not_unique`);
    }
    const span = { start, end: start + edit.oldText.length };
    const existing = spansByPath.get(edit.path) ?? [];
    if (existing.some((other) => span.start < other.end && other.start < span.end)) {
      fail(FAILURE_CODES.MODEL_OUTPUT_INVALID, "model", `${edit.path}:overlapping_edits`);
    }
    existing.push(span);
    spansByPath.set(edit.path, existing);
    const entry = prepared.get(edit.path) ?? { source, edits: [] };
    entry.edits.push({ ...edit, ...span });
    prepared.set(edit.path, entry);
  }
  return prepared;
}

async function applyPreparedEdits(prepared, workspace) {
  for (const [filePath, entry] of prepared) {
    let content = entry.source;
    const edits = [...entry.edits].sort((a, b) => b.start - a.start || b.end - a.end);
    for (const edit of edits) {
      content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
    }
    await workspace.write(filePath, content);
  }
}

function normalizeStageResult(value, stage) {
  if (value === true) return { passed: true, detail: null };
  if (value === false) return { passed: false, detail: `${stage}_returned_false` };
  if (isPlainObject(value) && typeof value.passed === "boolean") {
    return { passed: value.passed, detail: value.detail ?? null };
  }
  return { passed: false, detail: `${stage}_result_invalid` };
}

function freezeReport(report) {
  report.metrics = Object.freeze({ ...report.metrics });
  report.lifecycle = Object.freeze([...report.lifecycle]);
  report.changedFiles = Object.freeze([...(report.changedFiles ?? [])]);
  report.unauthorizedFiles = Object.freeze([...(report.unauthorizedFiles ?? [])]);
  return Object.freeze(report);
}

function createGate6SimulatedCodingHarness(options = {}) {
  const workspaceFactory = options.workspaceFactory;
  if (!workspaceFactory || typeof workspaceFactory.create !== "function") {
    throw new TypeError("workspaceFactory.create is required");
  }
  const contextResolver = options.contextResolver ?? resolveContext;
  const modelProposalProvider = options.modelProposalProvider;
  const relevantTestRunner = options.relevantTestRunner;
  const acceptanceRunner = options.acceptanceRunner;
  if (typeof contextResolver !== "function") throw new TypeError("contextResolver must be a function");
  if (typeof modelProposalProvider !== "function") throw new TypeError("modelProposalProvider must be a function");
  if (typeof relevantTestRunner !== "function") throw new TypeError("relevantTestRunner must be a function");
  if (typeof acceptanceRunner !== "function") throw new TypeError("acceptanceRunner must be a function");

  return async function runSample(input = {}) {
    const { task, freezeDocument } = input;
    const strategy = input.strategy ?? "E_bounded_workspace_boundary";
    const metrics = defaultMetrics();
    const lifecycle = ["sample.started"];
    let workspace = null;
    let contextResult = null;
    let proposal = null;
    let failureCode = null;
    let failureDomain = null;
    let failureDetail = null;
    let providerFailureCode = null;
    let modelCapabilityFailure = false;
    let workspaceDisposed = false;
    let originalRepositoryMutated = false;
    let changedFiles = [];
    let unauthorizedFiles = [];
    let baselineChangedFiles = [];

    try {
      if (!task || typeof task !== "object") {
        fail(FAILURE_CODES.WORKSPACE_SETUP_FAILURE, "infrastructure", "task_invalid");
      }
      try {
        workspace = await workspaceFactory.create({ task, freezeDocument });
      } catch (error) {
        fail(FAILURE_CODES.WORKSPACE_SETUP_FAILURE, "infrastructure", error.code ?? error.message);
      }
      lifecycle.push("workspace.created");
      baselineChangedFiles = await workspace.changedFiles();

      let repositorySnapshot;
      try {
        repositorySnapshot = await workspace.repositorySnapshot();
        contextResult = await contextResolver({ task, repositorySnapshot, strategy });
      } catch (error) {
        fail(FAILURE_CODES.CONTEXT_RESOLUTION_FAILURE, "context", error.code ?? error.message);
      }
      lifecycle.push("context.resolved");

      let rawProposal;
      try {
        rawProposal = await modelProposalProvider({
          task,
          context: contextResult.context,
          contextResult,
          workspaceId: workspace.workspaceId,
          repositorySnapshot
        });
      } catch (error) {
        if (error instanceof Gate6SimulatedCodingError && error.domain === "provider") throw error;
        if (error?.providerFailure === true || error?.domain === "provider") {
          throw providerFailure(error.code ?? "PROVIDER_ERROR", error.message);
        }
        throw providerFailure(error?.code ?? "PROVIDER_CALL_FAILED", error?.message ?? String(error));
      }
      proposal = validateProposal(rawProposal);
      if (proposal === null) fail(FAILURE_CODES.MODEL_OUTPUT_INVALID, "model", "proposal_schema_invalid");
      metrics.proposalGenerated = true;
      lifecycle.push("proposal.generated");

      metrics.verifierReached = true;
      lifecycle.push("verifier.started");
      const noChangeTask = task.taskClass === "no_change_needed";
      if (noChangeTask && proposal.action === "patch") {
        metrics.verifierRejected = true;
        fail(FAILURE_CODES.UNNECESSARY_MUTATION, "model", task.taskId);
      }
      if (!noChangeTask && proposal.action === "no_change") {
        metrics.verifierRejected = true;
        fail(FAILURE_CODES.REQUIRED_MUTATION_MISSING, "model", task.taskId);
      }

      let prepared = new Map();
      if (proposal.action === "patch") {
        try {
          prepared = await preflightEdits(task, proposal, workspace);
        } catch (error) {
          if (error.code === FAILURE_CODES.SCOPE_VIOLATION) metrics.scopeViolation = true;
          metrics.verifierRejected = true;
          throw error;
        }
      }
      metrics.verifierAccepted = true;
      lifecycle.push("verifier.accepted");

      if (proposal.action === "patch") {
        try {
          await applyPreparedEdits(prepared, workspace);
          metrics.patchApplied = true;
          lifecycle.push("patch.applied");
        } catch (error) {
          metrics.rollbackRequired = true;
          fail(FAILURE_CODES.PATCH_APPLY_FAILED, "execution", error.message);
        }
      } else {
        metrics.noChangeAccepted = true;
        lifecycle.push("proposal.no_change.accepted");
      }

      changedFiles = await workspace.changedFiles();
      unauthorizedFiles = changedSetAllowed(changedFiles, baselineChangedFiles, proposal.edits.map((edit) => edit.path));
      if (unauthorizedFiles.length > 0) {
        metrics.unauthorizedFileMutation = true;
        metrics.rollbackRequired = metrics.patchApplied || changedFiles.length > baselineChangedFiles.length;
        fail(FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION, "policy", unauthorizedFiles.join(","));
      }

      metrics.relevantTestsExecuted = true;
      lifecycle.push("tests.started");
      let testResult;
      try {
        testResult = normalizeStageResult(await relevantTestRunner({ task, workspace, proposal }), "tests");
      } catch (error) {
        testResult = { passed: false, detail: error.message ?? String(error) };
      }
      metrics.testsPassed = testResult.passed;
      lifecycle.push(testResult.passed ? "tests.passed" : "tests.failed");
      if (!testResult.passed) {
        metrics.rollbackRequired = metrics.patchApplied || (await workspace.changedFiles()).length > baselineChangedFiles.length;
        fail(FAILURE_CODES.TEST_FAILURE, "verification", testResult.detail);
      }

      changedFiles = await workspace.changedFiles();
      unauthorizedFiles = changedSetAllowed(changedFiles, baselineChangedFiles, proposal.edits.map((edit) => edit.path));
      if (unauthorizedFiles.length > 0) {
        metrics.unauthorizedFileMutation = true;
        metrics.rollbackRequired = true;
        fail(FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION, "policy", unauthorizedFiles.join(","));
      }

      lifecycle.push("acceptance.started");
      let acceptanceResult;
      try {
        acceptanceResult = normalizeStageResult(await acceptanceRunner({ task, workspace, proposal }), "acceptance");
      } catch (error) {
        acceptanceResult = { passed: false, detail: error.message ?? String(error) };
      }
      metrics.acceptancePassed = acceptanceResult.passed;
      lifecycle.push(acceptanceResult.passed ? "acceptance.passed" : "acceptance.failed");
      if (!acceptanceResult.passed) {
        metrics.rollbackRequired = metrics.patchApplied || (await workspace.changedFiles()).length > baselineChangedFiles.length;
        fail(FAILURE_CODES.ACCEPTANCE_FAILURE, "acceptance", acceptanceResult.detail);
      }

      changedFiles = await workspace.changedFiles();
      unauthorizedFiles = changedSetAllowed(changedFiles, baselineChangedFiles, proposal.edits.map((edit) => edit.path));
      if (unauthorizedFiles.length > 0) {
        metrics.unauthorizedFileMutation = true;
        metrics.rollbackRequired = true;
        fail(FAILURE_CODES.UNAUTHORIZED_FILE_MUTATION, "policy", unauthorizedFiles.join(","));
      }
      lifecycle.push("sample.finalized");
    } catch (error) {
      failureCode = error instanceof Gate6SimulatedCodingError
        ? error.code
        : FAILURE_CODES.WORKSPACE_SETUP_FAILURE;
      failureDomain = error instanceof Gate6SimulatedCodingError
        ? error.domain
        : "infrastructure";
      failureDetail = error.message ?? String(error);
      providerFailureCode = error.providerFailureCode ?? null;
      modelCapabilityFailure = failureDomain === "model";
      if (failureCode === FAILURE_CODES.SCOPE_VIOLATION) metrics.scopeViolation = true;
      lifecycle.push(`sample.failed.${failureCode}`);

      if (workspace && metrics.rollbackRequired) {
        lifecycle.push("rollback.started");
        try {
          metrics.rollbackCompleted = await workspace.rollback() === true;
        } catch {
          metrics.rollbackCompleted = false;
        }
        lifecycle.push(metrics.rollbackCompleted ? "rollback.completed" : "rollback.failed");
        if (!metrics.rollbackCompleted) {
          failureCode = FAILURE_CODES.ROLLBACK_FAILED;
          failureDomain = "infrastructure";
          metrics.humanIntervention = true;
        }
      }
    } finally {
      if (workspace) {
        try {
          const unchanged = await workspace.assertOriginalRepositoryUnchanged();
          originalRepositoryMutated = unchanged !== true;
          if (originalRepositoryMutated) metrics.humanIntervention = true;
        } catch {
          originalRepositoryMutated = true;
          metrics.humanIntervention = true;
        }
        try {
          workspaceDisposed = await workspace.dispose() === true;
        } catch {
          workspaceDisposed = false;
          metrics.humanIntervention = true;
        }
      }
      lifecycle.push("sample.finished");
    }

    const accepted = failureCode === null;
    return freezeReport({
      version: HARNESS_VERSION,
      taskId: task?.taskId ?? null,
      repositoryId: task?.repositoryId ?? null,
      commitSha: task?.commitSha ?? null,
      workspaceId: workspace?.workspaceId ?? null,
      strategy,
      status: accepted ? "accepted" : "rejected",
      failureCode,
      failureDomain,
      failureDetail,
      providerFailureCode,
      modelCapabilityFailure,
      proposalAction: proposal?.action ?? null,
      contextStrategy: contextResult?.strategy ?? null,
      contextBytes: contextResult?.contextBytes ?? null,
      providerContextHash: contextResult?.providerContextHash ?? null,
      metrics,
      changedFiles,
      unauthorizedFiles,
      baselineChangedFiles: Object.freeze([...baselineChangedFiles]),
      originalRepositoryMutated,
      workspaceDisposed,
      lifecycle
    });
  };
}

module.exports = {
  FAILURE_CODES,
  HARNESS_VERSION,
  PROPOSAL_VERSION,
  Gate6SimulatedCodingError,
  createGate6SimulatedCodingHarness,
  pathMatchesRule,
  providerFailure,
  validateProposal
};
