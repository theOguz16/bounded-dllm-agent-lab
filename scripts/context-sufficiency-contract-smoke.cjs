const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

function check(name, fn) {
  try {
    fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

(async () => {
  const modulePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/context-sufficiency-contract.js`
  );

  const {
    createContextExpansionRequest,
    validateContextExpansionRequest,
    validateContextSufficiencyReport
  } = await import(modulePath.href);

  check("valid context request is normalized", () => {
    const request = createContextExpansionRequest({
      requestedFiles: ["src/config.ts", " src/config.ts "],
      requestedSymbols: ["UserConfig"],
      requestedTests: ["src/config.test.ts"],
      evidenceKinds: [
        "target_file",
        "required_test",
        "target_file"
      ],
      reason: "  Source and test evidence are required.  ",
      scopeExpansionRequested: false,
      maxAdditionalTokens: 800
    });

    assert.deepEqual(request.requestedFiles, [
      "src/config.ts"
    ]);

    assert.deepEqual(request.evidenceKinds, [
      "target_file",
      "required_test"
    ]);

    assert.equal(
      request.reason,
      "Source and test evidence are required."
    );
  });

  check("parent path traversal is rejected", () => {
    const result = validateContextExpansionRequest({
      requestedFiles: ["../secret.ts"],
      requestedSymbols: [],
      requestedTests: [],
      evidenceKinds: ["target_file"],
      reason: "Need source.",
      scopeExpansionRequested: false,
      maxAdditionalTokens: 500
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes("repository-relative")
      )
    );
  });

  check("empty context request is rejected", () => {
    const result = validateContextExpansionRequest({
      requestedFiles: [],
      requestedSymbols: [],
      requestedTests: [],
      evidenceKinds: ["target_file"],
      reason: "Need more context.",
      scopeExpansionRequested: false,
      maxAdditionalTokens: 500
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes("at least one")
      )
    );
  });

  check("unbounded token request is rejected", () => {
    const result = validateContextExpansionRequest({
      requestedFiles: ["src/a.ts"],
      requestedSymbols: [],
      requestedTests: [],
      evidenceKinds: ["target_file"],
      reason: "Need source.",
      scopeExpansionRequested: false,
      maxAdditionalTokens: 50000
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes("8192")
      )
    );
  });

  check("valid sufficiency report passes", () => {
    const result = validateContextSufficiencyReport({
      decision: "context_expansion_required",
      missingEvidence: ["Target type definition"],
      unresolvedSymbols: ["UserConfig"],
      missingFiles: ["src/types.ts"],
      missingTests: [],
      requestedExpansionTokens: 700,
      expansionAttempt: 1,
      confidence: 0.9
    });

    assert.deepEqual(result, {
      ok: true,
      errors: []
    });
  });

  check("third expansion attempt is rejected", () => {
    const result = validateContextSufficiencyReport({
      decision: "human_review_required",
      missingEvidence: ["Target type definition"],
      unresolvedSymbols: ["UserConfig"],
      missingFiles: ["src/types.ts"],
      missingTests: [],
      requestedExpansionTokens: 0,
      expansionAttempt: 3,
      confidence: 0.4
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes("between 0 and 2")
      )
    );
  });

  console.log(
    "context sufficiency contract smoke passed (6 checks)"
  );
})();
