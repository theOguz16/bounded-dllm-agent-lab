#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const runner = require("../../scripts/gate6-live-runner.cjs");
const verifier = require("../../scripts/lib/gate6-verifier-provenance.cjs");
const { validateProposal, PROPOSAL_VERSION } = require("../../scripts/lib/gate6-simulated-coding-harness.cjs");
const {
  providerContractDescriptor,
  providerContractHash
} = require("../../scripts/lib/gate6-live-provider-contract.cjs");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HASH = `sha256:${"a".repeat(64)}`;
const task = Object.freeze({
  schemaVersion: "gate6-task/v1",
  taskId: "external.fixture.contract-hardening-v1",
  repositoryId: "fixture/repo",
  commitSha: SHA,
  taskClass: "bugfix_with_regression",
  difficulty: "medium",
  objective: "Fix the contract hardening fixture.",
  candidateFiles: Object.freeze(["src/main.js", "test/main.test.js"]),
  authority: Object.freeze({
    allowedInspectionPaths: Object.freeze(["src/**", "test/**"]),
    forbiddenInspectionPaths: Object.freeze([]),
    allowedChangePaths: Object.freeze(["src/**", "test/**"])
  })
});

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => process.stdout.write(`PASS ${name}\n`));
}

function request() {
  return runner.buildProviderRequest({
    config: { endpoint: "http://fixture.invalid/v1/chat/completions", model: "fixture-model", maxCompletionTokens: 4096 },
    task,
    contextResult: {
      strategy: "C_synthetic_context",
      context: JSON.stringify({ strategy: "C_synthetic_context", summaries: [] })
    },
    phase: "single"
  });
}

function instruction() {
  return JSON.parse(request().body.messages.find((message) => message.role === "user").content);
}

function validProposal() {
  return {
    schemaVersion: PROPOSAL_VERSION,
    action: "patch",
    edits: [{ path: "src/main.js", expectedContentHash: HASH, oldText: "before", newText: "after" }],
    summary: "Apply fixture edit."
  };
}

function validOutput(proposal = validProposal()) {
  return {
    schemaVersion: runner.LIVE_MODEL_OUTPUT_VERSION,
    selection: {
      schemaVersion: "gate6-candidate-selection/v1",
      candidateFiles: ["src/main.js"],
      candidateSymbols: ["calculate"],
      candidateTestFiles: ["test/main.test.js"],
      candidateTestAnchors: ["calculate regression"]
    },
    proposal
  };
}

function rawReport() {
  return {
    schemaVersion: "gate6-live-run/v1", executionClass: "live", researchStatus: "diagnostic_live_smoke", promotionEligible: false,
    sourceCommit: SHA, tasksetVersion: "gate6-taskset/v1", tasksetHash: `sha256:${"1".repeat(64)}`,
    benchmarkSemanticsHash: `sha256:${"2".repeat(64)}`, repositoryManifestHash: `sha256:${"3".repeat(64)}`,
    preconditionAttestationHash: `sha256:${"4".repeat(64)}`, oracleScorerVersion: "gate6-oracle-scorer/v1",
    receiptVersion: "gate6-simulated-harness-receipt/v3", model: "fixture-model", endpointClass: "openai_compatible",
    temperature: 0, maxCompletionTokens: 4096, repetitions: 1, taskCount: 1, strategyCount: 4, sampleCount: 4,
    expectedFullSampleCount: 504, filters: { taskLimit: 1, taskId: null, strategy: null }, observations: [], receipts: [],
    receiptSetHash: `sha256:${"5".repeat(64)}`, sampleOutcomes: [], comparativeReport: null, aggregates: {},
    reportHash: `sha256:${"6".repeat(64)}`
  };
}

