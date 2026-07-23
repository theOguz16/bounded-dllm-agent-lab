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
    buildSoftScopeDriftBenchmark,
    verifySoftScopeDriftBenchmarkReport
  } = runtime;

  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve(
        "fixtures/release/soft-scope-drift-benchmark.json"
      ),
      "utf8"
    )
  );

  const result =
    buildSoftScopeDriftBenchmark(fixture);

  if (mode === "--report") {
    console.log(
      JSON.stringify(result, null, 2)
    );
    process.exitCode =
      result.decision ===
        "soft_scope_drift_benchmark_ready"
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
  const clone = (value) =>
    structuredClone(value);
  const findCase = (report, caseId) =>
    report.caseResults.find(
      (entry) => entry.caseId === caseId
    );
  const findStrategy = (report, strategy) =>
    report.strategyAggregates.find(
      (entry) => entry.strategy === strategy
    );

  check(
    "deterministic fixture builds but is not release-claim eligible",
    () => {
      assert.equal(
        result.decision,
        "soft_scope_drift_benchmark_ready",
        JSON.stringify(result)
      );
      assert.equal(
        result.report.evidenceClass,
        "deterministic_fixture"
      );
      assert.equal(
        result.report.releaseClaimEligible,
        false
      );
    }
  );

  check(
    "hard forbidden touch is blocked separately from soft drift",
    () => {
      const entry = findCase(
        result.report,
        "direct-hard-forbidden"
      );
      assert.equal(
        entry.decision,
        "hard_scope_blocked"
      );
      assert.deepEqual(
        entry.metrics.forbiddenTouchedFiles,
        ["package-lock.json"]
      );
      assert.equal(
        entry.metrics.hardViolationCount,
        1
      );
      assert.ok(
        entry.reasonCodes.includes(
          "hard_scope_forbidden_file_touched"
        )
      );
    }
  );

  check(
    "allowed but unexpected files produce soft review",
    () => {
      const entry = findCase(
        result.report,
        "direct-soft-expansion"
      );
      assert.equal(
        entry.decision,
        "soft_scope_review"
      );
      assert.deepEqual(
        entry.metrics
          .unexpectedButAllowedFiles,
        ["src/adapter.ts", "src/factory.ts"]
      );
      assert.equal(
        entry.metrics.hardViolationCount,
        0
      );
    }
  );

  check(
    "unnecessary and uncertain LOC are measured separately",
    () => {
      const entry = findCase(
        result.report,
        "direct-soft-expansion"
      );
      assert.equal(
        entry.metrics.unnecessaryLoc,
        35
      );
      assert.equal(
        entry.metrics.uncertainLoc,
        28
      );
    }
  );

  check(
    "unrequested refactors dependencies and abstractions are counted",
    () => {
      const entry = findCase(
        result.report,
        "direct-soft-expansion"
      );
      assert.equal(
        entry.metrics
          .unrequestedRefactorCount,
        2
      );
      assert.equal(
        entry.metrics
          .unrequestedDependencyCount,
        1
      );
      assert.equal(
        entry.metrics
          .unrequestedAbstractionCount,
        2
      );
    }
  );

  check(
    "abstraction justification rate is deterministic",
    () => {
      const entry = findCase(
        result.report,
        "direct-soft-expansion"
      );
      assert.equal(
        entry.metrics
          .abstractionJustificationRate,
        0.5
      );
    }
  );

  check(
    "human unnecessary labels create an independent soft signal",
    () => {
      const entry = findCase(
        result.report,
        "adaptive-human-unnecessary"
      );
      assert.equal(
        entry.metrics
          .humanUnnecessaryLabelCount,
        1
      );
      assert.equal(
        entry.metrics
          .humanUnnecessaryRate,
        0.5
      );
      assert.ok(
        entry.reasonCodes.includes(
          "soft_scope_human_unnecessary_label"
        )
      );
    }
  );

  check(
    "missing expected files are coverage gaps not hard violations",
    () => {
      const entry = findCase(
        result.report,
        "fixed-missing-expected"
      );
      assert.equal(
        entry.decision,
        "soft_scope_review"
      );
      assert.deepEqual(
        entry.metrics.missingExpectedFiles,
        ["test/service.test.ts"]
      );
      assert.equal(
        entry.metrics.hardViolationCount,
        0
      );
    }
  );

  check(
    "requested justified dependency can remain scope clean",
    () => {
      const entry = findCase(
        result.report,
        "fixed-clean-requested-dependency"
      );
      assert.equal(
        entry.decision,
        "scope_clean"
      );
      assert.equal(
        entry.metrics.newDependencyCount,
        1
      );
      assert.equal(
        entry.metrics
          .unrequestedDependencyCount,
        0
      );
      assert.equal(
        entry.metrics
          .unjustifiedDependencyCount,
        0
      );
    }
  );

  check(
    "A B and C strategy aggregates remain separate",
    () => {
      assert.equal(
        result.report
          .strategyAggregates.length,
        3
      );
      const direct = findStrategy(
        result.report,
        "direct_large_context"
      );
      const fixed = findStrategy(
        result.report,
        "fixed_bounded_context"
      );
      const adaptive = findStrategy(
        result.report,
        "adaptive_bounded_context"
      );
      assert.equal(direct.caseCount, 2);
      assert.equal(fixed.caseCount, 2);
      assert.equal(adaptive.caseCount, 2);
      assert.equal(direct.blockedCaseCount, 1);
      assert.equal(adaptive.cleanCaseCount, 1);
    }
  );

  check(
    "case ordering does not change report hash",
    () => {
      const reordered = clone(fixture);
      reordered.cases.reverse();
      const second =
        buildSoftScopeDriftBenchmark(
          reordered
        );
      assert.equal(
        second.report.reportHash,
        result.report.reportHash
      );
    }
  );

  check(
    "report verifies and tampering fails",
    () => {
      const current =
        verifySoftScopeDriftBenchmarkReport(
          fixture,
          result.report
        );
      assert.equal(
        current.decision,
        "soft_scope_drift_benchmark_report_current"
      );
      const tampered =
        clone(result.report);
      tampered.overall.unnecessaryLoc = 0;
      const invalid =
        verifySoftScopeDriftBenchmarkReport(
          fixture,
          tampered
        );
      assert.equal(
        invalid.decision,
        "soft_scope_drift_benchmark_report_invalid"
      );
    }
  );

  check(
    "inconsistent scope contract is invalid",
    () => {
      const invalid = clone(fixture);
      invalid.cases[0].expectedFiles.push(
        "outside.ts"
      );
      const built =
        buildSoftScopeDriftBenchmark(
          invalid
        );
      assert.equal(
        built.decision,
        "soft_scope_drift_benchmark_invalid"
      );
      assert.ok(
        built.errors.includes(
          "soft_scope_contract_invalid"
        )
      );
    }
  );

  check(
    "duplicate actual observations are invalid",
    () => {
      const invalid = clone(fixture);
      invalid.cases[0].actualChanges.push(
        clone(
          invalid.cases[0]
            .actualChanges[0]
        )
      );
      const built =
        buildSoftScopeDriftBenchmark(
          invalid
        );
      assert.equal(
        built.decision,
        "soft_scope_drift_benchmark_invalid"
      );
      assert.ok(
        built.errors.includes(
          "soft_scope_actual_duplicate"
        )
      );
    }
  );

  check(
    "cyclic and accessor inputs fail closed without side effects",
    () => {
      const cyclic = clone(fixture);
      cyclic.self = cyclic;
      const cyclicResult =
        buildSoftScopeDriftBenchmark(
          cyclic
        );
      assert.equal(
        cyclicResult.decision,
        "soft_scope_drift_benchmark_invalid"
      );

      const accessor = clone(fixture);
      Object.defineProperty(
        accessor,
        "benchmarkId",
        {
          enumerable: true,
          get() {
            throw new Error(
              "accessor must not execute"
            );
          }
        }
      );
      const accessorResult =
        buildSoftScopeDriftBenchmark(
          accessor
        );
      assert.equal(
        accessorResult.decision,
        "soft_scope_drift_benchmark_invalid"
      );
      assert.equal(
        accessorResult.summary
          .repositoryWritePerformed,
        false
      );
    }
  );

  check(
    "benchmark core performs no filesystem shell network or Git write",
    () => {
      const source = fs.readFileSync(
        path.resolve(
          "packages/product-runtime/src/soft-scope-drift-benchmark.ts"
        ),
        "utf8"
      );
      assert.equal(
        /node:fs|node:child_process|fetch\s*\(|https?:\/\/|execFile|execSync|shell\s*:\s*true|git\s+(?:add|commit|push|update-ref)/i
          .test(source),
        false
      );
    }
  );

  console.log(
    `soft scope drift benchmark smoke passed (${checks} checks)`
  );
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
