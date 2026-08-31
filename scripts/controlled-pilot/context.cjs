"use strict";

const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonical(value)
  ).digest("hex")}`;
}

async function git(root, args) {
  return (await exec("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 10_000_000
  })).stdout.trim();
}

async function sourceSnapshot(root, target) {
  return {
    commit: await git(root, ["rev-parse", "HEAD"]),
    statusHash: hash(await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])),
    targetHash: hash(await readFile(join(root, target), "utf8"))
  };
}

async function createCheckout(sourceRoot, temporaryRoot, commit) {
  const checkout = join(temporaryRoot, "checkout");
  await exec("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", sourceRoot, checkout]);
  await exec("git", ["checkout", "--quiet", "--detach", commit], { cwd: checkout });
  return checkout;
}

async function unifiedPatch(path, before, after, temporaryRoot) {
  const oldFile = join(temporaryRoot, "before");
  const newFile = join(temporaryRoot, "after");
  await writeFile(oldFile, before);
  await writeFile(newFile, after);
  try {
    await exec("diff", ["-u", "--label", `a/${path}`, "--label", `b/${path}`, oldFile, newFile]);
    return "";
  } catch (error) {
    if (error.code !== 1) throw error;
    return error.stdout;
  }
}

function patchLines(patch) {
  return patch.split(/\r?\n/).filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  ).length;
}

function enforceSemanticPatchLimit(lineCount, maxPatchLines) {
  if (lineCount > maxPatchLines) {
    throw Object.assign(new Error("PILOT_PATCH_LIMIT_EXCEEDED"), {
      pilotCode: "PILOT_PATCH_LIMIT_EXCEEDED"
    });
  }
}

function pathMatchesScope(filePath, scope) {
  return filePath === scope || filePath.startsWith(`${scope.replace(/\/+$/, "")}/`);
}

function deriveExecutorMutationLineBudget(input) {
  const totalAuthorizedSourceLines = input.sourceFiles
    .filter((file) =>
      input.allowedMutationPaths.some((scope) => pathMatchesScope(file.path, scope)) &&
      !input.forbiddenPaths.some((scope) => pathMatchesScope(file.path, scope))
    )
    .reduce((total, file) => total + file.content.split(/\r?\n/).length, 0);
  return 2 * totalAuthorizedSourceLines + input.maxPatchLines;
}

function buildExecutionRequest(input) {
  const {
    abortSignal,
    codingRequestVersion,
    definition,
    executorMutationLineBudget,
    profile,
    providerSources,
    runtimeBudget,
    sourceCommit
  } = input;
  const symbolForPath = (filePath) => profile.providerMode === "controlled_help_copy"
    ? "symbol:main"
    : `symbol:${filePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const selectedSymbols = profile.requiredMutationPaths.map(symbolForPath);
  const plan = {
    planId: profile.providerMode === "controlled_help_copy"
      ? "controlled-help-plan"
      : "controlled-bounded-text-edit-plan",
    steps: [{
      stepId: "step-1",
      description: definition.taskPrompt,
      targetPaths: profile.requiredMutationPaths,
      requiredSymbolIds: selectedSymbols
    }]
  };
  const authority = {
    readablePaths: [...new Set(definition.allowedReadRoots)].sort(),
    allowedChangePaths: [...profile.allowedMutationPaths],
    forbiddenPaths: [...new Set(definition.forbiddenPaths)].sort()
  };
  const workspaceFiles = profile.allowedMutationPaths.map((filePath) => {
    const content = providerSources.get(filePath).content;
    return {
      path: filePath,
      content,
      contentHash: hash(content),
      language: "TypeScript",
      authority: "change_allowed",
      relatedSymbols: [symbolForPath(filePath)]
    };
  });
  const request = {
    schemaVersion: codingRequestVersion,
    executionId: "controlled-coding-pilot-execution",
    repository: {
      repositoryId: "bounded-dllm-agent-lab.controlled-pilot",
      commitSha: sourceCommit
    },
    task: { taskId: definition.pilotId, summary: definition.taskPrompt },
    plan: { ...plan, planHash: hash(plan) },
    workspace: {
      manifestHash: hash({ files: workspaceFiles }),
      files: workspaceFiles,
      selectedSymbols,
      selectedTests: ["executor_mutations", "bounded_text_edits"].includes(profile.providerMode)
        ? ["tests/smoke/contracts.ts"]
        : [],
      evidenceReceiptIds: [],
      expansionRound: 0
    },
    authority: { ...authority, authorityHash: hash(authority) },
    budget: {
      maxToolCalls: 1,
      maxInputBytes: 500_000,
      maxOutputBytes: 100_000,
      maxChangedFiles: profile.executorMaxChangedFiles,
      maxChangedLines: executorMutationLineBudget,
      remainingRuntimeMs: runtimeBudget.executionRuntimeMs,
      inputTokenLimit: runtimeBudget.modelContextTokenLimit,
      outputTokenLimit: runtimeBudget.executorOutputTokenLimit
    },
    ...(abortSignal ? { abortSignal } : {})
  };
  return { request, symbolForPath };
}

module.exports = {
  buildExecutionRequest,
  canonical,
  createCheckout,
  deriveExecutorMutationLineBudget,
  enforceSemanticPatchLimit,
  git,
  hash,
  patchLines,
  pathMatchesScope,
  sourceSnapshot,
  unifiedPatch
};
