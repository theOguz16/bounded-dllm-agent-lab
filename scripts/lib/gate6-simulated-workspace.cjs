"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const {
  mkdtemp,
  readFile,
  rm,
  writeFile
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const WORKSPACE_VERSION = "gate6-simulated-workspace/v1";

class Gate6SimulatedWorkspaceError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6SimulatedWorkspaceError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new Gate6SimulatedWorkspaceError(code, detail);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    value.includes("\\") || value.includes("\0") ||
    path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
  ) return false;
  return !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function runGit(root, args) {
  try {
    const result = await exec("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 32 * 1024 * 1024
    });
    return String(result.stdout ?? "").replace(/\r?\n$/, "");
  } catch (error) {
    fail("GATE6_SIM_WORKSPACE_GIT_FAILED", `${args.join(" ")}: ${String(error.stderr ?? error.message ?? error)}`);
  }
}

function declarationPatterns(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`\\b(export\\s+default\\s+async\\s+function\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+default\\s+function\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+async\\s+function\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+function\\s+)${escaped}\\b`),
    new RegExp(`\\b(async\\s+function\\s+)${escaped}\\b`),
    new RegExp(`\\b(function\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+default\\s+class\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+class\\s+)${escaped}\\b`),
    new RegExp(`\\b(class\\s+)${escaped}\\b`),
    new RegExp(`\\b(export\\s+(?:const|let|var)\\s+)${escaped}\\b`),
    new RegExp(`\\b((?:const|let|var)\\s+)${escaped}\\b`)
  ];
}

async function applyFrozenFault(root, task, frozenResult) {
  const fault = frozenResult?.faultInjection;
  if (!fault || fault.type !== "rename_primary_required_symbol") {
    fail("GATE6_SIM_WORKSPACE_FAULT_RECEIPT_INVALID", task.taskId);
  }
  if (!safeRelativePath(fault.path)) fail("GATE6_SIM_WORKSPACE_FAULT_PATH_INVALID", fault.path);
  const fullPath = path.join(root, ...fault.path.split("/"));
  const original = await readFile(fullPath, "utf8");
  const gitBlobSha = await runGit(root, ["rev-parse", `HEAD:${fault.path}`]);
  if (gitBlobSha !== fault.beforeBlobSha) {
    fail("GATE6_SIM_WORKSPACE_FAULT_BLOB_MISMATCH", `${task.taskId}:${gitBlobSha}`);
  }
  if (sha256(original) !== fault.beforeContentHash) {
    fail("GATE6_SIM_WORKSPACE_FAULT_CONTENT_MISMATCH", task.taskId);
  }

  let mutated = null;
  for (const pattern of declarationPatterns(fault.symbol)) {
    const match = pattern.exec(original);
    if (!match) continue;
    let replacement = match[0].replace(fault.symbol, fault.replacementSymbol);
    if (fault.defaultExportRemoved) replacement = replacement.replace(/^export\s+default\s+/, "");
    mutated = original.slice(0, match.index) + replacement + original.slice(match.index + match[0].length);
    break;
  }
  if (mutated === null || mutated === original) {
    fail("GATE6_SIM_WORKSPACE_FAULT_UNRESOLVABLE", task.taskId);
  }
  if (sha256(mutated) !== fault.afterContentHash) {
    fail("GATE6_SIM_WORKSPACE_FAULT_AFTER_HASH_MISMATCH", task.taskId);
  }
  const expectedInjectionId = sha256(JSON.stringify({
    commitSha: task.commitSha,
    path: fault.path,
    beforeBlobSha: fault.beforeBlobSha,
    beforeContentHash: fault.beforeContentHash,
    afterContentHash: fault.afterContentHash,
    symbol: fault.symbol,
    replacementSymbol: fault.replacementSymbol,
    defaultExportRemoved: fault.defaultExportRemoved
  }));
  if (expectedInjectionId !== fault.injectionId) {
    fail("GATE6_SIM_WORKSPACE_FAULT_ID_MISMATCH", task.taskId);
  }
  await writeFile(fullPath, mutated);
  return Object.freeze({ ...fault });
}

function parseChangedFiles(status) {
  const result = [];
  for (const line of String(status).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let filePath = line.slice(3).trim();
    const arrow = filePath.lastIndexOf(" -> ");
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    if (safeRelativePath(filePath)) result.push(filePath);
  }
  return [...new Set(result)].sort();
}

