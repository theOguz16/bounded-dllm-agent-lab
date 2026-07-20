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
  const contractPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );
  const {
    canRoleWriteWorkspaceMutationTarget,
    createWorkspaceMutation,
    getAllowedWorkspaceMutationTargets,
    validateWorkspaceMutationContract
  } = await import(contractPath.href);

  check("planner can write plan", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("planner", "plan"), true);
    assert.deepEqual(getAllowedWorkspaceMutationTargets("planner"), ["plan", "contextRequest"]);
  });

  check("coder can write patchDraft", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("coder", "patchDraft"), true);
  });

  check("verifier can write verifierFinding", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("verifier", "verifierFinding"), true);
  });

  check("verifier can write remaskRequest", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("verifier", "remaskRequest"), true);
  });

  check("remask can write repairDraft", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("remask", "repairDraft"), true);
  });

  check("coder cannot write plan", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("coder", "plan"), false);
  });

  check("planner cannot write patchDraft", () => {
    assert.equal(canRoleWriteWorkspaceMutationTarget("planner", "patchDraft"), false);
  });

  check("invalid confidence fails", () => {
    const result = validateWorkspaceMutationContract({
      role: "planner",
      target: "plan",
      summary: "Create plan.",
      claims: [],
      touchedFiles: [],
      confidence: 1.1
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("confidence")));
  });

  check("empty summary fails", () => {
    const result = validateWorkspaceMutationContract({
      role: "coder",
      target: "patchDraft",
      summary: "   ",
      claims: [],
      touchedFiles: []
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("summary")));
  });

  check("valid mutation passes", () => {
    const mutation = createWorkspaceMutation({
      role: "verifier",
      target: "remaskRequest",
      summary: "  Request remask repair.  ",
      claims: null,
      touchedFiles: null,
      confidence: 0.8
    });

    assert.deepEqual(mutation, {
      role: "verifier",
      target: "remaskRequest",
      summary: "Request remask repair.",
      claims: [],
      touchedFiles: [],
      confidence: 0.8
    });
    assert.deepEqual(validateWorkspaceMutationContract(mutation), { ok: true, errors: [] });
  });

  console.log("workspace mutation contract smoke passed");
})();
