"use strict";

const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { validateAttestations } = require("./lib/gate6-precondition-freeze.cjs");

const ROOT = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadShards(field) {
  const lock = readJson(path.join(ROOT, "benchmarks/gate6/taskset.json"));
  const shardPaths = field === "tasks" ? lock.taskFiles : lock.oracleFiles;
  return shardPaths.flatMap((relativePath) => readJson(path.join(ROOT, relativePath))[field]);
}

function collectJsonFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, name.name);
      if (name.isDirectory()) visit(fullPath);
      else if (name.isFile() && name.name.endsWith(".json")) files.push(fullPath);
    }
  };
  visit(directory);
  return files.sort();
}

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifacts") result.artifacts = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--workflow-run-id") result.workflowRunId = Number(argv[++index]);
    else if (arg === "--workflow-head-sha") result.workflowHeadSha = argv[++index];
    else throw new Error(`GATE6_PRECONDITION_FREEZE_ARG_UNKNOWN: ${arg}`);
  }
  if (!result.artifacts || !result.output || !Number.isInteger(result.workflowRunId) || !/^[0-9a-f]{40}$/.test(result.workflowHeadSha ?? "")) {
    throw new Error("GATE6_PRECONDITION_FREEZE_ARGS_INVALID");
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const tasks = loadShards("tasks");
  const repositories = readJson(path.join(ROOT, "benchmarks/gate6/repositories.json")).repositories;
  const preconditions = readJson(path.join(ROOT, "benchmarks/gate6/preconditions.json"));
  const attestationFiles = collectJsonFiles(path.resolve(args.artifacts));
  const attestations = attestationFiles.map(readJson);
  const freeze = validateAttestations({ preconditions, tasks, repositories, attestations });

  const document = {
    schemaVersion: "gate6-precondition-freeze-document/v1",
    status: "verified_42_of_42",
    workflowRunId: args.workflowRunId,
    workflowHeadSha: args.workflowHeadSha,
    freeze,
    attestations: [...attestations].sort((left, right) => left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0)
  };

  writeFileSync(path.resolve(args.output), `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    workflowRunId: document.workflowRunId,
    workflowHeadSha: document.workflowHeadSha,
    taskCount: freeze.taskCount,
    passBaselineCount: freeze.passBaselineCount,
    failBaselineCount: freeze.failBaselineCount,
    preconditionAttestationHash: freeze.preconditionAttestationHash
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
