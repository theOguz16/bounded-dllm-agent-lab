#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");

  assert.equal(runtime.CANONICAL_PRODUCT_RUNTIME_ENTRYPOINT, "canonical-product-runtime/v0.2-dev");
  assert.equal(runtime.RUNTIME_CONTRACT_VERSION, "runtime-contract/v1");
  assert.equal(runtime.DETERMINISTIC_VERIFIER_V2_VERSION, "deterministic-verifier/v2");
  assert.equal(typeof runtime.runBoundedTask, "function");
  assert.equal(typeof runtime.verifyPatchDraftMutationV2, "function");
  assert.equal(typeof runtime.canonicalizeRepositoryRelativePath, "function");

  const failure = runtime.createRuntimeFailure({
    stage: "verification",
    route: "human_review_required",
    code: "verifier_rejected",
    message: "Verifier rejected the mutation."
  });
  assert.equal(failure.ok, false);
  assert(Object.isFrozen(failure));
  assert.equal(runtime.canonicalizeRepositoryRelativePath("src/index.ts"), "src/index.ts");
  assert.throws(() => runtime.canonicalizeRepositoryRelativePath("../secret.ts"));

  console.log(JSON.stringify({
    ok: true,
    decision: "product_unit_ready",
    checkCount: 9
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
