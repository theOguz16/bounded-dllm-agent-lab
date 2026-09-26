#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRepository, fakeExecutionAdapter, sourceOriginal, sourceChanged,
  testSource } = require("./codex-v1-fixture.cjs");

async function main() {
  const projectRoot = process.cwd();
  const cli = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/commands/codex.js")));
  const repair = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/commands/repair.js")));
  const store = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/run-artifact-store.js")));
  const runtime = await import(pathToFileURL(path.join(projectRoot,
    "dist/packages/product-runtime/src/canonical-runtime.js")));
  const handoff = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/candidate-handoff.js")));
  const apply = await import(pathToFileURL(path.join(projectRoot, "dist/apps/cli/src/commands/apply.js")));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "governed-repair-smoke-"));
  try {
    const created = await createRepository(parent, projectRoot, "governed-repair-fixture");
    const repository = await fs.realpath(created.repository);
    await fs.writeFile(path.join(repository, "test/calculate.test.js"),
      testSource.replace("12", "8"));
    for (const args of [["add", "test/calculate.test.js"],
      ["-c", "user.name=Offline Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "-q", "-m", "baseline acceptance"]]) {
      const git = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr);
    }
    const counters = { execution: 0 };
    const originalCandidateContent = testSource.replace("12", "16");
    const baseAdapter = fakeExecutionAdapter(repository, counters, sourceChanged);
    const adapter = { ...baseAdapter, async run(request) {
      const output = await baseAdapter.run(request);
      if (request.mode === "planner") {
        const plan = JSON.parse(output.finalMessage);
        plan.minimalityPlan.plannedFiles.push({ path: "test/calculate.test.js",
          changeKind: "test", requested: true, justification: null });
        return { ...output, finalMessage: JSON.stringify(plan) };
      }
      await fs.writeFile(path.join(request.workingDirectory, "test/calculate.test.js"),
        originalCandidateContent);
      return { ...output, fileChanges: [...output.fileChanges,
        { sequence: 2, path: "test/calculate.test.js", operation: "modify" }] };
    } };
    const failed = await cli.codexCommand({ task: "Make calculate multiply by three.",
      allowFiles: ["src/calculate.js", "test/calculate.test.js"] }, repository, {
      adapter, model: "fixture-model"
    });
    assert.notEqual(failed.exitCode, 0);
    assert.equal(counters.execution, 2);
    assert.equal(typeof failed.output.taskId, "string", JSON.stringify(failed.output));
    const taskId = failed.output.taskId;
    const locator = store.codexDurableTaskLocator(repository, taskId);
    const state = runtime.readDurableBoundedTaskState(locator);
    assert.ok(["human_review_required", "replan_required", "failed"].includes(state.currentState));
    const taskDirectory = path.join(locator.registryRoot, "tasks",
      runtime.hashCanonicalJson({ taskId, idempotencyKey: locator.idempotencyKey }).slice(7));
    const terminalBefore = await fs.readFile(path.join(taskDirectory, "state.json"));
    const originalArtifactFile = path.join(taskDirectory, state.artifacts["validated-mutation"].relativePath);
    const originalArtifactBefore = await fs.readFile(originalArtifactFile);
    const terminal = runtime.readDurableBoundedTaskArtifact(locator, state, state.terminalResultReference);
    const original = terminal.plannerResult.taskSeedResult.repoResult.adaptiveResult.coderResult.providerOutput;
    assert.equal(runtime.hashCanonicalJson(original), state.mutationArtifactHash);
    const claims = runtime.parseTextFileUpdates(original);
    assert.equal(claims.length, 2);
    const boundary = { originalCandidateHash: state.mutationArtifactHash,
      originalCandidateFiles: ["src/calculate.js", "test/calculate.test.js"],
      policyFiles: [".bounded/policy.yml", "bounded-agent.policy.yml"], acceptanceCriteriaFiles: [] };
    const request = { schemaVersion: "targeted-repair-request/v1",
      originalCandidateHash: state.mutationArtifactHash,
      failingFiles: ["test/calculate.test.js"], failingChecks: ["validation.test"], verifierIssues: [],
      allowedFiles: ["test/calculate.test.js"], preserveFiles: ["src/calculate.js"], repairRound: 1 };
    const mutation = { role: "remask", target: "repairDraft", summary: "Correct deterministic fixture",
      claims: [{ claimVersion: "text-file-update/v1", type: "repair_draft", operation: "update",
        file: "test/calculate.test.js", expectedContentHash: runtime.mutationContentHash(
          Buffer.from(originalCandidateContent)), newContent: testSource, description: "Use accepted response" }],
      touchedFiles: ["test/calculate.test.js"], confidence: 1 };
    const draft = { schemaVersion: "bounded-repair-import/v1", taskId,
      originalCandidateHash: state.mutationArtifactHash, sourceSnapshotHash: state.baselineSnapshotHash,
      validationFailureHash: state.terminalResultHash, boundaryHash: runtime.hashCanonicalJson(boundary),
      request, mutation };
    const file = path.join(parent, "repair.json");
    await fs.writeFile(file, JSON.stringify(draft));
    const noHandoff = await handoff.readCandidateHandoff(repository).catch(() => null);
    assert.equal(noHandoff, null);
    for (const [name, change] of [
      ["wrong hash", { originalCandidateHash: `sha256:${"0".repeat(64)}` }],
      ["widened scope", { request: { ...request, allowedFiles: ["test/calculate.test.js", "package.json"] } }],
      ["stale source binding", { sourceSnapshotHash: `sha256:${"0".repeat(64)}` }],
      ["invalid candidate", { mutation: { ...mutation, claims: [{ ...mutation.claims[0],
        newContent: testSource.replace("12", "15") }] } }]
    ]) {
      await fs.writeFile(file, JSON.stringify({ ...draft, ...change }));
      await assert.rejects(repair.repairCommand({ taskId, repairDraftFile: file }, repository),
        undefined, name);
      assert.equal(await handoff.readCandidateHandoff(repository).catch(() => null), null);
    }
    await fs.writeFile(file, JSON.stringify(draft));
    await fs.writeFile(path.join(repository, "src/calculate.js"), sourceOriginal.replace("* 2", "* 7"));
    await assert.rejects(repair.repairCommand({ taskId, repairDraftFile: file }, repository));
    assert.equal(await handoff.readCandidateHandoff(repository).catch(() => null), null);
    await fs.writeFile(path.join(repository, "src/calculate.js"), sourceOriginal);
    const cliResult = spawnSync(process.execPath, [path.join(projectRoot,
      "dist/apps/cli/src/index.js"), "repair", "--task-id", taskId,
      "--repair-draft", file, "--json"], { cwd: repository, encoding: "utf8",
      env: { ...process.env, CODEX_API_KEY: "", OPENAI_API_KEY: "" }, timeout: 30_000 });
    assert.equal(cliResult.status, 0, `${cliResult.stderr}\n${cliResult.stdout}`);
    const output = JSON.parse(cliResult.stdout);
    assert.equal(output.providerCalls, 0);
    const candidate = await handoff.readCandidateHandoff(repository);
    assert.equal(candidate.handoffHash, output.candidateHandoffHash);
    const derivedClaims = runtime.parseTextFileUpdates(candidate.coderMutation);
    assert.equal(derivedClaims.find((claim) => claim.file === "src/calculate.js").newContent,
      claims.find((claim) => claim.file === "src/calculate.js").newContent);
    assert.equal(derivedClaims.find((claim) => claim.file === "test/calculate.test.js").newContent,
      testSource);
    assert.equal(await fs.readFile(path.join(repository, "src/calculate.js"), "utf8"), sourceOriginal);
    const terminalAfter = await fs.readFile(path.join(taskDirectory, "state.json"));
    assert.equal(createHash("sha256").update(terminalAfter).digest("hex"),
      createHash("sha256").update(terminalBefore).digest("hex"));
    assert.deepEqual(await fs.readFile(originalArtifactFile), originalArtifactBefore);
    assert.equal(counters.execution, 2);
    const gated = await apply.applyCommand({ nonInteractive: true }, repository);
    assert.equal(gated.output.decision, "approval_required");
    assert.equal(gated.output.apply, "NOT_RUN");
    const handoffFile = path.join(repository, ".bounded/state/candidate-handoff.json");
    const handoffBytes = await fs.readFile(handoffFile);
    const recordFile = path.join(repository, ".bounded/state/derived-repairs",
      `${output.derivedCandidateHash.slice(7)}.json`);
    const recordBytes = await fs.readFile(recordFile);
    const originalSourceBytes = await fs.readFile(path.join(repository, "src/calculate.js"));
    const originalTestBytes = await fs.readFile(path.join(repository, "test/calculate.test.js"));
    const rejectPreflight = async (name) => {
      const result = await apply.applyCommand({ nonInteractive: true }, repository);
      assert.equal(result.output.decision, "recovery_required", `${name}: ${JSON.stringify(result.output)}`);
      assert.equal(result.output.apply, "NOT_RUN", name);
      assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), originalSourceBytes);
      assert.deepEqual(await fs.readFile(path.join(repository, "test/calculate.test.js")), originalTestBytes);
    };
    await fs.rm(recordFile);
    await rejectPreflight("deleted record");
    await fs.writeFile(recordFile, recordBytes);
    const modifiedRecord = Buffer.from(recordBytes);
    modifiedRecord[modifiedRecord.indexOf(Buffer.from("originalTaskId"))] = 0x58;
    await fs.writeFile(recordFile, modifiedRecord);
    await rejectPreflight("modified record bytes");
    await fs.writeFile(recordFile, recordBytes);
    await fs.writeFile(recordFile, Buffer.concat([recordBytes, Buffer.from(" ")]));
    await rejectPreflight("modified record size");
    await fs.writeFile(recordFile, recordBytes);
    const { handoffVersion: _version, handoffHash: _hash, ...candidateInput } = candidate;
    for (const [name, change] of [
      ["wrong repair artifact", { repairArtifactHash: `sha256:${"1".repeat(64)}` }],
      ["wrong derived candidate", { derivedCandidateHash: `sha256:${"2".repeat(64)}` }],
      ["wrong original candidate", { originalCandidateHash: `sha256:${"3".repeat(64)}` }],
      ["wrong record hash", { derivedRepairRecordHash: `sha256:${"4".repeat(64)}` }]
    ]) {
      await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
        ...candidateInput, provenance: { ...candidate.provenance, ...change }
      }));
      await rejectPreflight(name);
    }
    const crossTaskRecord = { ...JSON.parse(recordBytes.toString("utf8")),
      originalTaskId: "codex.other-task" };
    const crossTaskBytes = Buffer.from(`${JSON.stringify(crossTaskRecord, null, 2)}\n`);
    await fs.writeFile(recordFile, crossTaskBytes);
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, provenance: { ...candidate.provenance,
        derivedRepairRecordHash: `sha256:${createHash("sha256").update(crossTaskBytes).digest("hex")}`,
        derivedRepairRecordBytes: crossTaskBytes.length }
    }));
    await rejectPreflight("cross-task record substitution");
    await fs.writeFile(recordFile, recordBytes);
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, provenance: { kind: "bounded_run" }
    }));
    await rejectPreflight("repair mislabeled as normal candidate");
    const alteredMutation = structuredClone(candidate.coderMutation);
    alteredMutation.claims.find((claim) => claim.file === "test/calculate.test.js").newContent =
      testSource.replace("12", "13");
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, coderMutation: alteredMutation
    }));
    await rejectPreflight("Candidate B content changed");
    await fs.writeFile(handoffFile, handoffBytes);
    const tamperedHandoff = JSON.parse(handoffBytes.toString("utf8"));
    tamperedHandoff.provenance.originalCandidateHash = `sha256:${"5".repeat(64)}`;
    await fs.writeFile(handoffFile, JSON.stringify(tamperedHandoff));
    await assert.rejects(apply.applyCommand({ nonInteractive: true }, repository));
    assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), originalSourceBytes);
    assert.deepEqual(await fs.readFile(path.join(repository, "test/calculate.test.js")), originalTestBytes);
    await fs.writeFile(handoffFile, handoffBytes);
    await fs.writeFile(path.join(repository, "src/calculate.js"), sourceOriginal.replace("* 2", "* 7"));
    const staleSourceBytes = await fs.readFile(path.join(repository, "src/calculate.js"));
    const staleResult = await apply.applyCommand({ nonInteractive: true }, repository);
    assert.equal(staleResult.output.decision, "recovery_required");
    assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), staleSourceBytes);
    await fs.writeFile(path.join(repository, "src/calculate.js"), originalSourceBytes);
    assert.equal((await apply.applyCommand({ nonInteractive: true }, repository)).output.decision,
      "approval_required");
    let executeCalls = 0;
    const changedAfterApproval = await apply.applyCommand({}, repository, {
      decide: async () => {
        await fs.writeFile(recordFile, modifiedRecord);
        return { decision: "accept", reason: null };
      },
      execute: async () => { executeCalls += 1; throw new Error("executor must not run"); }
    });
    assert.equal(changedAfterApproval.output.decision, "recovery_required");
    assert.equal(executeCalls, 0);
    assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), originalSourceBytes);
    assert.deepEqual(await fs.readFile(path.join(repository, "test/calculate.test.js")), originalTestBytes);
    await fs.writeFile(recordFile, recordBytes);
    console.log("governed repair: offline derived candidate, validation, handoff, immutability PASS");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
