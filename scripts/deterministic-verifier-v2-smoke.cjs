#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/canonical-runtime.js");
  const {
    DETERMINISTIC_VERIFIER_V2_VERSION,
    VERIFIER_V2_RULES,
    verifyPatchDraftMutationV2
  } = runtime;

  const roots = [];
  const checks = [];
  const check = async (name, fn) => {
    process.stdout.write(`[run] ${name}\n`);
    await fn();
    checks.push(name);
    process.stdout.write(`[ok] ${name}\n`);
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verifier-v2-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/service.ts"), "export const value = 1;\n");

  const mutation = (file = "src/service.ts", patch = "export const value = 2;", confidence = 0.9) => ({
    role: "coder",
    target: "patchDraft",
    summary: "Update fixture.",
    claims: [{ type: "patch_draft", file, description: "Update fixture.", proposedPatch: patch }],
    touchedFiles: [file],
    confidence
  });

  try {
    await check("canonical runtime exports verifier v2 registry", async () => {
      assert.equal(DETERMINISTIC_VERIFIER_V2_VERSION, "deterministic-verifier/v2");
      assert.equal(VERIFIER_V2_RULES.allowlistViolation.id, "DV2_ALLOWLIST_VIOLATION");
      assert.equal(Object.isFrozen(VERIFIER_V2_RULES), true);
    });

    await check("valid allowlisted patch is approved without false positive", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: ["src/service.ts"],
        forbiddenFiles: []
      });
      assert.equal(result.decision, "approve", JSON.stringify(result));
      assert.equal(result.ok, true);
      assert.deepEqual(result.canonicalTouchedFiles, ["src/service.ts"]);
    });

    await check("empty allowlist rejects touched files", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation(),
        allowedFiles: []
      });
      assert.equal(result.decision, "reject");
      assert(result.issues.some((entry) => entry.ruleId === "DV2_ALLOWLIST_VIOLATION"));
    });

    await check("path aliases and traversal fail closed", async () => {
      for (const file of ["./src/service.ts", "src/../src/service.ts", "../outside.ts", "src\\service.ts"]) {
        const result = await verifyPatchDraftMutationV2({
          repositoryPath: root,
          mutation: mutation(file),
          allowedFiles: ["src/service.ts"]
        });
        assert.equal(result.decision, "reject", `${file}: ${JSON.stringify(result)}`);
        assert(result.issues.some((entry) => entry.ruleId === "DV2_PATH_INVALID"));
      }
    });

    await check("symlink path fails closed", async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verifier-v2-outside-")));
      roots.push(outside);
      fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
      fs.symlinkSync(outside, path.join(root, "linked"), "dir");
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("linked/secret.ts"),
        allowedFiles: ["linked/secret.ts"]
      });
      assert.equal(result.decision, "reject", JSON.stringify(result));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_PATH_SYMLINK"));
    });

    await check("missing existing file requests review instead of approval", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("src/new.ts"),
        allowedFiles: ["src/new.ts"],
        requireExistingTouchedFiles: true
      });
      assert.equal(result.decision, "needs_review", JSON.stringify(result));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_PATH_MISSING"));
    });

    await check("unsafe patch and forbidden file are rejected", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("src/service.ts", "console.log(process.env.SECRET);"),
        allowedFiles: ["src/service.ts"],
        forbiddenFiles: ["src/service.ts"]
      });
      assert.equal(result.decision, "reject");
      assert(result.issues.some((entry) => entry.ruleId === "DV2_UNSAFE_PATCH"));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_FORBIDDEN_FILE"));
    });

    await check("low confidence is needs review not reject", async () => {
      const result = await verifyPatchDraftMutationV2({
        repositoryPath: root,
        mutation: mutation("src/service.ts", "export const value = 2;", 0.2),
        allowedFiles: ["src/service.ts"],
        minConfidence: 0.5
      });
      assert.equal(result.decision, "needs_review", JSON.stringify(result));
      assert(result.issues.some((entry) => entry.ruleId === "DV2_LOW_CONFIDENCE"));
    });

    console.log(JSON.stringify({
      ok: true,
      decision: "deterministic_verifier_v2_reliability_ready",
      checkCount: checks.length,
      checks
    }, null, 2));
  } finally {
    for (const item of roots) fs.rmSync(item, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
