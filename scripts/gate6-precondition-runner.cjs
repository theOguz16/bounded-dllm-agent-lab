"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PRECONDITION_SCHEMA = "gate6-preconditions/v1";
const ATTESTATION_SCHEMA = "gate6-precondition-attestation/v1";

class Gate6PreconditionError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "Gate6PreconditionError";
    this.code = code;
  }
}

function fail(code, detail) { throw new Gate6PreconditionError(code, detail); }
function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sha256(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 20 * 60 * 1000
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status === null ? 255 : result.status,
    signal: result.signal ?? null,
    stdoutTail: String(result.stdout ?? "").slice(-8000),
    stderrTail: String(result.stderr ?? "").slice(-8000),
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}
function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exitCode !== 0) fail("GATE6_PRECONDITION_COMMAND_FAILED", `${result.command}\n${result.stderrTail}`);
  return result;
}
function parseArgs(argv) {
  const result = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repository") result.repositoryId = argv[++i];
    else if (arg === "--output") result.output = argv[++i];
    else if (arg === "--workspace") result.workspace = argv[++i];
    else fail("GATE6_PRECONDITION_ARG_UNKNOWN", arg);
  }
  if (!result.repositoryId) fail("GATE6_PRECONDITION_REPOSITORY_REQUIRED");
  return result;
}
function loadShards(directory, field) {
  const lock = readJson(path.join(ROOT, "benchmarks/gate6/taskset.json"));
  const paths = field === "tasks" ? lock.taskFiles : lock.oracleFiles;
  return paths.flatMap((relative) => {
    const document = readJson(path.join(ROOT, relative));
    return document[field];
  });
}
function loadDataset() {
  const tasks = loadShards(path.join(ROOT, "benchmarks/gate6/tasks"), "tasks");
  const oracles = loadShards(path.join(ROOT, "benchmarks/gate6/oracles"), "oracles");
  const manifest = readJson(path.join(ROOT, "benchmarks/gate6/repositories.json"));
  const preconditions = readJson(path.join(ROOT, "benchmarks/gate6/preconditions.json"));
  if (preconditions.schemaVersion !== PRECONDITION_SCHEMA || !Array.isArray(preconditions.entries)) {
    fail("GATE6_PRECONDITION_SCHEMA_INVALID");
  }
  return { tasks, oracles, manifest, preconditions };
}
function validateTaskPreconditionCoverage(dataset) {
  const taskIds = new Set(dataset.tasks.map((task) => task.taskId));
  const entries = new Map();
  for (const entry of dataset.preconditions.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.taskId !== "string") fail("GATE6_PRECONDITION_ENTRY_INVALID");
    if (entries.has(entry.taskId)) fail("GATE6_PRECONDITION_DUPLICATE_TASK", entry.taskId);
    if (!taskIds.has(entry.taskId)) fail("GATE6_PRECONDITION_UNKNOWN_TASK", entry.taskId);
    if (!['pass', 'fail'].includes(entry.baselineExpected)) fail("GATE6_PRECONDITION_EXPECTATION_INVALID", entry.taskId);
    if (!entry.acceptanceCheck || entry.acceptanceCheck.type !== "repository_test_suite" || entry.acceptanceCheck.command !== "npm test") {
      fail("GATE6_PRECONDITION_ACCEPTANCE_CHECK_INVALID", entry.taskId);
    }
    if (entry.baselineExpected === "pass" && entry.faultInjection !== null) fail("GATE6_PRECONDITION_NO_CHANGE_INJECTION_FORBIDDEN", entry.taskId);
    if (entry.baselineExpected === "fail" && (!entry.faultInjection || entry.faultInjection.type !== "rename_primary_required_symbol")) {
      fail("GATE6_PRECONDITION_MUTATION_INJECTION_REQUIRED", entry.taskId);
    }
    entries.set(entry.taskId, entry);
  }
  if (entries.size !== taskIds.size) fail("GATE6_PRECONDITION_COVERAGE_INVALID", `${entries.size}/${taskIds.size}`);
  for (const task of dataset.tasks) {
    const expected = task.taskClass === "no_change_needed" ? "pass" : "fail";
    if (entries.get(task.taskId).baselineExpected !== expected) fail("GATE6_PRECONDITION_CLASS_EXPECTATION_MISMATCH", task.taskId);
  }
  return entries;
}
function verifyTestEvidence(repoPath, oracle) {
  if (!Array.isArray(oracle.requiredTestFiles) || !Array.isArray(oracle.requiredTestAnchors)) {
    fail("GATE6_PRECONDITION_ORACLE_TEST_EVIDENCE_INVALID", oracle.taskId);
  }
  for (const relative of oracle.requiredTestFiles) {
    const full = path.join(repoPath, relative);
    if (!existsSync(full)) fail("GATE6_PRECONDITION_TEST_FILE_MISSING", `${oracle.taskId}:${relative}`);
  }
  for (const anchor of oracle.requiredTestAnchors) {
    let found = false;
    for (const relative of oracle.requiredTestFiles) {
      const text = readFileSync(path.join(repoPath, relative), "utf8");
      if (text.includes(anchor)) { found = true; break; }
    }
    if (!found) fail("GATE6_PRECONDITION_TEST_ANCHOR_MISSING", `${oracle.taskId}:${anchor}`);
  }
  return {
    requiredTestFiles: [...oracle.requiredTestFiles].sort(compareText),
    requiredTestAnchors: [...oracle.requiredTestAnchors].sort(compareText),
    behavioralChecks: [...oracle.behavioralChecks]
  };
}
function gitBlobSha(repoPath, relative) {
  const result = mustRun("git", ["rev-parse", `HEAD:${relative}`], { cwd: repoPath });
  return result.stdoutTail.trim();
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
function applyFaultInjection(repoPath, oracle, task) {
  const files = oracle.requiredImplementationFiles ?? [];
  const symbols = oracle.requiredSymbols ?? [];
  if (files.length === 0 || symbols.length === 0) fail("GATE6_PRECONDITION_FAULT_TARGET_MISSING", task.taskId);
  for (const relative of files) {
    const full = path.join(repoPath, relative);
    if (!existsSync(full)) continue;
    const original = readFileSync(full, "utf8");
    for (const symbol of symbols) {
      for (const pattern of declarationPatterns(symbol)) {
        const match = pattern.exec(original);
        if (!match) continue;
        const replacementSymbol = `${symbol}__GATE6_FAULT`;
        const mutated = original.slice(0, match.index) + match[0].replace(symbol, replacementSymbol) + original.slice(match.index + match[0].length);
        if (mutated === original) continue;
        const beforeContentHash = sha256(original);
        const beforeBlobSha = gitBlobSha(repoPath, relative);
        const injectionId = sha256(JSON.stringify({ commitSha: task.commitSha, path: relative, beforeBlobSha, beforeContentHash, symbol, replacementSymbol }));
        writeFileSync(full, mutated);
        return {
          type: "rename_primary_required_symbol",
          path: relative,
          symbol,
          replacementSymbol,
          beforeBlobSha,
          beforeContentHash,
          afterContentHash: sha256(mutated),
          injectionId
        };
      }
    }
  }
  fail("GATE6_PRECONDITION_DECLARATION_UNRESOLVABLE", task.taskId);
}
function resetRepository(repoPath, commitSha) {
  mustRun("git", ["reset", "--hard", commitSha], { cwd: repoPath });
  mustRun("git", ["clean", "-fd", "--exclude=node_modules"], { cwd: repoPath });
}
function installDependencies(repoPath) {
  if (!existsSync(path.join(repoPath, "package.json"))) fail("GATE6_PRECONDITION_PACKAGE_JSON_MISSING");
  if (existsSync(path.join(repoPath, "package-lock.json"))) {
    return mustRun("npm", ["ci", "--no-audit", "--no-fund"], { cwd: repoPath, timeout: 30 * 60 * 1000 });
  }
  return mustRun("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoPath, timeout: 30 * 60 * 1000 });
}
function runAcceptance(repoPath) {
  return run("npm", ["test"], { cwd: repoPath, timeout: 30 * 60 * 1000 });
}
function main() {
  const args = parseArgs(process.argv);
  const dataset = loadDataset();
  const entries = validateTaskPreconditionCoverage(dataset);
  const repository = dataset.manifest.repositories.find((item) => item.id === args.repositoryId);
  if (!repository) fail("GATE6_PRECONDITION_REPOSITORY_UNKNOWN", args.repositoryId);
  const tasks = dataset.tasks.filter((task) => task.repositoryId === args.repositoryId).sort((a, b) => compareText(a.taskId, b.taskId));
  if (tasks.length === 0) fail("GATE6_PRECONDITION_REPOSITORY_TASKS_MISSING", args.repositoryId);
  const oracleById = new Map(dataset.oracles.map((oracle) => [oracle.taskId, oracle]));

  const workspace = args.workspace ? path.resolve(args.workspace) : mkdtempSync(path.join(tmpdir(), "gate6-precondition-"));
  mkdirSync(workspace, { recursive: true });
  const repoPath = path.join(workspace, "repo");
  mustRun("git", ["clone", "--no-checkout", `https://github.com/${repository.id}.git`, repoPath], { timeout: 10 * 60 * 1000 });
  mustRun("git", ["checkout", "--detach", repository.commitSha], { cwd: repoPath, timeout: 10 * 60 * 1000 });
  const head = mustRun("git", ["rev-parse", "HEAD"], { cwd: repoPath }).stdoutTail.trim();
  if (head !== repository.commitSha) fail("GATE6_PRECONDITION_COMMIT_MISMATCH", `${head} != ${repository.commitSha}`);
  const install = installDependencies(repoPath);

  for (const task of tasks) {
    const oracle = oracleById.get(task.taskId);
    if (!oracle) fail("GATE6_PRECONDITION_ORACLE_MISSING", task.taskId);
    verifyTestEvidence(repoPath, oracle);
  }

  resetRepository(repoPath, repository.commitSha);
  const cleanCheck = runAcceptance(repoPath);
  if (cleanCheck.exitCode !== 0) fail("GATE6_PRECONDITION_CLEAN_BASELINE_FAILED", `${repository.id}\n${cleanCheck.stderrTail}\n${cleanCheck.stdoutTail}`);

  const results = [];
  for (const task of tasks) {
    const entry = entries.get(task.taskId);
    const oracle = oracleById.get(task.taskId);
    const evidence = verifyTestEvidence(repoPath, oracle);
    if (entry.baselineExpected === "pass") {
      results.push({
        taskId: task.taskId,
        repositoryId: task.repositoryId,
        commitSha: task.commitSha,
        baselineExpected: "pass",
        baselineObserved: "pass",
        cleanAcceptanceExitCode: cleanCheck.exitCode,
        faultInjection: null,
        evidence
      });
      continue;
    }
    resetRepository(repoPath, repository.commitSha);
    const injection = applyFaultInjection(repoPath, oracle, task);
    const injectedCheck = runAcceptance(repoPath);
    const observed = injectedCheck.exitCode === 0 ? "pass" : "fail";
    if (observed !== "fail") fail("GATE6_PRECONDITION_INJECTED_BASELINE_DID_NOT_FAIL", task.taskId);
    results.push({
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      commitSha: task.commitSha,
      baselineExpected: "fail",
      baselineObserved: observed,
      cleanAcceptanceExitCode: cleanCheck.exitCode,
      injectedAcceptanceExitCode: injectedCheck.exitCode,
      faultInjection: injection,
      evidence
    });
  }

  const attestationCore = {
    schemaVersion: ATTESTATION_SCHEMA,
    repositoryId: repository.id,
    commitSha: repository.commitSha,
    taskCount: results.length,
    installCommand: install.command,
    acceptanceCommand: "npm test",
    results
  };
  const attestation = { ...attestationCore, attestationHash: sha256(JSON.stringify(attestationCore)) };
  const output = args.output ? path.resolve(args.output) : path.join(ROOT, "evidence/gate6/preconditions", `${repository.id.replace("/", "__")}.json`);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, repositoryId: repository.id, taskCount: results.length, output, attestationHash: attestation.attestationHash })}\n`);
}

try { main(); }
catch (error) {
  const payload = { ok: false, code: error && error.code ? error.code : "GATE6_PRECONDITION_UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}
