const assert =
  require("node:assert/strict");

const { createHash } =
  require("node:crypto");

const fs =
  require("node:fs");

const os =
  require("node:os");

const path =
  require("node:path");

const {
  pathToFileURL
} = require("node:url");

async function check(name, fn) {
  try {
    await fn();
    console.log(`[ok] ${name}`);
  } catch (error) {
    console.error(`[fail] ${name}`);
    throw error;
  }
}

function hashText(value) {
  return `sha256:${createHash("sha256")
    .update(value)
    .digest("hex")}`;
}

function evidence(
  filePath,
  content
) {
  const bytes =
    Buffer.from(content, "utf8");

  return {
    path: filePath,
    source: "fixture",
    content,
    contentHash:
      hashText(bytes),
    byteLength:
      bytes.length,
    estimatedTokens:
      Math.ceil(
        content.length / 4
      ),
    matchedSymbols: []
  };
}

function patchMutation(
  touchedFiles = [
    "src/config.ts"
  ]
) {
  return {
    role: "coder",
    target: "patchDraft",
    summary:
      "Update configuration behavior.",
    claims: [
      {
        kind:
          "implementation"
      }
    ],
    touchedFiles,
    confidence: 0.9
  };
}

function contextRequest() {
  return {
    requestedFiles: [
      "src/config.ts"
    ],
    requestedSymbols: [
      "UserConfig"
    ],
    requestedTests: [],
    evidenceKinds: [
      "target_file",
      "type_definition"
    ],
    reason:
      "The target source definition is required.",
    scopeExpansionRequested:
      false,
    maxAdditionalTokens:
      3000
  };
}

function adaptiveInput(
  root,
  coderProvider,
  overrides = {}
) {
  return {
    repositoryPath: root,
    baseContext: {
      task:
        "Update configuration behavior.",
      authority: [
        "Only update configuration behavior."
      ],
      policy: [
        "Do not read secrets."
      ]
    },
    initialEvidence: [
      evidence(
        "src/config.test.ts",
        "import { loadConfig } from \"./config.js\";\nloadConfig();\n"
      )
    ],
    requiredSourceFiles: [
      "src/config.ts"
    ],
    requiredTestFiles: [
      "src/config.test.ts"
    ],
    requiredSymbols: [
      "UserConfig"
    ],
    authorityPresent: true,
    policyPresent: true,
    allowedContextFiles: [
      "src/config.ts",
      "src/config.test.ts"
    ],
    forbiddenFiles: [
      ".env"
    ],
    hardTotalBudgetTokens:
      7000,
    reservedOutputTokens:
      1000,
    maxExpansionAttempts: 2,
    contextRequestProvider:
      async () =>
        contextRequest(),
    coderProvider,
    ...overrides
  };
}

