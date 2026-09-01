"use strict";

const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stripTypeScriptTypes } = require("node:module");
const { PROBE_VERSION, getProbe } = require("./lib/gate6-precondition-probes.cjs");

const ROOT = path.resolve(__dirname, "..");
const PRECONDITION_SCHEMA = "gate6-preconditions/v1";
const ATTESTATION_SCHEMA = "gate6-precondition-attestation/v1";
const RUNNER_VERSION = "gate6-precondition-runner/v2";
const PROBE_FILE = ".gate6-probe.mjs";

const SETUP_PROFILES = Object.freeze({
  "sindresorhus/p-limit": { dependencies: ["yocto-queue@1.2.1"] },
  "sindresorhus/query-string": { dependencies: ["decode-uri-component@0.5.0", "filter-obj@5.1.0", "split-on-first@3.0.0"] },
  "sindresorhus/slugify": { dependencies: ["@sindresorhus/transliterate@2.0.0", "escape-string-regexp@5.0.0"] },
  "sindresorhus/p-queue": { dependencies: ["eventemitter3@5.0.4", "p-timeout@7.0.0"], transformTypeScript: true },
  "sindresorhus/is": { transformTypeScript: true },
  "sindresorhus/ky": { transformTypeScript: true }
});

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
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 5 * 60 * 1000
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status === null ? 255 : result.status,
    signal: result.signal ?? null,
    stdoutTail: String(result.stdout ?? "").slice(-6000),
    stderrTail: String(result.stderr ?? "").slice(-6000),
    error: result.error ? String(result.error.message ?? result.error) : null
  };
}
function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.exitCode !== 0) fail("GATE6_PRECONDITION_COMMAND_FAILED", `${result.command}\n${result.stderrTail}\n${result.stdoutTail}`);
  return result;
}
function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repository") result.repositoryId = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--workspace") result.workspace = argv[++index];
    else fail("GATE6_PRECONDITION_ARG_UNKNOWN", arg);
  }
  if (!result.repositoryId) fail("GATE6_PRECONDITION_REPOSITORY_REQUIRED");
  return result;
}
function loadShards(field) {
  const lock = readJson(path.join(ROOT, "benchmarks/gate6/taskset.json"));
  const paths = field === "tasks" ? lock.taskFiles : lock.oracleFiles;
  return paths.flatMap((relative) => readJson(path.join(ROOT, relative))[field]);
}
function loadDataset() {
  const tasks = loadShards("tasks");
  const oracles = loadShards("oracles");
  const manifest = readJson(path.join(ROOT, "benchmarks/gate6/repositories.json"));
  const preconditions = readJson(path.join(ROOT, "benchmarks/gate6/preconditions.json"));
  if (preconditions.schemaVersion !== PRECONDITION_SCHEMA || !Array.isArray(preconditions.entries)) fail("GATE6_PRECONDITION_SCHEMA_INVALID");
  return { tasks, oracles, manifest, preconditions };
}
function validateCoverage(dataset) {
  const taskById = new Map(dataset.tasks.map((task) => [task.taskId, task]));
  const entries = new Map();
  for (const entry of dataset.preconditions.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.taskId !== "string") fail("GATE6_PRECONDITION_ENTRY_INVALID");
    if (entries.has(entry.taskId)) fail("GATE6_PRECONDITION_DUPLICATE_TASK", entry.taskId);
    const task = taskById.get(entry.taskId);
    if (!task) fail("GATE6_PRECONDITION_UNKNOWN_TASK", entry.taskId);
    const expected = task.taskClass === "no_change_needed" ? "pass" : "fail";
    if (entry.baselineExpected !== expected) fail("GATE6_PRECONDITION_CLASS_EXPECTATION_MISMATCH", entry.taskId);
    if (!entry.acceptanceCheck || entry.acceptanceCheck.type !== "node_probe" || entry.acceptanceCheck.probeId !== entry.taskId) {
      fail("GATE6_PRECONDITION_ACCEPTANCE_CHECK_INVALID", entry.taskId);
    }
    getProbe(entry.acceptanceCheck.probeId);
    if (expected === "pass" && entry.faultInjection !== null) fail("GATE6_PRECONDITION_NO_CHANGE_INJECTION_FORBIDDEN", entry.taskId);
    if (expected === "fail" && (!entry.faultInjection || entry.faultInjection.type !== "rename_primary_required_symbol")) {
      fail("GATE6_PRECONDITION_MUTATION_INJECTION_REQUIRED", entry.taskId);
    }
    entries.set(entry.taskId, entry);
  }
  if (entries.size !== taskById.size) fail("GATE6_PRECONDITION_COVERAGE_INVALID", `${entries.size}/${taskById.size}`);
  return entries;
}
function candidateTestFiles(task, oracle) {
  if (oracle.requiredTestFiles.length > 0) return oracle.requiredTestFiles;
  return task.candidateFiles.filter((file) => /(^|\/)(test|tests)(\/|\.|$)|\.test\.|\.spec\./i.test(file));
}
function verifyEvidence(repoPath, task, oracle) {
  const files = candidateTestFiles(task, oracle);
  for (const relative of files) {
    if (!existsSync(path.join(repoPath, relative))) fail("GATE6_PRECONDITION_TEST_FILE_MISSING", `${task.taskId}:${relative}`);
  }
  for (const anchor of oracle.requiredTestAnchors) {
    let found = false;
    for (const relative of files) {
      if (readFileSync(path.join(repoPath, relative), "utf8").includes(anchor)) { found = true; break; }
    }
    if (!found) fail("GATE6_PRECONDITION_TEST_ANCHOR_MISSING", `${task.taskId}:${anchor}`);
  }
  if (!Array.isArray(oracle.behavioralChecks) || oracle.behavioralChecks.length === 0) fail("GATE6_PRECONDITION_BEHAVIOR_CHECK_MISSING", task.taskId);
  return {
    testFiles: [...files].sort(compareText),
    requiredTestAnchors: [...oracle.requiredTestAnchors].sort(compareText),
    behavioralChecks: [...oracle.behavioralChecks]
  };
}
function gitBlobSha(repoPath, relative) {
  return mustRun("git", ["rev-parse", `HEAD:${relative}`], { cwd: repoPath }).stdoutTail.trim();
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
  for (const relative of oracle.requiredImplementationFiles ?? []) {
    const full = path.join(repoPath, relative);
    if (!existsSync(full)) continue;
    const original = readFileSync(full, "utf8");
    for (const symbol of oracle.requiredSymbols ?? []) {
      for (const pattern of declarationPatterns(symbol)) {
        const match = pattern.exec(original);
        if (!match) continue;
        const replacementSymbol = `${symbol}__GATE6_FAULT`;
        const mutatedMatch = match[0].replace(symbol, replacementSymbol);
        const mutated = original.slice(0, match.index) + mutatedMatch + original.slice(match.index + match[0].length);
        if (mutated === original) continue;
        const beforeBlobSha = gitBlobSha(repoPath, relative);
        const beforeContentHash = sha256(original);
        writeFileSync(full, mutated);
        const afterContentHash = sha256(mutated);
        return {
          type: "rename_primary_required_symbol",
          path: relative,
          symbol,
          replacementSymbol,
          beforeBlobSha,
          beforeContentHash,
          afterContentHash,
          injectionId: sha256(JSON.stringify({ commitSha: task.commitSha, path: relative, beforeBlobSha, beforeContentHash, afterContentHash, symbol, replacementSymbol }))
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
function installExactRuntimeDependencies(repoPath, repositoryId) {
  const profile = SETUP_PROFILES[repositoryId] ?? {};
  if (!profile.dependencies?.length) return [];
  const args = ["install", "--no-save", "--package-lock=false", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", ...profile.dependencies];
  mustRun("npm", args, { cwd: repoPath, timeout: 10 * 60 * 1000 });
  return [...profile.dependencies];
}
function walk(directory, callback) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, callback);
    else callback(full);
  }
}
function transformTypeScript(repoPath, repositoryId) {
  const profile = SETUP_PROFILES[repositoryId] ?? {};
  if (!profile.transformTypeScript) return;
  const sourceRoot = path.join(repoPath, "source");
  if (!existsSync(sourceRoot)) fail("GATE6_PRECONDITION_TYPESCRIPT_SOURCE_MISSING", repositoryId);
  const outputRoot = path.join(repoPath, ".gate6-runtime/source");
  walk(sourceRoot, (full) => {
    const relative = path.relative(sourceRoot, full);
    if (!relative.endsWith(".ts")) return;
    const target = path.join(outputRoot, relative.replace(/\.ts$/, ".js"));
    mkdirSync(path.dirname(target), { recursive: true });
    let code;
    try {
      code = stripTypeScriptTypes(readFileSync(full, "utf8"), { mode: "transform", sourceMap: false });
    } catch (error) {
      fail("GATE6_PRECONDITION_TYPESCRIPT_TRANSFORM_FAILED", `${repositoryId}:${relative}:${error.message}`);
    }
    code = code.replace(/(["'])((?:\.\.?\/)[^"']+)\.ts\1/g, "$1$2.js$1");
    writeFileSync(target, code);
  });
}
function prepareRuntime(repoPath, repositoryId) {
  transformTypeScript(repoPath, repositoryId);
}
function runProbe(repoPath, taskId) {
  const probe = getProbe(taskId);
  writeFileSync(path.join(repoPath, PROBE_FILE), `${probe}\n`);
  return run("node", [PROBE_FILE], { cwd: repoPath, timeout: 60 * 1000 });
}
function main() {
  const args = parseArgs(process.argv);
  const dataset = loadDataset();
  const entries = validateCoverage(dataset);
  const repository = dataset.manifest.repositories.find((item) => item.id === args.repositoryId);
  if (!repository) fail("GATE6_PRECONDITION_REPOSITORY_UNKNOWN", args.repositoryId);
  const tasks = dataset.tasks.filter((task) => task.repositoryId === args.repositoryId).sort((a, b) => compareText(a.taskId, b.taskId));
  if (tasks.length !== 3) fail("GATE6_PRECONDITION_REPOSITORY_TASK_COUNT_INVALID", `${args.repositoryId}:${tasks.length}`);
  const oracleById = new Map(dataset.oracles.map((oracle) => [oracle.taskId, oracle]));

  const workspace = args.workspace ? path.resolve(args.workspace) : mkdtempSync(path.join(tmpdir(), "gate6-precondition-"));
  mkdirSync(workspace, { recursive: true });
  const repoPath = path.join(workspace, "repo");
  mustRun("git", ["clone", "--no-checkout", `https://github.com/${repository.id}.git`, repoPath], { timeout: 10 * 60 * 1000 });
  mustRun("git", ["checkout", "--detach", repository.commitSha], { cwd: repoPath, timeout: 10 * 60 * 1000 });
  const head = mustRun("git", ["rev-parse", "HEAD"], { cwd: repoPath }).stdoutTail.trim();
  if (head !== repository.commitSha) fail("GATE6_PRECONDITION_COMMIT_MISMATCH", `${head} != ${repository.commitSha}`);

  const exactRuntimeDependencies = installExactRuntimeDependencies(repoPath, repository.id);
  const runnerHash = sha256(readFileSync(__filename));
  const probeCatalogHash = sha256(readFileSync(path.join(__dirname, "lib/gate6-precondition-probes.cjs")));
  const results = [];

  for (const task of tasks) {
    const entry = entries.get(task.taskId);
    const oracle = oracleById.get(task.taskId);
    if (!oracle) fail("GATE6_PRECONDITION_ORACLE_MISSING", task.taskId);
    resetRepository(repoPath, repository.commitSha);
    prepareRuntime(repoPath, repository.id);
    const evidence = verifyEvidence(repoPath, task, oracle);
    const cleanProbe = runProbe(repoPath, entry.acceptanceCheck.probeId);
    if (cleanProbe.exitCode !== 0) {
      fail("GATE6_PRECONDITION_CLEAN_PROBE_FAILED", `${task.taskId}\n${cleanProbe.stderrTail}\n${cleanProbe.stdoutTail}`);
    }

    if (entry.baselineExpected === "pass") {
      results.push({
        taskId: task.taskId,
        repositoryId: task.repositoryId,
        commitSha: task.commitSha,
        probeId: entry.acceptanceCheck.probeId,
        baselineExpected: "pass",
        baselineObserved: "pass",
        cleanAcceptanceExitCode: 0,
        injectedAcceptanceExitCode: null,
        faultInjection: null,
        evidence
      });
      continue;
    }

    resetRepository(repoPath, repository.commitSha);
    const injection = applyFaultInjection(repoPath, oracle, task);
    prepareRuntime(repoPath, repository.id);
    const injectedProbe = runProbe(repoPath, entry.acceptanceCheck.probeId);
    const observed = injectedProbe.exitCode === 0 ? "pass" : "fail";
    if (observed !== "fail") fail("GATE6_PRECONDITION_INJECTED_PROBE_DID_NOT_FAIL", task.taskId);
    results.push({
      taskId: task.taskId,
      repositoryId: task.repositoryId,
      commitSha: task.commitSha,
      probeId: entry.acceptanceCheck.probeId,
      baselineExpected: "fail",
      baselineObserved: "fail",
      cleanAcceptanceExitCode: 0,
      injectedAcceptanceExitCode: injectedProbe.exitCode,
      faultInjection: injection,
      evidence
    });
  }

  const attestationCore = {
    schemaVersion: ATTESTATION_SCHEMA,
    runnerVersion: RUNNER_VERSION,
    probeVersion: PROBE_VERSION,
    runnerHash,
    probeCatalogHash,
    repositoryId: repository.id,
    commitSha: repository.commitSha,
    taskCount: results.length,
    exactRuntimeDependencies,
    acceptanceType: "node_probe",
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
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code ?? "GATE6_PRECONDITION_UNEXPECTED", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
