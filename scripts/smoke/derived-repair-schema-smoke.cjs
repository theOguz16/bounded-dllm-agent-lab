#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = process.cwd();
  const load = (name) => import(pathToFileURL(path.join(root, `dist/${name}.js`)));
  const [handoff, authority, runtime] = await Promise.all([
    load("apps/cli/src/candidate-handoff"),
    load("apps/cli/src/inherited-candidate-authority"),
    load("packages/product-runtime/src/canonical-runtime")
  ]);
  const hash = (digit) => `sha256:${digit.repeat(64)}`;
  const taskId = "codex.schema-fixture";
  const objectiveHash = hash("1");
  const mutation = { role: "coder", target: "patchDraft", summary: "Fixture mutation.",
    claims: [{ claimVersion: "text-file-update/v1", type: "patch_draft", operation: "update",
      file: "src/example.js", expectedContentHash: hash("2"), newContent: "export const value = 2;\n",
      description: "Update the value." }], touchedFiles: ["src/example.js"] };
  const base = {
    taskId, objectiveHash, sourceSnapshotHash: hash("3"), planHash: hash("4"),
    contextBindingHash: hash("5"), plannerExecutionBindingHash: hash("6"),
    compiledPolicyHash: hash("7"), allowedFiles: ["src/example.js"], forbiddenFiles: [],
    acceptanceCriteriaContract: runtime.createAcceptanceCriteriaContract({ taskId, objectiveHash,
      criteria: [{ id: "behavior", description: "Value is updated.", required: true,
        evidence: { kind: "test", commandId: "validation.test" } }] }),
    validationProfile: "existing_function_bug_fix",
    phaseVExecutionSpecification: { commands: [{ id: "validation.test", checkKind: "behavior_test",
      executable: "node", args: ["--test"], timeoutMs: 30000, expectedExitCodes: [0] }],
      allowedExecutables: ["node"], maxCommands: 1, defaultTimeoutMs: 30000,
      maxTimeoutMs: 30000, maxOutputChars: 20000, environment: { CI: "1" } },
    coderMutation: mutation, verifierFinding: { role: "verifier", target: "verifierFinding",
      summary: "Approved.", claims: [], touchedFiles: ["src/example.js"] },
    adaptiveResult: { coderResult: { providerOutput: mutation } },
    declaredRiskClass: "low", candidateFiles: ["src/example.js"]
  };
  const provenance = { kind: "derived_repair", originalTaskId: taskId,
    originalCandidateHash: hash("8"), repairArtifactHash: hash("9"),
    derivedCandidateHash: hash("a"), derivedRepairRecordHash: hash("b"),
    derivedRepairRecordBytes: 100, validationFailureHash: hash("c"),
    repositoryIdentityHash: hash("d"), baselineSnapshotHash: hash("e"),
    inheritedCandidateAuthorityHash: hash("f") };
  const candidate = handoff.createDerivedRepairHandoff({ ...base, provenance });
  assert.equal(handoff.validateCandidateHandoff(candidate).handoffHash, candidate.handoffHash);
  const inherited = new Set(authority.INHERITED_HANDOFF_FIELDS);
  const output = new Set(authority.DERIVED_HANDOFF_FIELDS);
  const classes = handoff.DERIVED_REPAIR_HANDOFF_FIELD_CLASSES;
  assert.deepEqual(Object.keys(candidate).sort(), Object.keys(classes).sort());
  assert.deepEqual(Object.entries(classes).filter(([, kind]) => kind === "inherited")
    .map(([field]) => field).sort(), [...inherited].filter((field) => field !== "adaptiveResult").sort());
  assert.equal(classes.adaptiveResult, "reconstructed");
  assert.deepEqual(Object.entries(classes).filter(([, kind]) => kind === "governed_output")
    .map(([field]) => field), ["coderMutation"]);
  assert.equal(classes.verifierFinding, "reconstructed");
  assert.deepEqual(Object.keys(provenance).sort(),
    Object.keys(handoff.DERIVED_REPAIR_PROVENANCE_FIELD_CLASSES).sort());

  function rehash(value) {
    const { handoffHash: _old, ...material } = value;
    return { ...material, handoffHash: runtime.hashCanonicalJson(material) };
  }
  assert.throws(() => handoff.validateCandidateHandoff(rehash({
    ...candidate, futureOptionalSecurityField: "unauthorized" })));
  assert.throws(() => handoff.validateCandidateHandoff(rehash({
    ...candidate, provenance: { ...provenance, futureOptionalAuthority: hash("0") } })));
  const { planHash: _missingPlan, ...withoutPlan } = candidate;
  assert.throws(() => handoff.validateCandidateHandoff(rehash(withoutPlan)));
  const { originalCandidateHash: _missingOriginal, ...withoutOriginal } = provenance;
  assert.throws(() => handoff.validateCandidateHandoff(rehash({
    ...candidate, provenance: withoutOriginal })));
  const constructed = handoff.createDerivedRepairHandoff({ ...base, provenance,
    futureOptionalSecurityField: "unauthorized" });
  assert.equal(Object.hasOwn(constructed, "futureOptionalSecurityField"), false);
  const nested = handoff.createDerivedRepairHandoff({ ...base,
    provenance: { ...provenance, futureOptionalAuthority: hash("0") } });
  assert.equal(Object.hasOwn(nested.provenance, "futureOptionalAuthority"), false);

  const normal = handoff.createCandidateHandoff({ ...base, provenance: { kind: "bounded_run" } });
  assert.equal(handoff.validateCandidateHandoff(normal).provenance.kind, "bounded_run");
  const { provenance: _provenance, handoffHash: _hash, ...legacyMaterial } = normal;
  const legacy = rehash({ ...legacyMaterial, handoffVersion: "bounded-candidate-handoff/v1" });
  assert.equal(handoff.validateCandidateHandoff(legacy).handoffVersion,
    "bounded-candidate-handoff/v1");
  assert.throws(() => handoff.validateCandidateHandoff(rehash({
    ...candidate, handoffVersion: "bounded-candidate-handoff/v1" })));
  assert.throws(() => handoff.validateCandidateHandoff(rehash({
    ...candidate, provenance: { ...provenance, kind: "bounded_run" } })));
  process.stdout.write("derived repair closed schema, default deny, classification, normal compatibility PASS\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
