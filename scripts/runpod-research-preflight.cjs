#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { validateDefinition, V2_RUNTIME_BUDGET } = require("./controlled-pilot/definition.cjs");
const { hashCanonical, parseIndex, verifyIndex } = require("./evidence-index.cjs");

const CONTROLLED_REF = process.env.RESEARCH_PREFLIGHT_CONTROLLED_REF ||
  "research/v2-observed-run-evidence";
const MODE_F_REF = process.env.RESEARCH_PREFLIGHT_MODE_F_REF ||
  "research/mode-f-live-validation";
const EXPECTED_BRANCH = process.env.RESEARCH_PREFLIGHT_EXPECTED_BRANCH || "main";
const CONTROLLED_EXPERIMENT = "controlled-coding-pilot-v2-suite";
const MODE_F_EXPERIMENT = "gate5-mode-f-c-e-f";
const REQUIRED_MODES = [
  "C_synthetic_context",
  "E_bounded_workspace_boundary",
  "F_adaptive_compressed_boundary"
];
const PROVIDER_SECRET_NAMES = [
  "LLM_UPSTREAM_API_KEY",
  "MODEL_WORKER_UPSTREAM_API_KEY",
  "GATE5_API_KEY"
];

function command(root, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: 20_000_000,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const error = new Error(`${options.code || "PREFLIGHT_COMMAND_FAILED"}: ${executable} ${args.join(" ")}`);
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }
  return (result.stdout || "").trim();
}

function git(root, args) {
  return command(root, "git", args, { code: "PREFLIGHT_GIT_FAILED" });
}

function resolveResearchRef(root, branch) {
  const localRemote = `refs/remotes/origin/${branch}`;
  let sha = "";
  try { sha = git(root, ["rev-parse", "--verify", localRemote]); }
  catch {
    command(root, "git", ["fetch", "--quiet", "origin", `refs/heads/${branch}:${localRemote}`], {
      code: "PREFLIGHT_RESEARCH_REF_FETCH_FAILED"
    });
    sha = git(root, ["rev-parse", "--verify", localRemote]);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("PREFLIGHT_RESEARCH_REF_INVALID");
  return sha;
}

function withDetachedWorktree(root, sha, prefix, callback) {
  const holder = mkdtempSync(join(tmpdir(), prefix));
  const worktree = join(holder, "repo");
  const worktreeNodeModules = join(worktree, "node_modules");
  let linkedNodeModules = false;
  git(root, ["worktree", "add", "--quiet", "--detach", worktree, sha]);
  try {
    const sourceNodeModules = join(root, "node_modules");
    if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
      const link = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(sourceNodeModules, worktreeNodeModules, link);
      linkedNodeModules = true;
    }
    return callback(worktree);
  } finally {
    if (linkedNodeModules) rmSync(worktreeNodeModules, { force: true });
    try { git(root, ["worktree", "remove", "--force", worktree]); } catch {}
    rmSync(holder, { recursive: true, force: true });
  }
}

