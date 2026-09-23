#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { sourceOriginal } = require("./codex-v1-fixture.cjs");
const { createCompareTrustedFixture } = require("./codex-v1-compare-trusted-fixture.cjs");

const projectRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(projectRoot, "dist/apps/cli/src/index.js");

async function writeHostModule(parent) {
  const file = path.join(parent, "trusted-host", "compare-host.mjs");
  await fs.writeFile(file, [
    "let sequence = 0;",
    "const pending = new Map();",
    "process.on('message', (reply) => {",
    "  const item = pending.get(reply.id);",
    "  if (!item) return;",
    "  pending.delete(reply.id);",
    "  if (pending.size === 0) process.channel.unref();",
    "  if (reply.error) item.reject(new Error(reply.error));",
    "  else item.resolve(reply.value);",
    "});",
    "process.channel.unref();",
    "function request(kind, value) {",
    "  return new Promise((resolve, reject) => {",
    "    const id = ++sequence;",
    "    pending.set(id, { resolve, reject });",
    "    process.channel.ref();",
    "    process.send({ id, kind, value });",
    "  });",
    "}",
    "export const model = 'fixture-model';",
    "export const adapter = {",
    "  agentId: 'codex', agentVersion: 'offline-compare/v1',",
    "  run: (value) => request('agent', value)",
    "};",
    "export const prepareValidationSubstrate = () => request('substrate', null);",
    "export async function trustedBehavior(value) {",
    "  const reply = await request('trusted', value);",
    "  return { ...reply, hostKey: Buffer.from(reply.hostKeyHex, 'hex') };",
    "}",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o400 });
  return file;
}

async function invokeCli(fixture, modulePath, variant, trustedHostPath = modulePath) {
  const env = {
    ...process.env,
    CI: "1", NODE_ENV: "test", CODEX_API_KEY: "", OPENAI_API_KEY: "",
    BOUNDED_COMPARE_OFFLINE_FIXTURE_MODULE: modulePath
  };
  delete env.BOUNDED_COMPARE_TRUSTED_HOST_MODULE;
  if (trustedHostPath) env.BOUNDED_COMPARE_TRUSTED_HOST_MODULE = trustedHostPath;
  const child = fork(cliPath, ["compare", "codex", "--task", "Make calculate multiply by three.", "--json"], {
    cwd: fixture.repository, env, silent: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", async (message) => {
    try {
      let value;
      if (message.kind === "agent") value = await fixture.adapter.run(message.value);
      else if (message.kind === "substrate") value = await fixture.prepareValidationSubstrate();
      else if (message.kind === "trusted") {
        const proof = await fixture.trustedBehavior(variant, message.value);
        value = { ...proof, hostKeyHex: proof.hostKey.toString("hex"), hostKey: undefined };
      } else throw new Error(`Unexpected IPC request: ${message.kind}`);
      child.send({ id: message.id, value });
    } catch (error) {
      child.send({ id: message.id, error: String(error.stack ?? error) });
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return { code, stdout, stderr, output: JSON.parse(stdout) };
}

async function main() {
  const reports = [];
  for (const variant of ["valid", "missing", "corrupt", "wrong_candidate", "no_authority"]) {
    const fixture = await createCompareTrustedFixture(projectRoot);
    const hostModule = await writeHostModule(fixture.parent);
    const before = fixture.counters.trusted;
    const result = await invokeCli(fixture, hostModule, variant,
      variant === "no_authority" ? null : hostModule);
    assert.equal(result.code, 0, `${variant}: ${result.stderr}\n${result.stdout}`);
    const expectedCalls = variant === "no_authority" ? 0 : 1;
    assert.equal(fixture.counters.trusted, before + expectedCalls);
    const report = result.output;
    const candidate = report.boundedCandidate;
    const issuedReceipt = fixture.issuedReceipt();
    assert.ok(candidate && report.runId);
    if (variant !== "no_authority") {
      assert.equal(candidate.taskId, issuedReceipt.taskId);
      assert.equal(candidate.taskHash, issuedReceipt.taskHash);
      assert.equal(candidate.candidateTreeHash, fixture.observedCandidateTreeHash());
      if (variant !== "wrong_candidate") assert.equal(candidate.candidateTreeHash, issuedReceipt.candidateTreeHash);
      if (variant === "wrong_candidate") assert.notEqual(candidate.candidateTreeHash, issuedReceipt.candidateTreeHash);
    }
    assert.equal(report.task, "Make calculate multiply by three.");
    assert.equal(report.sourceRepositoryUnchanged, true);
    assert.equal(report.providerComparison.arms.bounded.sourceRepositorySnapshotHash, fixture.sourceTreeHash);
    assert.equal(report.providerComparison.arms.bounded.sourceCommitSha, fixture.sourceCommitSha);
    assert.equal(report.evaluations.bounded.correctness.taskSucceeded,
      variant === "valid" ? true : null);
    assert.equal(report.evaluations.bounded.correctness.behaviorSatisfied,
      variant === "valid" ? true : null);
    assert.equal(report.evaluations.bounded.schemaVersion,
      variant === "no_authority" ? "product-comparison-evaluation/v2" : "product-comparison-evaluation/v3");
    const stored = JSON.parse(await fs.readFile(
      path.join(fixture.repository, ".bounded/runs", report.runId, "comparison.json"), "utf8"
    ));
    assert.deepEqual(stored.boundedCandidate, candidate);
    assert.deepEqual(stored.evaluations.bounded, report.evaluations.bounded);
    assert.equal(await fs.readFile(path.join(fixture.repository, "src/calculate.js"), "utf8"), sourceOriginal);
    reports.push({ variant, runId: report.runId, taskId: candidate.taskId,
      taskHash: candidate.taskHash, handoffHash: candidate.handoffHash,
      candidateTreeHash: candidate.candidateTreeHash,
      schemaVersion: report.evaluations.bounded.schemaVersion,
      behavior: report.evaluations.bounded.correctness.behaviorSatisfied,
      taskSucceeded: report.evaluations.bounded.correctness.taskSucceeded,
      fixtureRoot: fixture.parent, evidenceDirectory: fixture.evidenceDirectory });
    assert.equal(fixture.counters.discovery, 1);
    assert.equal(fixture.counters.baseline, 1);
  }
  const fixture = await createCompareTrustedFixture(projectRoot);
  const hostModule = await writeHostModule(fixture.parent);
  const rejected = await invokeCli(fixture, hostModule, "unreachable",
    path.join(fixture.repository, "src/calculate.js"));
  assert.equal(rejected.code, 5);
  assert.equal(rejected.output.code, "cli_compare_host_boundary_invalid");
  assert.equal(fixture.counters.trusted, 0);
  assert.equal(fixture.counters.discovery, 0);
  process.stdout.write(`${JSON.stringify({ result: "PASS", entrypoint: cliPath,
    reports, rejectedRepositoryHost: rejected.output.code }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