async function main() {
  await test("canonical provider contract is versioned and deterministically hashed", () => {
    const descriptor = providerContractDescriptor();
    assert.equal(descriptor.providerContractVersion, "gate6-live-provider-contract/v1");
    assert.equal(descriptor.providerPromptVersion, "gate6-live-provider-prompt/v3");
    assert.deepEqual(descriptor.structuredOutputTransport, { type: "json_object" });
    assert.equal(providerContractHash(descriptor), runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.match(runner.LIVE_PROVIDER_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/);
    assert.equal(providerContractHash(providerContractDescriptor()), runner.LIVE_PROVIDER_CONTRACT_HASH);
  });

  await test("provider contract drift changes canonical hash", () => {
    const drifted = structuredClone(providerContractDescriptor());
    drifted.rules.push("DRIFT_SENTINEL");
    assert.notEqual(providerContractHash(drifted), runner.LIVE_PROVIDER_CONTRACT_HASH);
  });

  await test("provider-facing instruction binds prompt version contract version and contract hash", () => {
    const value = instruction();
    assert.equal(value.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.equal(value.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.equal(value.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.deepEqual(request().body.response_format, { type: "json_object" });
  });

  await test("selection proposal and compact JSON semantics remain explicit", () => {
    const rules = instruction().rules.join("\n");
    for (const pattern of [
      /candidateFiles means implementation\/source files only/i,
      /candidateTestFiles means regression\/test files only/i,
      /MUST be disjoint/i,
      /Do not use candidateFiles as an umbrella/i,
      /proposal\.action MUST be exactly patch or no_change/i,
      /summary MUST be a non-empty string/i,
      /action=patch.*at least one edit/i,
      /action=no_change.*empty/i,
      /expectedContentHash.*sha256/i,
      /oldText.*non-empty/i,
      /minimal replacement span/i,
      /Return exactly one JSON object/i,
      /Do not emit markdown fences/i,
      /Keep JSON compact/i
    ]) assert.match(rules, pattern);
  });

  await test("structural example does not encode an invalid empty patch", () => {
    const example = instruction().structuralExample;
    assert.equal(example.proposal.action, "no_change");
    assert.deepEqual(example.proposal.edits, []);
    assert.ok(example.proposal.summary.length > 0);
  });

  await test("proposal diagnostics are valid iff canonical validateProposal accepts", () => {
    const cases = [];
    cases.push(validProposal());
    cases.push({ ...validProposal(), extra: true });
    cases.push({ ...validProposal(), schemaVersion: "wrong" });
    cases.push({ ...validProposal(), action: "repair" });
    cases.push({ ...validProposal(), summary: " " });
    cases.push({ ...validProposal(), edits: "nope" });
    cases.push({ ...validProposal(), edits: [] });
    cases.push({ ...validProposal(), action: "no_change" });
    cases.push({ ...validProposal(), edits: [{ ...validProposal().edits[0], extra: true }] });
    cases.push({ ...validProposal(), edits: [{ ...validProposal().edits[0], path: "../private.js" }] });
    cases.push({ ...validProposal(), edits: [{ ...validProposal().edits[0], expectedContentHash: "bad" }] });
    cases.push({ ...validProposal(), edits: [{ ...validProposal().edits[0], oldText: "same", newText: "same" }] });
    for (const proposal of cases) {
      const diagnosticValid = runner.classifyProposalDiagnostic(proposal).proposalValidationFailureCode ===
        runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_VALID;
      const canonicalValid = validateProposal(proposal) !== null;
      assert.equal(diagnosticValid, canonicalValid);
    }
  });

  await test("proposal diagnostics decompose canonical invalidity without leaking edit content", () => {
    const badHash = validProposal();
    badHash.edits[0].expectedContentHash = "BAD_HASH_SENTINEL";
    const diagnostic = runner.classifyProposalDiagnostic(badHash);
    assert.equal(diagnostic.proposalValidationFailureCode,
      runner.PROPOSAL_VALIDATION_FAILURE_CODES.PROPOSAL_EDIT_HASH_INVALID);
    assert.equal(JSON.stringify(diagnostic).includes("BAD_HASH_SENTINEL"), false);
    assert.equal(diagnostic.invalidEditIndex, 0);
  });

  await test("experiment identity binds prompt contract version and contract hash", () => {
    const current = runner.createLiveExperimentConfig(rawReport());
    assert.equal(current.providerPromptVersion, runner.LIVE_PROVIDER_PROMPT_VERSION);
    assert.equal(current.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.equal(current.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH);
    const changedVersion = runner.createLiveExperimentConfig(
      rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION,
      "gate6-live-provider-contract/v999", runner.LIVE_PROVIDER_CONTRACT_HASH
    );
    const changedHash = runner.createLiveExperimentConfig(
      rawReport(), runner.STRUCTURED_OUTPUT_MODE, runner.LIVE_PROVIDER_PROMPT_VERSION,
      runner.LIVE_PROVIDER_CONTRACT_VERSION, `sha256:${"b".repeat(64)}`
    );
    assert.notEqual(runner.hashLiveExperimentConfig(current), runner.hashLiveExperimentConfig(changedVersion));
    assert.notEqual(runner.hashLiveExperimentConfig(current), runner.hashLiveExperimentConfig(changedHash));
  });

  await test("checkpoint identity binds prompt contract version and contract hash", () => {
    const report = rawReport();
    const experimentConfigHash = runner.hashLiveExperimentConfig(runner.createLiveExperimentConfig(report));
    const current = runner.checkpoint.createCheckpointIdentity({
      reportIdentity: { ...report, providerPromptVersion: runner.LIVE_PROVIDER_PROMPT_VERSION },
      experimentConfigHash,
      samplePlanHash: `sha256:${"9".repeat(64)}`,
      structuredOutputMode: runner.STRUCTURED_OUTPUT_MODE,
      providerPromptVersion: runner.LIVE_PROVIDER_PROMPT_VERSION,
      providerContractVersion: runner.LIVE_PROVIDER_CONTRACT_VERSION,
      providerContractHash: runner.LIVE_PROVIDER_CONTRACT_HASH
    });
    assert.equal(current.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.equal(current.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH);
    assert.throws(() => runner.checkpoint.assertIdentityMatch(
      { ...current, providerContractHash: `sha256:${"c".repeat(64)}` }, current
    ), /GATE6_CHECKPOINT_IDENTITY_MISMATCH/);
    assert.throws(() => runner.checkpoint.assertIdentityMatch(
      { ...current, providerContractVersion: "gate6-live-provider-contract/v0" }, current
    ), /GATE6_CHECKPOINT_IDENTITY_MISMATCH/);
  });

  await test("adversarial fake-provider matrix preserves invalid output with one call and no repair", async () => {
    const matrix = [
      { name: "wrapper", output: { ...validOutput(), analysis: "forbidden" } },
      { name: "overlap", output: (() => { const x = validOutput(); x.selection.candidateTestFiles = ["src/main.js"]; return x; })() },
      { name: "empty-patch", output: validOutput({ ...validProposal(), edits: [] }) },
      { name: "bad-edit-hash", output: validOutput({ ...validProposal(), edits: [{ ...validProposal().edits[0], expectedContentHash: "bad" }] }) }
    ];
    for (const entry of matrix) {
      let calls = 0;
      let observedRequest;
      const fake = Object.freeze({
        async execute(input) {
          calls += 1;
          observedRequest = input.request;
          return Object.freeze({
            kind: "ok",
            output: structuredClone(entry.output),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            latencyMs: 1,
            responseHash: HASH,
            providerRequestId: entry.name,
            finishReason: "stop"
          });
        }
      });
      const records = [];
      const hardened = runner.wrapProviderWithCanonicalContract(fake, records);
      const original = structuredClone(entry.output);
      const result = await hardened.execute({ request: request(), phase: "single", strategy: "C_synthetic_context", task });
      assert.equal(calls, 1, entry.name);
      assert.deepEqual(result.output, original, entry.name);
      assert.deepEqual(observedRequest.body.response_format, { type: "json_object" }, entry.name);
      const sent = JSON.parse(observedRequest.body.messages.find((m) => m.role === "user").content);
      assert.equal(sent.providerContractHash, runner.LIVE_PROVIDER_CONTRACT_HASH, entry.name);
      assert.equal(records.length, 1, entry.name);
      assert.equal(runner.normalizeLiveModelOutput(result.output, task), null, entry.name);
    }
  });

  await test("canonical provider contract hash is independent of report diagnostics", () => {
    const descriptorHash = providerContractHash(providerContractDescriptor());
    const report = runner.augmentReport(rawReport());
    assert.equal(report.providerContractHash, descriptorHash);
    assert.equal(report.experimentConfig.providerContractHash, descriptorHash);
    assert.equal(report.providerContractVersion, runner.LIVE_PROVIDER_CONTRACT_VERSION);
    assert.match(report.reportHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(verifier.hashCanonical(report.experimentConfig), report.experimentConfigHash);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