function writableOutputDirectory(root, relativePath) {
  const absolute = resolve(root, relativePath);
  const existed = existsSync(absolute);
  mkdirSync(absolute, { recursive: true });
  accessSync(absolute, constants.W_OK);
  const probe = join(absolute, `.preflight-write-${process.pid}`);
  writeFileSync(probe, "preflight\n", { flag: "wx" });
  rmSync(probe, { force: true });
  if (!existed) rmSync(absolute, { recursive: true, force: true });
  return true;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findExperiment(index, experimentId) {
  const experiment = index.experiments.find((entry) => entry.experimentId === experimentId);
  if (!experiment) throw new Error(`PREFLIGHT_EVIDENCE_EXPERIMENT_MISSING:${experimentId}`);
  return experiment;
}

function validateControlledTaskset(root, controlledIndex) {
  const identity = controlledIndex.tasksetIdentity;
  if (!identity || identity.kind !== "controlled_pilot_definitions/v1" ||
      !Array.isArray(identity.tasks) || identity.tasks.length !== 2) {
    throw new Error("PREFLIGHT_CONTROLLED_TASKSET_INVALID");
  }
  if (hashCanonical(identity) !== controlledIndex.tasksetHash) {
    throw new Error("PREFLIGHT_CONTROLLED_TASKSET_HASH_MISMATCH");
  }
  const taskIds = [];
  for (const taskIdentity of identity.tasks) {
    const definition = validateDefinition(loadJson(resolve(root, taskIdentity.path)));
    if (definition.pilotId !== taskIdentity.pilotId) {
      throw new Error("PREFLIGHT_CONTROLLED_TASK_IDENTITY_MISMATCH");
    }
    taskIds.push(definition.pilotId);
  }
  return { taskCount: taskIds.length, taskIds, tasksetHash: controlledIndex.tasksetHash };
}

function runControlledChecks(root, controlledSha) {
  command(root, process.execPath, ["scripts/controlled-coding-pilot-offline-gate-smoke.cjs"], {
    code: "PREFLIGHT_CONTROLLED_OFFLINE_GATE_FAILED"
  });
  command(root, process.execPath, ["scripts/controlled-coding-pilot-text-edits-adversarial-smoke.cjs"], {
    code: "PREFLIGHT_CONTROLLED_ADVERSARIAL_FAILED"
  });

  withDetachedWorktree(root, controlledSha, "controlled-observed-preflight-", (worktree) => {
    command(worktree, process.execPath, ["scripts/controlled-coding-pilot-observed-evidence-smoke.cjs"], {
      code: "PREFLIGHT_CONTROLLED_OBSERVED_EVIDENCE_FAILED",
      env: {
        ...process.env,
        LLM_UPSTREAM_URL: "",
        MODEL_WORKER_UPSTREAM_URL: "",
        LLM_UPSTREAM_API_KEY: "",
        MODEL_WORKER_UPSTREAM_API_KEY: "",
        OPENAI_API_KEY: "",
        RUNPOD_API_KEY: "",
        CONTROLLED_OBSERVED_RUN_ATTESTATION: ""
      }
    });
  });

  writableOutputDirectory(root, "pilots/controlled-real-coding-v2/observed-runs");
  return { observedEvidenceVerifier: true, offlineGate: true, adversarialSuite: true };
}

function normalizedExternalIdentity(entries) {
  return entries.map((entry) => ({
    repository: entry.repository,
    commitSha: entry.commitSha,
    taskId: entry.taskId
  })).sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function runModeFChecks(root, modeFSha, modeFIndex) {
  return withDetachedWorktree(root, modeFSha, "mode-f-preflight-", (worktree) => {
    const reportRoot = mkdtempSync(join(tmpdir(), "mode-f-preflight-report-"));
    try {
      const evidencePath = join(reportRoot, "mode-f-fixture-evidence.json");
      const decisionPath = join(reportRoot, "mode-f-fixture-promotion-decision.json");
      command(worktree, process.execPath, [
        "scripts/gate5-mode-f-live-evidence.cjs",
        "--repetitions=3",
        `--output=${evidencePath}`
      ], { code: "PREFLIGHT_MODE_F_FIXTURE_FAILED" });
      command(worktree, process.execPath, [
        "scripts/gate5-mode-f-promotion-gate.cjs",
        `--evidence=${evidencePath}`,
        `--output=${decisionPath}`
      ], { code: "PREFLIGHT_MODE_F_PROMOTION_FIXTURE_FAILED" });

      const evidence = loadJson(evidencePath);
      const raw = loadJson(`${evidencePath}.raw.json`);
      const decision = loadJson(decisionPath);
      const modes = raw.aggregates.map((entry) => entry.mode).sort();
      if (JSON.stringify(modes) !== JSON.stringify([...REQUIRED_MODES].sort()) ||
          raw.modeCount !== 3 || raw.taskCount !== 3) {
        throw new Error("PREFLIGHT_MODE_F_DEFINITIONS_INVALID");
      }
      if (evidence.schemaVersion !== "gate5-mode-f-live-evidence/v1" ||
          evidence.researchStatus !== "fixture_contract" ||
          evidence.executionClass !== "fixture_adaptive_compressed_boundary" ||
          typeof evidence.evidenceHash !== "string") {
        throw new Error("PREFLIGHT_MODE_F_EVIDENCE_WRAPPER_INVALID");
      }
      if (decision.promotionEligible !== false ||
          !decision.reasons?.includes("live_observed_evidence_required")) {
        throw new Error("PREFLIGHT_MODE_F_FIXTURE_PROMOTION_NOT_REJECTED");
      }

      const expectedRepositories = normalizedExternalIdentity(modeFIndex.tasksetIdentity.tasks);
      const actualRepositories = normalizedExternalIdentity(evidence.immutableExternalRepositories);
      if (JSON.stringify(actualRepositories) !== JSON.stringify(expectedRepositories) ||
          hashCanonical(modeFIndex.tasksetIdentity) !== modeFIndex.tasksetHash) {
        throw new Error("PREFLIGHT_MODE_F_EXTERNAL_IDENTITY_MISMATCH");
      }
      return {
        ready: true,
        repositories: actualRepositories.length,
        modes: REQUIRED_MODES,
        fixtureBenchmark: true,
        fixturePromotionRejected: true,
        evidenceWrapper: true,
        tasksetHash: modeFIndex.tasksetHash
      };
    } finally {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  });
}

function parsePositiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value || "")) return null;
  return Number(value);
}

