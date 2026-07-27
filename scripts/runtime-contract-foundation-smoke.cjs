#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import(
    "../dist/packages/product-runtime/src/runtime-contract-foundation.js"
  );
  const canonicalRuntime = await import(
    "../dist/packages/product-runtime/src/canonical-runtime.js"
  );

  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };

  await check("canonical runtime exports the shared contract foundation", async () => {
    assert.equal(canonicalRuntime.RUNTIME_CONTRACT_VERSION, "runtime-contract/v1");
    assert.equal(canonicalRuntime.RUNTIME_FAILURE_VERSION, "runtime-failure/v1");
    assert.equal(canonicalRuntime.CANONICAL_PATH_VERSION, "canonical-repository-path/v1");
  });

  await check("contract registry is frozen and complete", async () => {
    assert.equal(Object.isFrozen(runtime.RUNTIME_CONTRACT_REGISTRY), true);
    assert.equal(Object.isFrozen(runtime.RUNTIME_CONTRACT_REGISTRY.contracts), true);
    assert.equal(Object.isFrozen(runtime.RUNTIME_CONTRACT_REGISTRY.stages), true);
    assert.equal(runtime.RUNTIME_CONTRACT_REGISTRY.stages.length, 8);
    assert.equal(runtime.RUNTIME_CONTRACT_REGISTRY.failureRoutes.length, 6);
  });

  await check("runtime failures are versioned deterministic and frozen", async () => {
    const failure = runtime.createRuntimeFailure({
      stage: "verification",
      route: "policy_blocked",
      code: "forbidden_path_detected",
      message: "A forbidden repository path was detected.",
      details: { ruleId: "path.forbidden" }
    });
    assert.equal(failure.failureVersion, "runtime-failure/v1");
    assert.equal(failure.retryable, false);
    assert.equal(Object.isFrozen(failure), true);
    assert.equal(Object.isFrozen(failure.details), true);
  });

  await check("invalid runtime failure fields fail closed", async () => {
    assert.throws(() => runtime.createRuntimeFailure({
      stage: "unknown",
      route: "policy_blocked",
      code: "bad_stage",
      message: "Invalid stage."
    }), /stage is invalid/);
    assert.throws(() => runtime.createRuntimeFailure({
      stage: "planning",
      route: "unknown",
      code: "bad_route",
      message: "Invalid route."
    }), /route is invalid/);
    assert.throws(() => runtime.createRuntimeFailure({
      stage: "planning",
      route: "invalid_input",
      code: "Bad-Code",
      message: "Invalid code."
    }), /snake_case/);
  });

  await check("canonical repository paths preserve valid POSIX paths", async () => {
    assert.equal(runtime.canonicalizeRepositoryRelativePath("src/runtime/index.ts"), "src/runtime/index.ts");
    assert.equal(runtime.canonicalizeRepositoryRelativePath("package.json"), "package.json");
  });

  await check("path aliases and traversal fail closed", async () => {
    for (const value of [
      "src/../secret.ts",
      "./src/index.ts",
      "src//index.ts",
      "../outside.ts",
      "src\\index.ts"
    ]) {
      assert.throws(
        () => runtime.canonicalizeRepositoryRelativePath(value),
        runtime.CanonicalRepositoryPathError,
        value
      );
    }
  });

  await check("absolute drive UNC control and whitespace paths fail closed", async () => {
    for (const value of [
      "/etc/passwd",
      "C:\\Windows\\system.ini",
      "\\\\server\\share\\file.ts",
      "//server/share/file.ts",
      " src/index.ts",
      "src/index.ts ",
      "src/\u0000index.ts"
    ]) {
      assert.throws(
        () => runtime.canonicalizeRepositoryRelativePath(value),
        runtime.CanonicalRepositoryPathError,
        value
      );
    }
  });

  console.log(JSON.stringify({
    ok: true,
    decision: "runtime_contract_foundation_ready",
    checkCount: checks.length,
    checks
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
