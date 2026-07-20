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

function request(overrides = {}) {
  return {
    requestedFiles: ["src/types.ts"],
    requestedSymbols: ["UserConfig"],
    requestedTests: ["src/config.test.ts"],
    evidenceKinds: [
      "type_definition",
      "required_test"
    ],
    reason: "Required implementation evidence is missing.",
    scopeExpansionRequested: false,
    maxAdditionalTokens: 800,
    ...overrides
  };
}

function rawMutation(overrides = {}) {
  return JSON.stringify({
    role: "coder",
    target: "contextRequest",
    summary: "Request bounded context expansion.",
    claims: [],
    touchedFiles: [],
    contextRequest: request(),
    confidence: 0.8,
    ...overrides
  });
}

function assertBlockedWithCode(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.mutation, null);
  assert.ok(
    result.issues.some((issue) => issue.code === code),
    JSON.stringify(result.issues)
  );
}

(async () => {
  const workspacePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/workspace-mutation.js`
  );

  const validatorPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/model-mutation-validator.js`
  );

  const {
    canRoleWriteWorkspaceMutationTarget,
    validateWorkspaceMutationContract
  } = await import(workspacePath.href);

  const {
    validateModelWorkspaceMutation
  } = await import(validatorPath.href);

  check("planner can request context", () => {
    assert.equal(
      canRoleWriteWorkspaceMutationTarget(
        "planner",
        "contextRequest"
      ),
      true
    );
  });

  check("coder can request context", () => {
    assert.equal(
      canRoleWriteWorkspaceMutationTarget(
        "coder",
        "contextRequest"
      ),
      true
    );
  });

  check("verifier cannot request context", () => {
    assert.equal(
      canRoleWriteWorkspaceMutationTarget(
        "verifier",
        "contextRequest"
      ),
      false
    );
  });

  check("valid workspace context request passes", () => {
    const result = validateWorkspaceMutationContract({
      role: "coder",
      target: "contextRequest",
      summary: "Request type evidence.",
      claims: [],
      touchedFiles: [],
      contextRequest: request(),
      confidence: 0.8
    });

    assert.deepEqual(result, {
      ok: true,
      errors: []
    });
  });

  check("missing context request is blocked", () => {
    const value = JSON.parse(rawMutation());
    delete value.contextRequest;

    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        JSON.stringify(value),
        { role: "coder" }
      ),
      "context_request_missing"
    );
  });

  check("context request cannot touch files", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        rawMutation({
          touchedFiles: ["src/types.ts"]
        }),
        { role: "coder" }
      ),
      "context_request_touches_files"
    );
  });

  check("unsafe requested path is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        rawMutation({
          contextRequest: request({
            requestedFiles: ["../secret.ts"]
          })
        }),
        { role: "coder" }
      ),
      "context_request_invalid"
    );
  });

  check("allowed context request passes", () => {
    const result = validateModelWorkspaceMutation(
      rawMutation(),
      {
        role: "coder",
        allowedContextFiles: [
          "src/types.ts",
          "src/config.test.ts"
        ]
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(
      result.mutation.target,
      "contextRequest"
    );
  });

  check("implicit read scope expansion is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        rawMutation(),
        {
          role: "coder",
          allowedContextFiles: ["src/other.ts"]
        }
      ),
      "context_request_scope_violation"
    );
  });

  check("explicit scope expansion request is accepted", () => {
    const result = validateModelWorkspaceMutation(
      rawMutation({
        contextRequest: request({
          scopeExpansionRequested: true
        })
      }),
      {
        role: "coder",
        allowedContextFiles: ["src/other.ts"]
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(
      result.mutation.contextRequest
        .scopeExpansionRequested,
      true
    );
  });

  check("forbidden context file is blocked", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        rawMutation(),
        {
          role: "coder",
          forbiddenFiles: ["src/types.ts"]
        }
      ),
      "context_request_scope_violation"
    );
  });

  check("patch mutation cannot carry contextRequest", () => {
    assertBlockedWithCode(
      validateModelWorkspaceMutation(
        rawMutation({
          target: "patchDraft"
        }),
        { role: "coder" }
      ),
      "context_request_invalid"
    );
  });

  console.log(
    "context request mutation smoke passed (12 checks)"
  );
})();