function providerReadiness(environment) {
  const controlledEndpoint = environment.LLM_UPSTREAM_URL || environment.MODEL_WORKER_UPSTREAM_URL || "";
  const gate5Endpoint = environment.GATE5_OPENAI_ENDPOINT || "";
  const controlledModel = environment.LLM_MODEL_ID || "";
  const gate5Model = environment.GATE5_MODEL || "";
  const gate5MaxTokens = parsePositiveInteger(environment.GATE5_MAX_COMPLETION_TOKENS);
  const repetitions = parsePositiveInteger(environment.RUNPOD_RESEARCH_REPETITIONS);
  const apiKeyPresent = PROVIDER_SECRET_NAMES.some((name) => Boolean(environment[name]));
  const explicitUnavailable = environment.RUNPOD_RESEARCH_PROVIDER === "unavailable" ||
    (!controlledEndpoint && !gate5Endpoint && !controlledModel && !gate5Model && !apiKeyPresent);

  let endpointShape = false;
  try {
    const controlledUrl = new URL(controlledEndpoint);
    const gate5Url = new URL(gate5Endpoint);
    endpointShape = [controlledUrl.protocol, gate5Url.protocol].every((value) =>
      value === "https:" || value === "http:");
  } catch {}

  const sameModel = Boolean(controlledModel && gate5Model && controlledModel === gate5Model);
  const configured = endpointShape && sameModel && gate5MaxTokens !== null &&
    repetitions !== null && apiKeyPresent;

  return {
    configured,
    explicitUnavailable,
    checks: {
      endpointPresent: Boolean(controlledEndpoint && gate5Endpoint),
      endpointShape,
      modelIdPresent: Boolean(controlledModel && gate5Model),
      sameModel,
      temperatureExplicit: true,
      controlledPilotTemperature: 0,
      modeFTemperature: 0,
      controlledPilotMaxCompletionTokens: V2_RUNTIME_BUDGET.providerMaxOutputTokens,
      modeFMaxCompletionTokensExplicit: gate5MaxTokens !== null,
      repetitionsExplicit: repetitions !== null,
      apiKeyPresent
    },
    values: {
      modelId: sameModel ? controlledModel : null,
      modeFMaxCompletionTokens: gate5MaxTokens,
      repetitions
    }
  };
}

function main() {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const currentBranch = git(root, ["branch", "--show-current"]);
  const workingTreeClean = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
  const expectedBranch = EXPECTED_BRANCH === "HEAD"
    ? currentBranch === ""
    : currentBranch === EXPECTED_BRANCH;
  if (!workingTreeClean) throw new Error("PREFLIGHT_WORKTREE_NOT_CLEAN");
  if (!expectedBranch) throw new Error(`PREFLIGHT_BRANCH_MISMATCH:${currentBranch || "DETACHED"}`);

  const index = verifyIndex(parseIndex(root), root);
  const controlledIndex = findExperiment(index, CONTROLLED_EXPERIMENT);
  const modeFIndex = findExperiment(index, MODE_F_EXPERIMENT);
  const controlledTaskset = validateControlledTaskset(root, controlledIndex);
  const controlledSha = resolveResearchRef(root, CONTROLLED_REF);
  const modeFSha = resolveResearchRef(root, MODE_F_REF);

  const controlledChecks = runControlledChecks(root, controlledSha);
  const modeF = runModeFChecks(root, modeFSha, modeFIndex);
  writableOutputDirectory(root, "reports/gate5");
  const provider = providerReadiness(process.env);
  const localReady = true;
  const providerReady = provider.configured;
  const runpodReady = localReady && providerReady;

  const report = {
    schemaVersion: "bounded.runpod-research-preflight/v1",
    ready: runpodReady,
    localReady,
    providerReady,
    runpodReady,
    sourceCommit,
    repository: {
      ready: true,
      workingTreeClean,
      expectedBranch: EXPECTED_BRANCH,
      currentBranch: currentBranch || "DETACHED"
    },
    controlledPilotV2: {
      ready: true,
      taskCount: controlledTaskset.taskCount,
      tasksetHash: controlledTaskset.tasksetHash,
      researchRef: CONTROLLED_REF,
      researchCommit: controlledSha,
      ...controlledChecks
    },
    modeF: {
      ...modeF,
      researchRef: MODE_F_REF,
      researchCommit: modeFSha
    },
    provider
  };

  const serialized = JSON.stringify(report, null, 2);
  for (const secretName of PROVIDER_SECRET_NAMES) {
    const secret = process.env[secretName];
    if (secret && serialized.includes(secret)) throw new Error("PREFLIGHT_SECRET_LEAK_DETECTED");
  }
  process.stdout.write(`${serialized}\n`);
}

try {
  main();
} catch (error) {
  const failure = {
    schemaVersion: "bounded.runpod-research-preflight/v1",
    ready: false,
    localReady: false,
    providerReady: false,
    runpodReady: false,
    error: error?.message || String(error)
  };
  process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
}

module.exports = { providerReadiness };
