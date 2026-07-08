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

function patchDraft(overrides = {}) {
  return {
    role: "coder",
    target: "patchDraft",
    summary: "Draft a bounded patch.",
    claims: [
      {
        type: "patch_draft",
        file: "packages/product-runtime/src/index.ts",
        description: "Export remask request builder.",
        proposedPatch: "export * from './remask-request-builder.js';"
      }
    ],
    touchedFiles: ["packages/product-runtime/src/index.ts"],
    confidence: 0.9,
    ...overrides
  };
}

function verifierFinding(decision, issues = [], overrides = {}) {
  return {
    role: "verifier",
    target: "verifierFinding",
    summary: `Deterministic verifier returned ${decision} for coder patchDraft.`,
    claims: [
      {
        type: "deterministic_verifier_finding",
        decision,
        issues
      }
    ],
    touchedFiles: ["packages/product-runtime/src/index.ts"],
    confidence: 1,
    ...overrides
  };
}

function issue(code, overrides = {}) {
  return {
    code,
    message: `Verifier issue: ${code}`,
    path: "claims.0",
    file: "packages/product-runtime/src/index.ts",
    ...overrides
  };
}

function assertNoRemask(result, repairability, code) {
  assert.equal(result.ok, true);
  assert.equal(result.repairability, repairability);
  assert.equal(result.remaskRequest, null);
  assert.ok(result.issues.some((resultIssue) => resultIssue.code === code), JSON.stringify(result.issues));
}

function assertRemask(result) {
  assert.equal(result.ok, true);
  assert.equal(result.repairability, "repairable");
  assert.ok(result.remaskRequest);
}

(async () => {
  const builderPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/remask-request-builder.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );
  const { buildRemaskRequestFromVerifierFinding } = await import(builderPath.href);
  const runtime = await import(indexPath.href);
  const { validateWorkspaceMutationContract } = await import(contractPath.href);

  check("approve verifier finding returns not_needed and no remaskRequest", () => {
    assertNoRemask(
      buildRemaskRequestFromVerifierFinding(patchDraft(), verifierFinding("approve")),
      "not_needed",
      "verifier_approved"
    );
  });

  check("reject verifier finding returns not_repairable and no remaskRequest", () => {
    assertNoRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("reject", [issue("unsafe_patch_content")])
      ),
      "not_repairable",
      "verifier_rejected"
    );
  });

  check("needs_review missing proposedPatch creates remaskRequest", () => {
    assertRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("needs_review", [issue("missing_proposed_patch")])
      )
    );
  });

  check("needs_review low_confidence creates remaskRequest", () => {
    assertRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("needs_review", [issue("low_confidence", { path: "confidence" })])
      )
    );
  });

  check("needs_review scope_violation creates remaskRequest", () => {
    assertRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("needs_review", [issue("scope_violation")])
      )
    );
  });

  check("forbidden_file_touch does not create remaskRequest", () => {
    assertNoRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("needs_review", [issue("forbidden_file_touch")])
      ),
      "not_repairable",
      "unsafe_or_forbidden_issue"
    );
  });

  check("unsafe_patch_content does not create remaskRequest", () => {
    assertNoRemask(
      buildRemaskRequestFromVerifierFinding(
        patchDraft(),
        verifierFinding("needs_review", [issue("unsafe_patch_content")])
      ),
      "not_repairable",
      "unsafe_or_forbidden_issue"
    );
  });

  check("missing verifier finding shape fails safely", () => {
    const result = buildRemaskRequestFromVerifierFinding(patchDraft(), {
      role: "verifier",
      target: "verifierFinding",
      summary: "Missing deterministic verifier claim.",
      claims: [],
      touchedFiles: []
    });

    assert.equal(result.ok, false);
    assert.equal(result.repairability, "not_repairable");
    assert.equal(result.remaskRequest, null);
    assert.ok(result.issues.some((resultIssue) => resultIssue.code === "missing_verifier_finding"));
  });

  check("original non-coder mutation fails safely", () => {
    const result = buildRemaskRequestFromVerifierFinding(
      patchDraft({ role: "planner", target: "plan" }),
      verifierFinding("needs_review", [issue("missing_proposed_patch")])
    );

    assert.equal(result.ok, false);
    assert.equal(result.repairability, "not_repairable");
    assert.equal(result.remaskRequest, null);
    assert.ok(result.issues.some((resultIssue) => resultIssue.code === "original_not_coder_patch_draft"));
  });

  const generated = buildRemaskRequestFromVerifierFinding(
    patchDraft(),
    verifierFinding("needs_review", [issue("missing_proposed_patch")])
  ).remaskRequest;

  check("generated remaskRequest has role verifier", () => {
    assert.equal(generated.role, "verifier");
  });

  check("generated remaskRequest has target remaskRequest", () => {
    assert.equal(generated.target, "remaskRequest");
  });

  check("generated remaskRequest preserves touchedFiles", () => {
    assert.deepEqual(generated.touchedFiles, patchDraft().touchedFiles);
  });

  check("generated remaskRequest passes WorkspaceMutation contract validation", () => {
    assert.deepEqual(validateWorkspaceMutationContract(generated), { ok: true, errors: [] });
  });

  check("runtime index exports remask request builder", () => {
    assert.equal(runtime.buildRemaskRequestFromVerifierFinding, buildRemaskRequestFromVerifierFinding);
  });

  console.log("remask request builder smoke passed");
})();
