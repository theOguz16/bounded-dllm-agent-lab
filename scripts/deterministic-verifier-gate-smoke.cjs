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
        description: "Export deterministic verifier gate.",
        proposedPatch: "export * from './deterministic-verifier-gate.js';"
      }
    ],
    touchedFiles: ["packages/product-runtime/src/index.ts"],
    confidence: 0.9,
    ...overrides
  };
}

function assertDecision(result, decision, code) {
  assert.equal(result.decision, decision);
  assert.equal(result.ok, decision === "approve");

  if (code) {
    assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
  }
}

(async () => {
  const gatePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/deterministic-verifier-gate.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );
  const { verifyPatchDraftMutation } = await import(gatePath.href);
  const runtime = await import(indexPath.href);
  const { validateWorkspaceMutationContract } = await import(contractPath.href);

  check("valid coder patchDraft is approved", () => {
    const result = verifyPatchDraftMutation(patchDraft());

    assertDecision(result, "approve");
    assert.equal(result.issues.length, 0);
  });

  check("non-coder mutation is rejected", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft({ role: "planner" })),
      "reject",
      "not_coder_patch_draft"
    );
  });

  check("non-patchDraft target is rejected", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft({ target: "plan" })),
      "reject",
      "not_coder_patch_draft"
    );
  });

  check("empty claims needs_review", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft({ claims: [] })),
      "needs_review",
      "empty_patch_claims"
    );
  });

  check("missing patch file needs_review", () => {
    const mutation = patchDraft({
      claims: [
        {
          type: "patch_draft",
          description: "Export deterministic verifier gate.",
          proposedPatch: "export * from './deterministic-verifier-gate.js';"
        }
      ]
    });

    assertDecision(verifyPatchDraftMutation(mutation), "needs_review", "missing_patch_file");
  });

  check("missing patch description needs_review", () => {
    const mutation = patchDraft({
      claims: [
        {
          type: "patch_draft",
          file: "packages/product-runtime/src/index.ts",
          proposedPatch: "export * from './deterministic-verifier-gate.js';"
        }
      ]
    });

    assertDecision(
      verifyPatchDraftMutation(mutation),
      "needs_review",
      "missing_patch_description"
    );
  });

  check("missing proposedPatch needs_review", () => {
    const mutation = patchDraft({
      claims: [
        {
          type: "patch_draft",
          file: "packages/product-runtime/src/index.ts",
          description: "Export deterministic verifier gate."
        }
      ]
    });

    assertDecision(verifyPatchDraftMutation(mutation), "needs_review", "missing_proposed_patch");
  });

  check("touched file without patch claim needs_review", () => {
    const mutation = patchDraft({
      touchedFiles: [
        "packages/product-runtime/src/index.ts",
        "packages/product-runtime/src/deterministic-verifier-gate.ts"
      ]
    });

    assertDecision(
      verifyPatchDraftMutation(mutation),
      "needs_review",
      "touched_file_without_patch_claim"
    );
  });

  check("patch claim outside touchedFiles needs_review", () => {
    const mutation = patchDraft({
      touchedFiles: ["packages/product-runtime/src/deterministic-verifier-gate.ts"]
    });

    assertDecision(
      verifyPatchDraftMutation(mutation),
      "needs_review",
      "patch_claim_outside_touched_files"
    );
  });

  check("forbidden file touch is rejected", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft(), {
        forbiddenFiles: ["packages/product-runtime/src/index.ts"]
      }),
      "reject",
      "forbidden_file_touch"
    );
  });

  check("allowedFiles scope violation needs_review", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft(), {
        allowedFiles: ["packages/product-runtime/src/deterministic-verifier-gate.ts"]
      }),
      "needs_review",
      "scope_violation"
    );
  });

  check("unsafe proposedPatch is rejected", () => {
    const mutation = patchDraft({
      claims: [
        {
          type: "patch_draft",
          file: "packages/product-runtime/src/index.ts",
          description: "Read an environment secret.",
          proposedPatch: "const token = process.env.TOKEN;"
        }
      ]
    });

    assertDecision(verifyPatchDraftMutation(mutation), "reject", "unsafe_patch_content");
  });

  check("low confidence needs_review", () => {
    assertDecision(
      verifyPatchDraftMutation(patchDraft({ confidence: 0.49 })),
      "needs_review",
      "low_confidence"
    );
  });

  check("generated finding has role verifier", () => {
    assert.equal(verifyPatchDraftMutation(patchDraft()).finding.role, "verifier");
  });

  check("generated finding has target verifierFinding", () => {
    assert.equal(verifyPatchDraftMutation(patchDraft()).finding.target, "verifierFinding");
  });

  check("generated finding passes WorkspaceMutation contract validation", () => {
    const result = verifyPatchDraftMutation(patchDraft());
    assert.deepEqual(validateWorkspaceMutationContract(result.finding), { ok: true, errors: [] });
  });

  check("runtime index exports deterministic verifier gate", () => {
    assert.equal(runtime.verifyPatchDraftMutation, verifyPatchDraftMutation);
  });

  console.log("deterministic verifier gate smoke passed");
})();