function findFrozenResult(freezeDocument, taskId) {
  for (const attestation of freezeDocument?.attestations ?? []) {
    const result = (attestation.results ?? []).find((entry) => entry.taskId === taskId);
    if (result) return result;
  }
  return null;
}

function createDisposableWorkspaceFactory(options = {}) {
  const cloneSourceResolver = options.cloneSourceResolver ??
    ((repositoryId) => `https://github.com/${repositoryId}.git`);
  const tempParent = options.tempParent ?? tmpdir();

  return Object.freeze({
    async create({ task, freezeDocument }) {
      if (!task || typeof task !== "object") fail("GATE6_SIM_WORKSPACE_TASK_INVALID");
      const temporaryRoot = await mkdtemp(path.join(tempParent, "gate6-simulated-"));
      const checkout = path.join(temporaryRoot, "checkout");
      const workspaceId = `gate6-sim-${randomUUID()}`;
      let disposed = false;
      let fixtureReceipt = null;
      try {
        const cloneSource = cloneSourceResolver(task.repositoryId);
        await exec("git", ["clone", "--quiet", "--no-checkout", "--no-hardlinks", cloneSource, checkout], {
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
          maxBuffer: 32 * 1024 * 1024
        });
        await runGit(checkout, ["checkout", "--quiet", "--detach", task.commitSha]);
        const head = await runGit(checkout, ["rev-parse", "HEAD"]);
        if (head !== task.commitSha) fail("GATE6_SIM_WORKSPACE_COMMIT_MISMATCH", `${head} != ${task.commitSha}`);
        await runGit(checkout, ["remote", "remove", "origin"]);

        const frozenResult = findFrozenResult(freezeDocument, task.taskId);
        if (!frozenResult) fail("GATE6_SIM_WORKSPACE_FROZEN_RESULT_MISSING", task.taskId);
        const expected = task.taskClass === "no_change_needed" ? "pass" : "fail";
        if (frozenResult.baselineExpected !== expected || frozenResult.baselineObserved !== expected) {
          fail("GATE6_SIM_WORKSPACE_BASELINE_RECEIPT_MISMATCH", task.taskId);
        }
        if (expected === "fail") fixtureReceipt = await applyFrozenFault(checkout, task, frozenResult);
        else if (frozenResult.faultInjection !== null) fail("GATE6_SIM_WORKSPACE_NO_CHANGE_FAULT_FORBIDDEN", task.taskId);

        async function read(relativePath) {
          if (!safeRelativePath(relativePath)) fail("GATE6_SIM_WORKSPACE_PATH_INVALID", relativePath);
          return readFile(path.join(checkout, ...relativePath.split("/")), "utf8");
        }
        async function write(relativePath, content) {
          if (!safeRelativePath(relativePath)) fail("GATE6_SIM_WORKSPACE_PATH_INVALID", relativePath);
          return writeFile(path.join(checkout, ...relativePath.split("/")), content, "utf8");
        }
        async function changedFiles() {
          return parseChangedFiles(await runGit(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]));
        }
        async function repositorySnapshot() {
          const files = [];
          for (const relativePath of [...task.candidateFiles].sort()) {
            files.push({ path: relativePath, content: await read(relativePath) });
          }
          return Object.freeze({
            schemaVersion: "gate6-repository-snapshot/v1",
            repositoryId: task.repositoryId,
            commitSha: task.commitSha,
            files: Object.freeze(files.map((entry) => Object.freeze(entry)))
          });
        }
        async function rollback() {
          await runGit(checkout, ["reset", "--hard", task.commitSha]);
          await runGit(checkout, ["clean", "-fd"]);
          if (fixtureReceipt) await applyFrozenFault(checkout, task, frozenResult);
          return (await changedFiles()).sort().join("\n") ===
            (fixtureReceipt ? [fixtureReceipt.path].sort().join("\n") : "");
        }
        async function dispose() {
          if (disposed) return true;
          await rm(temporaryRoot, { recursive: true, force: true });
          disposed = true;
          return true;
        }

        return Object.freeze({
          version: WORKSPACE_VERSION,
          workspaceId,
          root: checkout,
          fixtureReceipt,
          read,
          write,
          changedFiles,
          repositorySnapshot,
          rollback,
          dispose,
          async assertOriginalRepositoryUnchanged() { return true; }
        });
      } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
      }
    }
  });
}

module.exports = {
  WORKSPACE_VERSION,
  Gate6SimulatedWorkspaceError,
  applyFrozenFault,
  createDisposableWorkspaceFactory,
  safeRelativePath,
  sha256
};
