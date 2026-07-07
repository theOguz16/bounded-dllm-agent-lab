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

function rawMutation(overrides = {}) {
  return JSON.stringify({
    role: "planner",
    target: "plan",
    summary: "Create a plan.",
    claims: [],
    touchedFiles: [],
    ...overrides
  });
}

function assertBlockedWithCode(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.mutation, null);
  assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
}

(async () => {
  const validatorPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/model-mutation-validator.js`
  );
  const {
    parseModelWorkspaceMutationOutput,
    validateModelWorkspaceMutation
  } = await import(validatorPath.href);

  check("valid planner plan mutation passes", () => {
    const result = validateModelWorkspaceMutation(rawMutation(), { role: "planner" });

    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(result.issues.length, 0);
    assert.equal(result.mutation.role, "planner");
    assert.equal(result.mutation.target, "plan");
  });

  check("valid coder patchDraft mutation passes", () => {
    const result = validateModelWorkspaceMutation(
      rawMutation({
        role: "coder",
        target: "patchDraft",
        summary: "Draft patch.",
        touchedFiles: ["packages/product-runtime/src/index.ts"]
      }),
      { role: "coder" }
    );

    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.deepEqual(result.mutation.touchedFiles, ["packages/product-runtime/src/index.ts"]);
  });

  check("invalid JSON is blocked", () => {
    const parsed = parseModelWorkspaceMutationOutput("{");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.issues[0].code, "invalid_json");

    assertBlockedWithCode(validateModelWorkspaceMutation("{", { role: "planner" }), "invalid_json");
  });

  check("prose output is blocked as invalid_json", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation("Here is the plan: {}", { role: "planner" }),
      "invalid_json"
    );
  });

  check("role mismatch is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ role: "coder", target: "patchDraft" }), {
        role: "planner"
      }),
      "role_target_violation"
    );
  });

  check("role target violation is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ role: "coder", target: "plan" }), {
        role: "coder"
      }),
      "role_target_violation"
    );
  });

  check("missing summary is blocked", () => {
    const value = JSON.parse(rawMutation());
    delete value.summary;

    assertBlockedWithCode(
      validateModelWorkspaceMutation(JSON.stringify(value), { role: "planner" }),
      "missing_required_field"
    );
  });

  check("empty summary is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ summary: "   " }), { role: "planner" }),
      "empty_summary"
    );
  });

  check("claims not array is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ claims: null }), { role: "planner" }),
      "claims_not_array"
    );
  });

  check("touchedFiles not array is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ touchedFiles: null }), { role: "planner" }),
      "touched_files_not_array"
    );
  });

  check("invalid confidence is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ confidence: -0.1 }), { role: "planner" }),
      "invalid_confidence"
    );
  });

  check("touched file outside allowedFiles is blocked with scope_violation", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ touchedFiles: ["src/other.ts"] }), {
        role: "planner",
        allowedFiles: ["src/plan.ts"]
      }),
      "scope_violation"
    );
  });

  check("forbidden file touch is blocked with forbidden_file_touch", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(rawMutation({ touchedFiles: [".env"] }), {
        role: "planner",
        forbiddenFiles: [".env"]
      }),
      "forbidden_file_touch"
    );
  });

  check("valid mutation with empty touchedFiles passes when allowedFiles is provided", () => {
    const result = validateModelWorkspaceMutation(rawMutation({ touchedFiles: [] }), {
      role: "planner",
      allowedFiles: ["src/plan.ts"]
    });

    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.deepEqual(result.mutation.touchedFiles, []);
  });

  check("valid mutation preserves confidence", () => {
    const result = validateModelWorkspaceMutation(rawMutation({ confidence: 0.42 }), {
      role: "planner"
    });

    assert.equal(result.ok, true);
    assert.equal(result.mutation.confidence, 0.42);
  });

  console.log("model mutation validator smoke passed");
})();
