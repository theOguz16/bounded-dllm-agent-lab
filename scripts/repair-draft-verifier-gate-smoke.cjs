const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
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

function repairDraft(overrides = {}) {
  const originalContent = "export * from './workspace-mutation.js';\n";
  return {
    role: "remask",
    target: "repairDraft",
    summary: "Repair a bounded patch draft.",
    claims: [
      {
        claimVersion: "text-file-update/v1",
        type: "repair_draft",
        operation: "update",
        file: "packages/product-runtime/src/index.ts",
        description: "Export repairDraft verifier gate.",
        expectedContentHash: `sha256:${createHash("sha256").update(originalContent).digest("hex")}`,
        newContent: "export * from './repair-draft-verifier-gate.js';"
      }
    ],
    touchedFiles: ["packages/product-runtime/src/index.ts"],
    confidence: 0.9,
    ...overrides
  };
}

function assertDecision(result, decision, code) {
  assert.equal(result.decision, decision);

  if (code) {
    assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
  }
}

(async () => {
  const gatePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/repair-draft-verifier-gate.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );
  const { verifyRepairDraftMutation: verifyRepairDraftMutationRaw } = await import(gatePath.href);
  const verifyRepairDraftMutation = (mutation, context = {}) => verifyRepairDraftMutationRaw(mutation, {
    fileContents: { "packages/product-runtime/src/index.ts": "export * from './workspace-mutation.js';\n" },
    ...context
  });
  const runtime = await import(indexPath.href);
  const { validateWorkspaceMutationContract } = await import(contractPath.href);

  check("valid repairDraft is approved", () => {
    const result = verifyRepairDraftMutation(repairDraft());

    assertDecision(result, "approve");
    assert.equal(result.issues.length, 0);
  });

  check("non-remask mutation is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ role: "coder" })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("non-repairDraft target is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ target: "patchDraft" })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("empty claims needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ claims: [] })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("missing repair_draft claim needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ claims: [{ type: "note" }] })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("missing file needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("missing description needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("missing proposedPatch needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            addressesIssueCodes: ["missing_export"]
          }
        ]
      })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("missing addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';"
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("invalid addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: "missing_export"
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("empty addressesIssueCodes needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Export repairDraft verifier gate.",
            proposedPatch: "export * from './repair-draft-verifier-gate.js';",
            addressesIssueCodes: []
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("repair claim outside touchedFiles needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        touchedFiles: ["packages/product-runtime/src/repair-draft-verifier-gate.ts"]
      })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("touched file without repair claim needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        touchedFiles: [
          "packages/product-runtime/src/index.ts",
          "packages/product-runtime/src/repair-draft-verifier-gate.ts"
        ]
      })),
      "reject",
      "MUTATION_SCHEMA_INVALID"
    );
  });

  check("forbidden file touch is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        forbiddenFiles: ["packages/product-runtime/src/index.ts"]
      }),
      "reject",
      "forbidden_file_touch"
    );
  });

  check("allowedFiles scope violation needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        allowedFiles: ["packages/product-runtime/src/repair-draft-verifier-gate.ts"]
      }),
      "needs_review",
      "scope_violation"
    );
  });

  check("unsafe proposedPatch is rejected", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({
        claims: [
          {
            type: "repair_draft",
            file: "packages/product-runtime/src/index.ts",
            description: "Read an environment secret.",
            proposedPatch: "const token = process.env.TOKEN;",
            addressesIssueCodes: ["unsafe_patch_content"]
          }
        ]
      })),
      "reject",
      "MUTATION_LEGACY_PATCH_FIELD"
    );
  });

  check("required issue code not addressed needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft(), {
        requiredIssueCodes: ["missing_proposed_patch"]
      }),
      "needs_review",
      "required_issue_code_not_addressed"
    );
  });

  check("low confidence needs_review", () => {
    assertDecision(
      verifyRepairDraftMutation(repairDraft({ confidence: 0.49 })),
      "needs_review",
      "low_confidence"
    );
  });

  check("generated finding has role verifier", () => {
    assert.equal(verifyRepairDraftMutation(repairDraft()).finding.role, "verifier");
  });

  check("generated finding has target verifierFinding", () => {
    assert.equal(verifyRepairDraftMutation(repairDraft()).finding.target, "verifierFinding");
  });

  check("generated finding passes WorkspaceMutation contract validation", () => {
    const result = verifyRepairDraftMutation(repairDraft());
    assert.deepEqual(validateWorkspaceMutationContract(result.finding), { ok: true, errors: [] });
  });

  check("runtime index exports repairDraft verifier gate", () => {
    assert.equal(runtime.verifyRepairDraftMutation, verifyRepairDraftMutationRaw);
  });

  console.log("repairDraft verifier gate smoke passed");
})();
