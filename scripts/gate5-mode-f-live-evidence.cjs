#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const REPORT_SCHEMA = "gate5-mode-f-live-evidence/v1";
const BENCHMARK = "scripts/gate5-adaptive-compressed-boundary.cjs";
const DEFAULT_REPETITIONS = 3;

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return sha256(Buffer.from(canonical(value), "utf8"));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1_000_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function benchmarkBlob(sourceCommit) {
  const value = git(["rev-parse", `${sourceCommit}:${BENCHMARK}`]);
  if (!/^[0-9a-f]{40,64}$/.test(value)) fail("benchmark_blob_invalid");
  return value;
}

function sanitizeEndpoint(endpoint) {
  if (!endpoint) return null;
  let url;
  try { url = new URL(endpoint); } catch { fail("GATE5_OPENAI_ENDPOINT_invalid"); }
  if (!["http:", "https:"].includes(url.protocol)) fail("GATE5_OPENAI_ENDPOINT_invalid");
  if (url.username || url.password || url.search || url.hash) fail("GATE5_OPENAI_ENDPOINT_invalid");
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || null,
    path: url.pathname
  };
}

function validatePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name}_invalid`);
  return parsed;
}

function main() {
  const live = process.argv.includes("--live");
  const repetitions = validatePositiveInt(
    argument("--repetitions") ?? String(DEFAULT_REPETITIONS),
    "repetitions"
  );
  const outputPath = resolve(argument("--output") ??
    (live ? "reports/gate5/mode-f-live-evidence.json" :
      "reports/gate5/mode-f-fixture-evidence.json"));
  const rawPath = resolve(`${outputPath}.raw.json`);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail("source_commit_invalid");
  if (git(["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
    fail("tracked_worktree_must_be_clean");
  }

  const model = live ? process.env.GATE5_MODEL : "fixture-mode-f-model";
  const endpoint = live ? process.env.GATE5_OPENAI_ENDPOINT : null;
  if (live && (!model || !endpoint)) {
    fail("live_mode_requires_GATE5_MODEL_and_GATE5_OPENAI_ENDPOINT");
  }
  const maxCompletionTokens = validatePositiveInt(
    process.env.GATE5_MAX_COMPLETION_TOKENS ?? "256",
    "GATE5_MAX_COMPLETION_TOKENS"
  );
  const config = {
    model,
    transport: live ? "openai_compatible_http" : "fixture",
    endpoint: sanitizeEndpoint(endpoint),
    temperature: 0,
    maxCompletionTokens,
    repetitions
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  rmSync(rawPath, { force: true });
  const args = [BENCHMARK, `--repetitions=${repetitions}`, `--output=${rawPath}`];
  if (live) args.push("--live");
  execFileSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    maxBuffer: 10_000_000
  });

  const rawBytes = readFileSync(rawPath);
  const rawReport = JSON.parse(rawBytes.toString("utf8"));
  if (rawReport.repetitions !== repetitions || rawReport.modeCount !== 3 ||
      rawReport.taskCount !== 3 || rawReport.sampleCount !== repetitions * 9 ||
      !Array.isArray(rawReport.results) || !Array.isArray(rawReport.aggregates)) {
    fail("raw_report_shape_invalid");
  }
  const expectedExecutionClass = live
    ? "live_adaptive_compressed_boundary"
    : "fixture_adaptive_compressed_boundary";
  if (rawReport.executionClass !== expectedExecutionClass) fail("raw_execution_class_invalid");
  const modes = rawReport.aggregates.map((entry) => entry.mode).sort();
  const expectedModes = [
    "C_synthetic_context",
    "E_bounded_workspace_boundary",
    "F_adaptive_compressed_boundary"
  ].sort();
  if (JSON.stringify(modes) !== JSON.stringify(expectedModes)) fail("raw_modes_invalid");

  const benchmarkBytes = readFileSync(resolve(BENCHMARK));
  const core = {
    schemaVersion: REPORT_SCHEMA,
    researchStatus: live ? "observed_live_result" : "fixture_contract",
    researchQuestion:
      "Can adaptive compressed boundary F reduce E-style bounded-context cost while preserving exact scope and critical evidence quality?",
    sourceCommit,
    benchmarkPath: BENCHMARK,
    benchmarkGitBlob: benchmarkBlob(sourceCommit),
    benchmarkFileHash: sha256(benchmarkBytes),
    experimentConfig: config,
    experimentConfigHash: hashCanonical(config),
    immutableExternalRepositories: rawReport.tasks.map((task) => ({
      repository: task.repository,
      commitSha: task.commitSha,
      taskId: task.taskId
    })),
    rawReportPath: `${outputPath.split("/").at(-1)}.raw.json`,
    rawReportByteHash: sha256(rawBytes),
    rawReportHash: rawReport.reportHash,
    executionClass: rawReport.executionClass,
    sampleCount: rawReport.sampleCount,
    aggregates: rawReport.aggregates
  };
  const evidence = { ...core, evidenceHash: hashCanonical(core) };
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  process.stdout.write([
    "MODE_F_EVIDENCE=PASS",
    `researchStatus=${evidence.researchStatus}`,
    `sourceCommit=${sourceCommit}`,
    `model=${model}`,
    `experimentConfigHash=${evidence.experimentConfigHash}`,
    `rawReportHash=${evidence.rawReportHash}`,
    `evidenceHash=${evidence.evidenceHash}`,
    `sampleCount=${evidence.sampleCount}`
  ].join("\n") + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`MODE_F_EVIDENCE=FAIL\nerror=${error?.message ?? error}\n`);
  process.exitCode = 1;
}