(async () => {
  const root =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "context-auth-"
      )
    );

  fs.mkdirSync(
    path.join(root, "src"),
    { recursive: true }
  );

  const source =
    "export type UserConfig = { enabled: boolean };\nexport function loadConfig(): UserConfig { return { enabled: true }; }\n";

  const test =
    "import { loadConfig } from \"./config.js\";\nloadConfig();\n";

  fs.writeFileSync(
    path.join(
      root,
      "src/config.ts"
    ),
    source
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/config.test.ts"
    ),
    test
  );

  const orchestratorPath =
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/adaptive-context-orchestrator.js`
    );

  const authorizationPath =
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/context-sufficiency-authorization.js`
    );

  const {
    runAdaptiveCoderContextFlow
  } = await import(
    orchestratorPath.href
  );

  const {
    authorizeContextSufficientPatch,
    verifyContextSufficiencyAuthorization,
    runContextAuthorizedDeliveryChain
  } = await import(
    authorizationPath.href
  );

  async function completedAdaptive(
    overrides = {}
  ) {
    return runAdaptiveCoderContextFlow(
      adaptiveInput(
        root,
        async () =>
          patchMutation(),
        overrides
      )
    );
  }

  await check(
    "completed adaptive flow authorizes full delivery chain",
    async () => {
      const adaptive =
        await completedAdaptive();

      let patchCalls = 0;
      let handoffCalls = 0;
      let applyCalls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ],
          forbiddenFiles: [
            ".env"
          ],
          patchPipeline:
            async (
              mutation,
              authorization
            ) => {
              patchCalls += 1;

              assert.equal(
                mutation.target,
                "patchDraft"
              );

              assert.match(
                authorization
                  .authorizationHash,
                /^sha256:[0-9a-f]{64}$/
              );

              return {
                ok: true,
                value: {
                  patchValidated:
                    true
                }
              };
            },
          handoffPipeline:
            async (
              patchOutput,
              _mutation,
              authorization
            ) => {
              handoffCalls += 1;

              assert.equal(
                patchOutput
                  .patchValidated,
                true
              );

              return {
                ok: true,
                value: {
                  handoffHash:
                    authorization
                      .authorizationHash
                }
              };
            },
          applyPipeline:
            async (
              handoffOutput
            ) => {
              applyCalls += 1;

              return {
                ok: true,
                value: {
                  applied:
                    Boolean(
                      handoffOutput
                        .handoffHash
                    )
                }
              };
            }
        });

      assert.equal(
        result.route,
        "apply_completed"
      );

      assert.equal(
        patchCalls,
        1
      );

      assert.equal(
        handoffCalls,
        1
      );

      assert.equal(
        applyCalls,
        1
      );

      assert.equal(
        result.applyOutput.applied,
        true
      );
    }
  );

  await check(
    "expansion evidence is bound into authorization",
    async () => {
      const adaptive =
        await completedAdaptive();

      const authorization =
        authorizeContextSufficientPatch({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ]
        });

      assert.equal(
        authorization.decision,
        "context_authorization_ready"
      );

      assert.equal(
        authorization.authorization
          .expansion.attemptCount,
        1
      );

      assert.ok(
        authorization.authorization
          .context.evidenceBindings
          .some(
            (entry) =>
              entry.path ===
                "src/config.ts" &&
              entry.origin ===
                "context_expansion"
          )
      );
    }
  );

  await check(
    "canonical policy hash is bound and malformed hashes fail closed",
    async () => {
      const adaptive = await completedAdaptive();
      const policyHash = hashText("canonical-policy");
      const authorized = authorizeContextSufficientPatch({
        adaptiveResult: adaptive,
        allowedFiles: ["src/config.ts"],
        policyHash
      });
      assert.equal(authorized.decision, "context_authorization_ready");
      assert.equal(authorized.authorization.policyHash, policyHash);
      assert.equal(verifyContextSufficiencyAuthorization(
        authorized.authorization, authorized.mutation).ok, true);
      assert.equal(verifyContextSufficiencyAuthorization(
        authorized.authorization, authorized.mutation).policyHashValid, true);

      const invalid = authorizeContextSufficientPatch({
        adaptiveResult: adaptive,
        allowedFiles: ["src/config.ts"],
        policyHash: "platform-owner"
      });
      assert.equal(invalid.decision, "context_authorization_invalid");
      assert.equal(invalid.issues[0].code, "context_authorization_policy_hash_invalid");
    }
  );

  await check(
    "stopped adaptive flow calls no downstream stage",
    async () => {
      const adaptive =
        await runAdaptiveCoderContextFlow(
          adaptiveInput(
            root,
            async () =>
              patchMutation(),
            {
              authorityPresent:
                false
            }
          )
        );

      let calls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          patchPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          handoffPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          applyPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            }
        });

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);
    }
  );

  await check(
    "invalid coder output cannot authorize downstream",
    async () => {
      const adaptive =
        await runAdaptiveCoderContextFlow(
          adaptiveInput(
            root,
            async () => ({
              role: "coder",
              target:
                "contextRequest",
              summary:
                "Invalid output.",
              claims: [],
              touchedFiles: []
            })
          )
        );

      let calls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          patchPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          handoffPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          applyPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            }
        });

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);
    }
  );

  await check(
    "patch touching invisible file is blocked",
    async () => {
      const adaptive =
        await runAdaptiveCoderContextFlow(
          adaptiveInput(
            root,
            async () =>
              patchMutation([
                "src/other.ts"
              ])
          )
        );

      const result =
        authorizeContextSufficientPatch({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/other.ts"
          ]
        });

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        result.issues[0].code,
        "changed_file_not_visible_to_coder"
      );
    }
  );

  await check(
    "patch pipeline failure stops handoff and apply",
    async () => {
      const adaptive =
        await completedAdaptive();

      let handoffCalls = 0;
      let applyCalls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ],
          patchPipeline:
            async () => ({
              ok: false,
              code:
                "patch_validation_failed",
              message:
                "Patch validation failed.",
              route:
                "replan_required"
            }),
          handoffPipeline:
            async () => {
              handoffCalls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          applyPipeline:
            async () => {
              applyCalls += 1;

              return {
                ok: true,
                value: {}
              };
            }
        });

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        handoffCalls,
        0
      );

      assert.equal(
        applyCalls,
        0
      );
    }
  );

  await check(
    "handoff failure prevents apply",
    async () => {
      const adaptive =
        await completedAdaptive();

      let applyCalls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ],
          patchPipeline:
            async () => ({
              ok: true,
              value: {
                patch: true
              }
            }),
          handoffPipeline:
            async () => ({
              ok: false,
              code:
                "handoff_blocked",
              message:
                "Handoff blocked."
            }),
          applyPipeline:
            async () => {
              applyCalls += 1;

              return {
                ok: true,
                value: {}
              };
            }
        });

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        applyCalls,
        0
      );
    }
  );

  await check(
    "apply failure remains fail closed",
    async () => {
      const adaptive =
        await completedAdaptive();

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ],
          patchPipeline:
            async () => ({
              ok: true,
              value: {
                patch: true
              }
            }),
          handoffPipeline:
            async () => ({
              ok: true,
              value: {
                handoff: true
              }
            }),
          applyPipeline:
            async () => ({
              ok: false,
              code:
                "apply_blocked",
              message:
                "Apply blocked."
            })
        });

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.summary
          .applyPipelineCallCount,
        1
      );

      assert.equal(
        result.applyOutput,
        null
      );
    }
  );

  await check(
    "authorization tampering is detected",
    async () => {
      const adaptive =
        await completedAdaptive();

      const authorized =
        authorizeContextSufficientPatch({
          adaptiveResult:
            adaptive,
          allowedFiles: [
            "src/config.ts"
          ]
        });

      const tampered = {
        ...authorized.authorization,
        budget: {
          ...authorized
            .authorization.budget,
          remainingTokens:
            authorized.authorization
              .budget
              .remainingTokens + 1
        }
      };

      const verification =
        verifyContextSufficiencyAuthorization(
          tampered,
          authorized.mutation
        );

      assert.equal(
        verification.ok,
        false
      );

      assert.equal(
        verification
          .authorizationHashMatched,
        false
      );
    }
  );

  await check(
    "coder provider failure authorizes nothing",
    async () => {
      const adaptive =
        await runAdaptiveCoderContextFlow(
          adaptiveInput(
            root,
            async () => {
              throw new Error(
                "coder unavailable"
              );
            }
          )
        );

      let calls = 0;

      const result =
        await runContextAuthorizedDeliveryChain({
          adaptiveResult:
            adaptive,
          patchPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          handoffPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            },
          applyPipeline:
            async () => {
              calls += 1;

              return {
                ok: true,
                value: {}
              };
            }
        });

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);
    }
  );

  fs.rmSync(
    root,
    {
      recursive: true,
      force: true
    }
  );

  console.log(
    "context sufficiency authorization smoke passed (10 checks)"
  );
})().catch((error) => {
  console.error(
    error.stack || error
  );

  process.exitCode = 1;
});
