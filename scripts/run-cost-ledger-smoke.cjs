#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const mode = process.argv[2] ?? "--test";
  if (mode !== "--test" && mode !== "--report") {
    throw new Error("usage: --test|--report");
  }

  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );
  const {
    appendAgentEvent,
    buildRunCostBenchmark,
    buildRunCostLedger,
    buildRunCostLedgerFromAgentEvents,
    createAgentEventLedger,
    hashCanonicalJson,
    normalizeOpenAiCompatibleUsage,
    verifyRunCostBenchmark,
    verifyRunCostLedger
  } = runtime;

  const hash = (label) =>
    hashCanonicalJson({ label });

  const priceSnapshot = {
    snapshotVersion: "1",
    snapshotId: "price:provider:model:v1",
    providerId: "openai-compatible",
    modelId: "qwen-coder",
    currency: "USD",
    inputNanoUsdPerToken: 100,
    outputNanoUsdPerToken: 400,
    capturedAt: "2026-07-23T10:00:00Z",
    sourceKind: "operator_configured",
    sourceHash: hash("price-source")
  };

  const roleByOperation = {
    planner: "planner",
    coder: "coder",
    verifier: "repair_verifier",
    remask: "masker",
    repair: "repairer",
    shadow: "shadow_observer",
    admin: "admin_agent",
    expansion: "planner"
  };

  function usage(inputTokens, outputTokens, label) {
    return {
      status: "observed",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      providerResponseHash: hash(`response:${label}`),
      providerRequestId: `request:${label}`
    };
  }

  function estimatedUsage(inputTokens, outputTokens, label) {
    return {
      status: "estimated",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatorId: "chars-div-4-v1",
      sourceArtifactHash: hash(`estimate:${label}`)
    };
  }

  function buildEvents(runId, specs) {
    let ledger = createAgentEventLedger({
      runId,
      objectiveHash: hash(`objective:${runId}`)
    });

    for (const [index, spec] of specs.entries()) {
      const startSecond = index * 2;
      const finishSecond = startSecond + 1;
      ledger = appendAgentEvent(ledger, {
        actor: roleByOperation[spec.operation],
        action: `${spec.operation}.completed`,
        startedAt: `2026-07-23T10:00:${String(startSecond).padStart(2, "0")}Z`,
        finishedAt: `2026-07-23T10:00:${String(finishSecond).padStart(2, "0")}Z`,
        inputArtifactHashes: [hash(`input:${runId}:${index}`)],
        outputArtifactHashes: [hash(`output:${runId}:${index}`)],
        filesRead: [],
        filesProposed: [],
        decision: "continue",
        reasonCodes: ["USAGE.CAPTURED"],
        ...(spec.eventHasUsage === false
          ? {}
          : {
              tokenUsage: {
                inputTokens: spec.usage.inputTokens,
                outputTokens: spec.usage.outputTokens,
                totalTokens: spec.usage.totalTokens
              }
            })
      });
    }
    return ledger;
  }

  function rawRun({
    runId,
    strategy,
    specs,
    evidenceClass = "deterministic_fixture",
    observationSource = "fixture",
    modelId = "qwen-coder",
    pricing = true
  }) {
    const ledger = buildEvents(runId, specs);
    return {
      ledger,
      input: {
        ledgerVersion: "1",
        evidenceClass,
        observationSource,
        observationReceiptHash: hash(`observation:${runId}`),
        runId,
        taskSetHash: hash("shared-task-set"),
        sourceLedgerRootHash: ledger.rootHash,
        strategy,
        outcome: "accepted_patch",
        acceptedPatchCount: 1,
        pricingSnapshots: [priceSnapshot],
        invocations: ledger.events.map((event, index) => ({
          invocationId: `${runId}:invocation:${String(index + 1).padStart(6, "0")}`,
          eventId: event.eventId,
          eventHash: event.eventHash,
          operation: specs[index].operation,
          strategy,
          providerId: "openai-compatible",
          modelId,
          attempt: specs[index].attempt ?? 1,
          usage: specs[index].usage,
          priceSnapshotId: pricing ? priceSnapshot.snapshotId : null
        }))
      }
    };
  }

  const directSpecs = [
    { operation: "planner", usage: usage(600, 100, "direct-planner") },
    { operation: "coder", usage: usage(500, 200, "direct-coder") },
    { operation: "verifier", usage: usage(200, 50, "direct-verifier") },
    { operation: "shadow", usage: usage(50, 20, "direct-shadow") },
    { operation: "admin", usage: usage(30, 10, "direct-admin") }
  ];
  const fixedSpecs = [
    { operation: "planner", usage: usage(350, 80, "fixed-planner") },
    { operation: "coder", usage: usage(350, 160, "fixed-coder") },
    { operation: "verifier", usage: usage(160, 40, "fixed-verifier") },
    { operation: "shadow", usage: usage(40, 15, "fixed-shadow") },
    { operation: "admin", usage: usage(25, 8, "fixed-admin") }
  ];
  const adaptiveSpecs = [
    { operation: "planner", usage: usage(250, 60, "adaptive-planner") },
    { operation: "expansion", usage: usage(80, 20, "adaptive-expansion") },
    { operation: "coder", usage: usage(280, 130, "adaptive-coder") },
    { operation: "verifier", usage: usage(130, 35, "adaptive-verifier") },
    { operation: "shadow", usage: usage(35, 12, "adaptive-shadow") },
    { operation: "admin", usage: usage(20, 6, "adaptive-admin") }
  ];

  const direct = rawRun({
    runId: "fixture-direct",
    strategy: "direct_large_context",
    specs: directSpecs
  });
  const fixed = rawRun({
    runId: "fixture-fixed",
    strategy: "fixed_bounded_context",
    specs: fixedSpecs
  });
  const adaptive = rawRun({
    runId: "fixture-adaptive",
    strategy: "adaptive_bounded_context",
    specs: adaptiveSpecs
  });

  const benchmarkInput = {
    benchmarkVersion: "1",
    benchmarkId: "af3a-token-cost-fixture-v1",
    evidenceClass: "deterministic_fixture",
    taskSetHash: hash("shared-task-set"),
    runs: [direct.input, fixed.input, adaptive.input]
  };

  const benchmark = buildRunCostBenchmark(benchmarkInput);

  if (mode === "--report") {
    console.log(JSON.stringify(benchmark, null, 2));
    process.exitCode =
      benchmark.decision === "run_cost_benchmark_ready"
        ? 0
        : 1;
    return;
  }

  let checks = 0;
  const check = (name, callback) => {
    console.log(`[run] ${name}`);
    callback();
    checks += 1;
    console.log(`[ok] ${name}`);
  };
  const clone = (value) => structuredClone(value);

  check(
    "OpenAI-compatible snake-case usage is provider-observed",
    () => {
      const result = normalizeOpenAiCompatibleUsage({
        response: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15
          }
        },
        providerResponseHash: hash("snake"),
        providerRequestId: "request-snake"
      });
      assert.equal(result.decision, "provider_usage_observed");
      assert.deepEqual(result.usage, {
        status: "observed",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        providerResponseHash: hash("snake"),
        providerRequestId: "request-snake"
      });
    }
  );

  check(
    "camel-case usage is normalized without estimation",
    () => {
      const result = normalizeOpenAiCompatibleUsage({
        response: {
          usage: {
            promptTokens: 11,
            completionTokens: 7,
            totalTokens: 18
          }
        },
        providerResponseHash: hash("camel")
      });
      assert.equal(result.decision, "provider_usage_observed");
      assert.equal(result.usage.status, "observed");
      assert.equal(result.usage.totalTokens, 18);
    }
  );

  check(
    "missing provider usage is explicitly unavailable",
    () => {
      const result = normalizeOpenAiCompatibleUsage({
        response: { choices: [] },
        providerResponseHash: hash("missing")
      });
      assert.equal(result.decision, "provider_usage_unavailable");
      assert.deepEqual(result.usage, {
        status: "unavailable",
        reason: "provider_usage_missing",
        providerResponseHash: hash("missing")
      });
    }
  );

  check(
    "malformed provider totals fail closed",
    () => {
      const result = normalizeOpenAiCompatibleUsage({
        response: {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 99
          }
        },
        providerResponseHash: hash("bad-total")
      });
      assert.equal(result.decision, "provider_usage_invalid");
      assert.ok(
        result.errors.includes("run_cost_token_total_mismatch")
      );
    }
  );

  check(
    "agent event ledger binds provider usage and pricing",
    () => {
      const specs = [
        {
          operation: "planner",
          usage: usage(100, 20, "binding-planner")
        },
        {
          operation: "coder",
          usage: usage(200, 50, "binding-coder")
        },
        {
          operation: "remask",
          usage: usage(60, 10, "binding-remask")
        },
        {
          operation: "shadow",
          usage: usage(30, 5, "binding-shadow")
        },
        {
          operation: "admin",
          usage: usage(20, 4, "binding-admin")
        }
      ];
      const ledger = buildEvents("binding-run", specs);
      const result = buildRunCostLedgerFromAgentEvents({
        bindingVersion: "1",
        evidenceClass: "deterministic_fixture",
        observationSource: "fixture",
        observationReceiptHash: hash("binding-observation"),
        taskSetHash: hash("binding-tasks"),
        strategy: "adaptive_bounded_context",
        outcome: "accepted_patch",
        acceptedPatchCount: 1,
        agentLedger: ledger,
        pricingSnapshots: [priceSnapshot],
        observations: ledger.events.map((event, index) => ({
          observationVersion: "1",
          eventId: event.eventId,
          operation: specs[index].operation,
          providerId: "openai-compatible",
          modelId: "qwen-coder",
          attempt: 1,
          usage: specs[index].usage,
          priceSnapshotId: priceSnapshot.snapshotId
        }))
      });
      assert.equal(
        result.decision,
        "agent_event_cost_binding_ready",
        JSON.stringify(result)
      );
      assert.equal(result.summary.allTokenEventsBound, true);
      assert.equal(
        result.ledger.sourceLedgerRootHash,
        ledger.rootHash
      );
    }
  );

  check(
    "event token mismatch is rejected",
    () => {
      const specs = [
        {
          operation: "planner",
          usage: usage(100, 20, "mismatch")
        }
      ];
      const ledger = buildEvents("mismatch-run", specs);
      const changedUsage = usage(101, 20, "mismatch-changed");
      const result = buildRunCostLedgerFromAgentEvents({
        bindingVersion: "1",
        evidenceClass: "deterministic_fixture",
        observationSource: "fixture",
        observationReceiptHash: hash("mismatch-observation"),
        taskSetHash: hash("mismatch-tasks"),
        strategy: "adaptive_bounded_context",
        outcome: "accepted_patch",
        acceptedPatchCount: 1,
        agentLedger: ledger,
        pricingSnapshots: [priceSnapshot],
        observations: [{
          observationVersion: "1",
          eventId: ledger.events[0].eventId,
          operation: "planner",
          providerId: "openai-compatible",
          modelId: "qwen-coder",
          attempt: 1,
          usage: changedUsage,
          priceSnapshotId: priceSnapshot.snapshotId
        }]
      });
      assert.equal(result.decision, "agent_event_cost_binding_invalid");
      assert.ok(
        result.errors.includes("agent_event_cost_usage_mismatch")
      );
    }
  );

  check(
    "every token-bearing event must be cost-bound",
    () => {
      const specs = [
        {
          operation: "planner",
          usage: usage(100, 20, "unbound-planner")
        },
        {
          operation: "coder",
          usage: usage(200, 50, "unbound-coder")
        }
      ];
      const ledger = buildEvents("unbound-run", specs);
      const result = buildRunCostLedgerFromAgentEvents({
        bindingVersion: "1",
        evidenceClass: "deterministic_fixture",
        observationSource: "fixture",
        observationReceiptHash: hash("unbound-observation"),
        taskSetHash: hash("unbound-tasks"),
        strategy: "adaptive_bounded_context",
        outcome: "accepted_patch",
        acceptedPatchCount: 1,
        agentLedger: ledger,
        pricingSnapshots: [priceSnapshot],
        observations: [{
          observationVersion: "1",
          eventId: ledger.events[0].eventId,
          operation: "planner",
          providerId: "openai-compatible",
          modelId: "qwen-coder",
          attempt: 1,
          usage: specs[0].usage,
          priceSnapshotId: priceSnapshot.snapshotId
        }]
      });
      assert.equal(result.decision, "agent_event_cost_binding_invalid");
      assert.ok(
        result.errors.includes("agent_event_cost_token_event_unbound")
      );
    }
  );

  check(
    "observed and estimated tokens never merge",
    () => {
      const mixed = clone(adaptive.input);
      mixed.runId = "mixed-run";
      mixed.invocations[0].usage = estimatedUsage(
        mixed.invocations[0].usage.inputTokens,
        mixed.invocations[0].usage.outputTokens,
        "mixed-planner"
      );
      const built = buildRunCostLedger(mixed);
      assert.equal(built.decision, "run_cost_ledger_ready");
      assert.equal(built.ledger.totals.estimated.invocationCount, 1);
      assert.equal(
        built.ledger.totals.observed.invocationCount,
        mixed.invocations.length - 1
      );
      assert.equal(built.ledger.totals.fullObservedCoverage, false);
      assert.equal(built.ledger.releaseClaimEligible, false);
    }
  );

  check(
    "unavailable usage remains explicit and has no token total",
    () => {
      const unavailable = clone(adaptive.input);
      unavailable.runId = "unavailable-run";
      unavailable.invocations[0].usage = {
        status: "unavailable",
        reason: "provider_usage_missing",
        providerResponseHash: hash("unavailable-response")
      };
      const built = buildRunCostLedger(unavailable);
      assert.equal(built.decision, "run_cost_ledger_ready");
      assert.equal(built.ledger.totals.unavailableInvocationCount, 1);
      assert.equal(built.ledger.totals.fullObservedCoverage, false);
    }
  );

  check(
    "nano-USD pricing is exact and cost per accepted patch is derived",
    () => {
      const built = buildRunCostLedger(direct.input);
      assert.equal(built.decision, "run_cost_ledger_ready");
      assert.equal(built.ledger.totals.observed.costNanoUsd, 290000);
      assert.equal(
        built.ledger.totals.costPerAcceptedPatchNanoUsd,
        290000
      );
    }
  );

  check(
    "missing price never becomes zero-cost observed evidence",
    () => {
      const unpriced = rawRun({
        runId: "unpriced-run",
        strategy: "adaptive_bounded_context",
        specs: adaptiveSpecs,
        pricing: false
      });
      const built = buildRunCostLedger(unpriced.input);
      assert.equal(built.decision, "run_cost_ledger_ready");
      assert.equal(
        built.ledger.totals.unpricedObservedInvocationCount,
        adaptiveSpecs.length
      );
      assert.equal(built.ledger.totals.fullObservedCoverage, false);
      assert.equal(
        built.ledger.totals.costPerAcceptedPatchNanoUsd,
        null
      );
    }
  );

  check(
    "retry remask expansion and shadow-admin overhead are separate",
    () => {
      const specs = [
        { operation: "planner", usage: usage(100, 20, "overhead-plan") },
        { operation: "coder", usage: usage(200, 50, "overhead-coder") },
        {
          operation: "coder",
          usage: usage(100, 25, "overhead-retry"),
          attempt: 2
        },
        { operation: "remask", usage: usage(40, 10, "overhead-remask") },
        { operation: "expansion", usage: usage(60, 10, "overhead-expansion") },
        { operation: "shadow", usage: usage(20, 5, "overhead-shadow") },
        { operation: "admin", usage: usage(10, 3, "overhead-admin") }
      ];
      const run = rawRun({
        runId: "overhead-run",
        strategy: "adaptive_bounded_context",
        specs
      });
      const built = buildRunCostLedger(run.input);
      assert.equal(built.ledger.totals.retryInvocationCount, 1);
      assert.equal(built.ledger.totals.retryObservedTokens, 125);
      assert.equal(built.ledger.totals.remaskObservedTokens, 50);
      assert.equal(built.ledger.totals.expansionObservedTokens, 70);
      assert.equal(built.ledger.totals.shadowAdminObservedTokens, 38);
    }
  );

  check(
    "deterministic A B C fixture is not release-claim eligible",
    () => {
      assert.equal(
        benchmark.decision,
        "run_cost_benchmark_ready",
        JSON.stringify(benchmark)
      );
      assert.equal(benchmark.report.allStrategiesPresent, true);
      assert.equal(benchmark.report.sameProviderModelSet, true);
      assert.equal(benchmark.report.samePricingSnapshotSet, true);
      assert.equal(benchmark.report.releaseClaimEligible, false);
      assert.equal(
        benchmark.report.evidenceClass,
        "deterministic_fixture"
      );
    }
  );

  check(
    "A B C observed token and cost savings stay strategy-specific",
    () => {
      const report = benchmark.report;
      assert.ok(
        report.comparisons.fixedVsDirectObservedTokenSavingsRate > 0
      );
      assert.ok(
        report.comparisons.adaptiveVsDirectObservedTokenSavingsRate > 0
      );
      assert.ok(
        report.comparisons.fixedVsDirectObservedCostSavingsRate > 0
      );
      assert.ok(
        report.comparisons.adaptiveVsDirectObservedCostSavingsRate > 0
      );
      assert.equal(report.strategyAggregates.length, 3);
    }
  );

  check(
    "run ordering does not change benchmark hash",
    () => {
      const reordered = clone(benchmarkInput);
      reordered.runs.reverse();
      const second = buildRunCostBenchmark(reordered);
      assert.equal(
        second.report.reportHash,
        benchmark.report.reportHash
      );
    }
  );

  check(
    "provider-model mismatch makes comparison ineligible",
    () => {
      const mismatched = clone(benchmarkInput);
      for (const invocation of mismatched.runs[0].invocations) {
        invocation.modelId = "different-model";
      }
      mismatched.runs[0].pricingSnapshots = [{
        ...mismatched.runs[0].pricingSnapshots[0],
        modelId: "different-model"
      }];
      const result = buildRunCostBenchmark(mismatched);
      assert.equal(result.decision, "run_cost_benchmark_ready");
      assert.equal(result.report.sameProviderModelSet, false);
      assert.equal(result.report.releaseClaimEligible, false);
    }
  );

  check(
    "missing strategy makes comparison ineligible",
    () => {
      const partial = clone(benchmarkInput);
      partial.runs = partial.runs.slice(0, 2);
      const result = buildRunCostBenchmark(partial);
      assert.equal(result.decision, "run_cost_benchmark_ready");
      assert.equal(result.report.allStrategiesPresent, false);
      assert.equal(result.report.releaseClaimEligible, false);
    }
  );

  check(
    "ledger and benchmark verification reject tampering",
    () => {
      const ledgerBuilt = buildRunCostLedger(direct.input);
      assert.equal(
        verifyRunCostLedger(direct.input, ledgerBuilt.ledger).decision,
        "run_cost_ledger_current"
      );
      const tamperedLedger = clone(ledgerBuilt.ledger);
      tamperedLedger.totals.observed.totalTokens = 0;
      assert.equal(
        verifyRunCostLedger(direct.input, tamperedLedger).decision,
        "run_cost_ledger_invalid"
      );

      assert.equal(
        verifyRunCostBenchmark(benchmarkInput, benchmark.report).decision,
        "run_cost_benchmark_current"
      );
      const tamperedReport = clone(benchmark.report);
      tamperedReport.comparisons.adaptiveVsDirectObservedCostSavingsRate = 0;
      assert.equal(
        verifyRunCostBenchmark(benchmarkInput, tamperedReport).decision,
        "run_cost_benchmark_invalid"
      );
    }
  );

  check(
    "cyclic and accessor inputs fail closed without executing accessors",
    () => {
      const cyclic = clone(direct.input);
      cyclic.self = cyclic;
      const cyclicResult = buildRunCostLedger(cyclic);
      assert.equal(cyclicResult.decision, "run_cost_ledger_invalid");

      let executed = false;
      const accessor = clone(direct.input);
      Object.defineProperty(accessor, "runId", {
        enumerable: true,
        get() {
          executed = true;
          throw new Error("must not execute");
        }
      });
      const accessorResult = buildRunCostLedger(accessor);
      assert.equal(accessorResult.decision, "run_cost_ledger_invalid");
      assert.equal(executed, false);
    }
  );

  check(
    "cost core and agent binding perform no filesystem shell network or Git write",
    () => {
      for (const file of [
        "packages/product-runtime/src/run-cost-ledger.ts",
        "packages/product-runtime/src/agent-event-cost-binding.ts"
      ]) {
        const source = fs.readFileSync(path.resolve(file), "utf8");
        assert.equal(
          /node:fs|node:child_process|fetch\s*\(|https?:\/\/|execFile|execSync|shell\s*:\s*true|git\s+(?:add|commit|push|update-ref)/i.test(source),
          false
        );
      }
    }
  );

  console.log(
    `run cost ledger smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
