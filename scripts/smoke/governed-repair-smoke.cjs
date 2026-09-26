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
    const inherited = await import(pathToFileURL(path.join(projectRoot,
      "dist/apps/cli/src/inherited-candidate-authority.js")));
    assert.deepEqual(Object.keys(candidate).filter((field) =>
      !["handoffVersion", "handoffHash", "provenance"].includes(field)).sort(),
    [...inherited.INHERITED_HANDOFF_FIELDS, ...inherited.DERIVED_HANDOFF_FIELDS].sort());
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
    await fs.writeFile(originalArtifactFile, "{}");
    const terminalCandidateWithAuxiliaryCorrupt = runtime.readDurableBoundedTaskArtifact(
      locator, state, state.terminalResultReference).plannerResult.taskSeedResult.repoResult
      .adaptiveResult.coderResult.providerOutput;
    assert.equal(runtime.hashCanonicalJson(terminalCandidateWithAuxiliaryCorrupt),
      state.mutationArtifactHash);
    await fs.writeFile(originalArtifactFile, originalArtifactBefore);
    assert.equal(counters.execution, 2);
    const gated = await apply.applyCommand({ nonInteractive: true }, repository);
    assert.equal(gated.output.decision, "approval_required");
    assert.equal(gated.output.apply, "NOT_RUN");
    const handoffFile = path.join(repository, ".bounded/state/candidate-handoff.json");
    const handoffBytes = await fs.readFile(handoffFile);
    const recordFile = path.join(repository, ".bounded/state/derived-repairs",
      `${output.derivedCandidateHash.slice(7)}.json`);
    const recordBytes = await fs.readFile(recordFile);
    const mutationFile = path.join(repository, ".bounded/state/repair-mutations",
      `${output.repairArtifactHash.slice(7)}.json`);
    const mutationBytes = await fs.readFile(mutationFile);
    const storedRecord = JSON.parse(recordBytes.toString("utf8"));
    assert.equal(storedRecord.mutation, undefined);
    assert.equal(storedRecord.request, undefined);
    assert.equal(recordBytes.includes(Buffer.from(testSource)), false);
    assert.equal(recordBytes.includes(Buffer.from(mutation.summary)), false);
    assert.equal(storedRecord.requestBinding.version, "bounded-repair-request-binding/v1");
    assert.equal(storedRecord.validationReceipt.receiptVersion,
      "bounded-derived-validation-receipt/v3");
    assert.equal(storedRecord.inheritedCandidateAuthorityHash,
      inherited.inheritedCandidateAuthorityHash(inherited.projectInheritedHandoffAuthority(candidate)));
    assert.equal(storedRecord.validationReceipt.inheritedCandidateAuthorityHash,
      storedRecord.inheritedCandidateAuthorityHash);
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
    await fs.rm(mutationFile);
    await rejectPreflight("deleted repair mutation artifact");
    await fs.writeFile(mutationFile, mutationBytes);
    const modifiedMutationBytes = Buffer.from(mutationBytes);
    modifiedMutationBytes[modifiedMutationBytes.indexOf(Buffer.from("newContent"))] = 0x58;
    await fs.writeFile(mutationFile, modifiedMutationBytes);
    await rejectPreflight("tampered repair mutation artifact");
    await fs.writeFile(mutationFile, mutationBytes);
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
      ["wrong record hash", { derivedRepairRecordHash: `sha256:${"4".repeat(64)}` }],
      ["wrong repository identity", { repositoryIdentityHash: `sha256:${"6".repeat(64)}` }]
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
    const { provenance: _legacyProvenance, handoffHash: _legacyHash, ...legacyBase } = candidate;
    const legacy = { ...legacyBase, handoffVersion: "bounded-candidate-handoff/v1" };
    await handoff.writeCandidateHandoff(repository, { ...legacy,
      handoffHash: runtime.hashCanonicalJson(legacy) });
    await rejectPreflight("repair handoff downgraded to v1");
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
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, validationProfile: "structural_draft"
    }));
    await rejectPreflight("validation profile downgrade");
    const weakSpecification = { ...candidate.phaseVExecutionSpecification,
      commands: candidate.phaseVExecutionSpecification.commands.map((command) =>
        command.id === "validation.test" ? { ...command, args: ["run", "build"] } : command) };
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, phaseVExecutionSpecification: weakSpecification
    }));
    await rejectPreflight("test command downgrade");
    const weakAcceptance = runtime.createAcceptanceCriteriaContract({ taskId,
      objectiveHash: candidate.objectiveHash, criteria: [{ id: "requested_behavior",
        description: "Build succeeds", required: true,
        evidence: { kind: "test", commandId: "validation.syntax" } }] });
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, acceptanceCriteriaContract: weakAcceptance
    }));
    await rejectPreflight("acceptance contract downgrade");
    await fs.writeFile(handoffFile, handoffBytes);
    const rejectRehashedRequestBinding = async (name, changedFields) => {
      const { bindingHash: _bindingHash, ...oldMaterial } = storedRecord.requestBinding;
      const bindingMaterial = { ...oldMaterial, ...changedFields };
      const changedBinding = { ...bindingMaterial,
        bindingHash: runtime.hashCanonicalJson(bindingMaterial) };
      const { receiptHash: _receiptHash, ...oldReceiptMaterial } = storedRecord.validationReceipt;
      const receiptMaterial = { ...oldReceiptMaterial,
        repairRequestBindingHash: changedBinding.bindingHash };
      const changedRecord = { ...storedRecord, requestBinding: changedBinding,
        validationReceipt: { ...receiptMaterial,
          receiptHash: runtime.hashCanonicalJson(receiptMaterial) } };
      const changedBytes = Buffer.from(`${JSON.stringify(changedRecord, null, 2)}\n`);
      await fs.writeFile(recordFile, changedBytes);
      await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
        ...candidateInput, provenance: { ...candidate.provenance,
          derivedRepairRecordHash: `sha256:${createHash("sha256").update(changedBytes).digest("hex")}`,
          derivedRepairRecordBytes: changedBytes.length }
      }));
      await rejectPreflight(name);
      await fs.writeFile(recordFile, recordBytes);
      await fs.writeFile(handoffFile, handoffBytes);
    };
    await rejectRehashedRequestBinding("failure evidence substitution",
      { failureEvidenceHash: `sha256:${"7".repeat(64)}` });
    await rejectRehashedRequestBinding("failed check substitution",
      { matchedFailedCheckHash: `sha256:${"8".repeat(64)}` });
    await rejectRehashedRequestBinding("target-set substitution",
      { targetFileSetHash: runtime.hashCanonicalJson(["src/calculate.js"]) });
    await rejectRehashedRequestBinding("repair boundary substitution",
      { repairBoundaryHash: `sha256:${"9".repeat(64)}` });
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, allowedFiles: ["src/calculate.js", "test/calculate.test.js", "package.json"]
    }));
    await rejectPreflight("handoff mutable scope widening");
    await fs.writeFile(handoffFile, handoffBytes);
    const changedHash = (digit) => `sha256:${digit.repeat(64)}`;
    for (const [name, change] of [
      ["task ID", { taskId: "codex.other-task",
        provenance: { ...candidate.provenance, originalTaskId: "codex.other-task" } }],
      ["objective", { objectiveHash: changedHash("0") }],
      ["source snapshot", { sourceSnapshotHash: changedHash("1") }],
      ["plan", { planHash: changedHash("2") }],
      ["context", { contextBindingHash: changedHash("3") }],
      ["planner execution", { plannerExecutionBindingHash: changedHash("4") }],
      ["compiled policy", { compiledPolicyHash: changedHash("5") }],
      ["forbidden files", { forbiddenFiles: [...candidate.forbiddenFiles, "package.json"] }],
      ["candidate files", { candidateFiles: ["src/calculate.js"] }],
      ["adaptive inherited evidence", { adaptiveResult: {
        ...candidate.adaptiveResult, auditMarker: true } }],
      ["risk class", { declaredRiskClass: candidate.declaredRiskClass === "low" ? "high" : "low" }]
    ]) {
      await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
        ...candidateInput, ...change
      }));
      await rejectPreflight(`inherited ${name} tamper`);
      await fs.writeFile(handoffFile, handoffBytes);
    }
    for (const [name, change] of [
      ["plan", { planHash: changedHash("6") }],
      ["context", { contextBindingHash: changedHash("7") }],
      ["risk class", { declaredRiskClass: candidate.declaredRiskClass === "low" ? "high" : "low" }]
    ]) {
      const forgedHandoff = handoff.createCandidateHandoff({ ...candidateInput, ...change });
      const forgedInheritedHash = inherited.inheritedCandidateAuthorityHash(
        inherited.projectInheritedHandoffAuthority(forgedHandoff));
      const { receiptHash: _inheritedReceiptHash, ...originalReceiptMaterial } =
        storedRecord.validationReceipt;
      const inheritedReceiptMaterial = { ...originalReceiptMaterial,
        inheritedCandidateAuthorityHash: forgedInheritedHash };
      const inheritedRecord = { ...storedRecord,
        inheritedCandidateAuthorityHash: forgedInheritedHash,
        validationReceipt: { ...inheritedReceiptMaterial,
          receiptHash: runtime.hashCanonicalJson(inheritedReceiptMaterial) } };
      const inheritedRecordBytes = Buffer.from(`${JSON.stringify(inheritedRecord, null, 2)}\n`);
      await fs.writeFile(recordFile, inheritedRecordBytes);
      await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
        ...candidateInput, ...change,
        provenance: { ...candidate.provenance,
          inheritedCandidateAuthorityHash: forgedInheritedHash,
          derivedRepairRecordHash: `sha256:${createHash("sha256").update(inheritedRecordBytes).digest("hex")}`,
          derivedRepairRecordBytes: inheritedRecordBytes.length }
      }));
      await rejectPreflight(`coordinated ${name} authority rewrite`);
      await fs.writeFile(recordFile, recordBytes);
      await fs.writeFile(handoffFile, handoffBytes);
    }
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
    const artifactChangedAfterApproval = await apply.applyCommand({}, repository, {
      decide: async () => {
        await fs.writeFile(mutationFile, modifiedMutationBytes);
        return { decision: "accept", reason: null };
      },
      execute: async () => { executeCalls += 1; throw new Error("executor must not run"); }
    });
    assert.equal(artifactChangedAfterApproval.output.decision, "recovery_required");
    assert.equal(executeCalls, 0);
    assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), originalSourceBytes);
    assert.deepEqual(await fs.readFile(path.join(repository, "test/calculate.test.js")), originalTestBytes);
    await fs.writeFile(mutationFile, mutationBytes);
    const configurationChangedAfterApproval = await apply.applyCommand({}, repository, {
      decide: async () => {
        await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
          ...candidateInput, phaseVExecutionSpecification: weakSpecification
        }));
        return { decision: "accept", reason: null };
      },
      execute: async () => { executeCalls += 1; throw new Error("executor must not run"); }
    });
    assert.equal(configurationChangedAfterApproval.output.decision, "recovery_required");
    assert.equal(executeCalls, 0);
    assert.deepEqual(await fs.readFile(path.join(repository, "src/calculate.js")), originalSourceBytes);
    await fs.writeFile(handoffFile, handoffBytes);
    const foreign = await createRepository(path.join(parent, "foreign"), projectRoot,
      "foreign-repair-fixture");
    await fs.mkdir(path.join(foreign.repository, ".bounded/state/derived-repairs"), { recursive: true });
    await fs.mkdir(path.join(foreign.repository, ".bounded/state/repair-mutations"), { recursive: true });
    await fs.writeFile(path.join(foreign.repository, ".bounded/state/candidate-handoff.json"), handoffBytes);
    await fs.writeFile(path.join(foreign.repository, ".bounded/state/derived-repairs",
      `${output.derivedCandidateHash.slice(7)}.json`), recordBytes);
    await fs.writeFile(path.join(foreign.repository, ".bounded/state/repair-mutations",
      `${output.repairArtifactHash.slice(7)}.json`), mutationBytes);
    const foreignResult = await apply.applyCommand({ nonInteractive: true }, foreign.repository);
    assert.equal(foreignResult.output.decision, "recovery_required");
    assert.equal(foreignResult.output.mutationStarted, false);
    const validationModule = await import(pathToFileURL(path.join(projectRoot,
      "dist/apps/cli/src/derived-candidate-validation.js")));
    const forgedRepair = structuredClone(mutation);
    forgedRepair.claims[0].newContent = testSource.replace("12", "15");
    const forgedArtifact = validationModule.createRepairMutationArtifact(forgedRepair);
    const forgedArtifactBytes = Buffer.from(`${JSON.stringify(forgedArtifact, null, 2)}\n`);
    const forgedArtifactHash = runtime.hashCanonicalJson(forgedArtifact);
    const forgedCandidate = validationModule.deriveCandidateMutation(original, forgedArtifact);
    const forgedCandidateHash = runtime.hashCanonicalJson({
      originalCandidateHash: state.mutationArtifactHash,
      repairArtifactHash: forgedArtifactHash, mutation: forgedCandidate });
    const { bindingHash: _oldBindingHash, ...oldBindingMaterial } = storedRecord.requestBinding;
    const forgedBindingMaterial = { ...oldBindingMaterial, repairArtifactHash: forgedArtifactHash };
    const forgedBinding = { ...forgedBindingMaterial,
      bindingHash: runtime.hashCanonicalJson(forgedBindingMaterial) };
    const forgedReceiptMaterial = { ...storedRecord.validationReceipt,
      repairArtifactHash: forgedArtifactHash, derivedCandidateHash: forgedCandidateHash,
      repairRequestBindingHash: forgedBinding.bindingHash };
    delete forgedReceiptMaterial.receiptHash;
    const forgedRecord = { ...storedRecord, repairArtifactHash: forgedArtifactHash,
      requestBinding: forgedBinding,
      repairMutationArtifactHash: forgedArtifactHash,
      repairMutationArtifactRawHash: `sha256:${createHash("sha256").update(forgedArtifactBytes).digest("hex")}`,
      repairMutationArtifactBytes: forgedArtifactBytes.length,
      derivedCandidateHash: forgedCandidateHash,
      validationReceipt: { ...forgedReceiptMaterial,
        receiptHash: runtime.hashCanonicalJson(forgedReceiptMaterial) } };
    const forgedRecordBytes = Buffer.from(`${JSON.stringify(forgedRecord, null, 2)}\n`);
    await fs.rm(recordFile);
    await fs.rm(mutationFile);
    await fs.rm(path.join(repository, ".bounded/state/human-decisions"),
      { recursive: true, force: true });
    await fs.writeFile(path.join(repository, ".bounded/state/repair-mutations",
      `${forgedArtifactHash.slice(7)}.json`), forgedArtifactBytes);
    await fs.writeFile(path.join(repository, ".bounded/state/derived-repairs",
      `${forgedCandidateHash.slice(7)}.json`), forgedRecordBytes);
    await handoff.writeCandidateHandoff(repository, handoff.createCandidateHandoff({
      ...candidateInput, coderMutation: forgedCandidate,
      adaptiveResult: { ...candidate.adaptiveResult, coderResult: {
        ...candidate.adaptiveResult.coderResult, providerOutput: forgedCandidate } },
      provenance: { ...candidate.provenance, repairArtifactHash: forgedArtifactHash,
        derivedCandidateHash: forgedCandidateHash,
        derivedRepairRecordHash: `sha256:${createHash("sha256").update(forgedRecordBytes).digest("hex")}`,
        derivedRepairRecordBytes: forgedRecordBytes.length }
    }));
    await assert.rejects(validationModule.validateDerivedCandidate({ repositoryRoot: repository,
      specification: candidate.phaseVExecutionSpecification,
      validationProfile: candidate.validationProfile, requestBinding: forgedBinding,
      state, result: terminal, original, artifact: forgedArtifact,
      generatedPolicyPaths: [
        `.bounded/state/repair-mutations/${forgedArtifactHash.slice(7)}.json`,
        `.bounded/state/derived-repairs/${forgedCandidateHash.slice(7)}.json`,
        ".bounded/state/candidate-handoff.json"
      ] }), (error) => error.code === "cli_repair_validation_failed");
    await rejectPreflight("coordinated forged-validation receipt");
    await fs.writeFile(handoffFile, handoffBytes);
    console.log("governed repair: offline derived candidate, validation, handoff, immutability PASS");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
