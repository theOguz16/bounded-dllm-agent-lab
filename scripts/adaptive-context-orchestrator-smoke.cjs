const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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
  content,
  source = "fixture"
) {
  const bytes =
    Buffer.from(content, "utf8");

  return {
    path: filePath,
    source,
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

function contextRequest({
  files = [],
  tests = [],
  symbols = [],
  scopeExpansionRequested = false,
  maxAdditionalTokens = 4000
} = {}) {
  return {
    requestedFiles: files,
    requestedSymbols: symbols,
    requestedTests: tests,
    evidenceKinds: [
      "target_file"
    ],
    reason:
      "Required coder evidence is missing.",
    scopeExpansionRequested,
    maxAdditionalTokens
  };
}

function baseInput(
  root,
  contextRequestProvider,
  coderProvider,
  overrides = {}
) {
  return {
    repositoryPath: root,
    baseContext: {
      task:
        "Update configuration behavior.",
      authority: [
        "Only change configuration behavior."
      ],
      policy: [
        "Do not read secrets."
      ]
    },
    initialEvidence: [],
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
    hardTotalBudgetTokens: 7000,
    reservedOutputTokens: 1000,
    maxExpansionAttempts: 2,
    contextRequestProvider,
    coderProvider,
    ...overrides
  };
}

(async () => {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "adaptive-context-"
    )
  );

  fs.mkdirSync(
    path.join(root, "src"),
    { recursive: true }
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/config.ts"
    ),
    "export type UserConfig = { enabled: boolean };\nexport function loadConfig(): UserConfig { return { enabled: true }; }\n"
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/config.test.ts"
    ),
    "import { loadConfig } from \"./config.js\";\nloadConfig();\n"
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/large.ts"
    ),
    `export type UserConfig = {};\n${"x".repeat(9000)}`
  );

  const modulePath =
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/adaptive-context-orchestrator.js`
    );

  const {
    runAdaptiveCoderContextFlow
  } = await import(
    modulePath.href
  );

  await check(
    "sufficient initial context skips expansion",
    async () => {
      let requestCalls = 0;
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () => {
              requestCalls += 1;
              return contextRequest();
            },
            async () => {
              coderCalls += 1;
              return "patch";
            },
            {
              initialEvidence: [
                evidence(
                  "src/config.ts",
                  fs.readFileSync(
                    path.join(
                      root,
                      "src/config.ts"
                    ),
                    "utf8"
                  )
                ),
                evidence(
                  "src/config.test.ts",
                  fs.readFileSync(
                    path.join(
                      root,
                      "src/config.test.ts"
                    ),
                    "utf8"
                  )
                )
              ]
            }
          )
        );

      assert.equal(
        result.route,
        "coder_executed"
      );

      assert.equal(
        result.traces.length,
        0
      );

      assert.equal(
        requestCalls,
        0
      );

      assert.equal(
        coderCalls,
        1
      );
    }
  );

  await check(
    "one expansion resolves source and test context",
    async () => {
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                tests: [
                  "src/config.test.ts"
                ],
                symbols: [
                  "UserConfig"
                ]
              }),
            async (context) => {
              coderCalls += 1;

              assert.equal(
                context.evidence.length,
                2
              );

              return "patch";
            }
          )
        );

      assert.equal(
        result.route,
        "coder_executed"
      );

      assert.equal(
        result.traces.length,
        1
      );

      assert.equal(
        result.summary
          .resolverCallCount,
        1
      );

      assert.equal(
        coderCalls,
        1
      );
    }
  );

  await check(
    "two expansions can complete context incrementally",
    async () => {
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async (state) =>
              state.attempt === 1
                ? contextRequest({
                    files: [
                      "src/config.ts"
                    ],
                    symbols: [
                      "UserConfig"
                    ]
                  })
                : contextRequest({
                    tests: [
                      "src/config.test.ts"
                    ]
                  }),
            async () => {
              coderCalls += 1;
              return "patch";
            }
          )
        );

      assert.equal(
        result.route,
        "coder_executed"
      );

      assert.equal(
        result.traces.length,
        2
      );

      assert.equal(
        result.summary
          .contextRequestProviderCallCount,
        2
      );

      assert.equal(
        coderCalls,
        1
      );
    }
  );

  await check(
    "expansion limit stops unresolved flow",
    async () => {
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                symbols: [
                  "UserConfig"
                ]
              }),
            async () => {
              coderCalls += 1;
              return "patch";
            },
            {
              maxExpansionAttempts: 1
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        coderCalls,
        0
      );

      assert.ok(
        result.issues.some(
          (entry) =>
            entry.code ===
            "adaptive_context_expansion_limit_reached"
        )
      );
    }
  );

  await check(
    "missing authority prevents providers",
    async () => {
      let requestCalls = 0;
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () => {
              requestCalls += 1;
              return contextRequest();
            },
            async () => {
              coderCalls += 1;
              return "patch";
            },
            {
              authorityPresent: false
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        requestCalls,
        0
      );

      assert.equal(
        coderCalls,
        0
      );
    }
  );

  await check(
    "request provider failure fails closed",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () => {
              throw new Error(
                "provider unavailable"
              );
            },
            async () => "patch"
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.issues[0].code,
        "context_request_provider_failed"
      );
    }
  );

  await check(
    "invalid request output fails closed",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () => ({
              requestedFiles: [],
              requestedSymbols: [],
              requestedTests: [],
              evidenceKinds: [],
              reason: "",
              scopeExpansionRequested:
                false,
              maxAdditionalTokens: 0
            }),
            async () => "patch"
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.issues[0].code,
        "context_request_provider_output_invalid"
      );
    }
  );

  await check(
    "symbol only request cannot use resolver",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                symbols: [
                  "UserConfig"
                ]
              }),
            async () => "patch"
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        result.summary
          .resolverCallCount,
        0
      );

      assert.equal(
        result.issues[0].code,
        "context_request_requires_explicit_paths"
      );
    }
  );

  await check(
    "scope expansion without approval is blocked",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                tests: [
                  "src/config.test.ts"
                ],
                symbols: [
                  "UserConfig"
                ],
                scopeExpansionRequested:
                  true
              }),
            async () => "patch",
            {
              allowedContextFiles: [
                "src/other.ts"
              ]
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.issues[0].code,
        "context_scope_expansion_not_approved"
      );
    }
  );

  await check(
    "approved scope expansion executes coder",
    async () => {
      let approvalCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                tests: [
                  "src/config.test.ts"
                ],
                symbols: [
                  "UserConfig"
                ],
                scopeExpansionRequested:
                  true
              }),
            async () => "patch",
            {
              allowedContextFiles: [
                "src/other.ts"
              ],
              scopeExpansionApprovalProvider:
                async () => {
                  approvalCalls += 1;
                  return true;
                }
            }
          )
        );

      assert.equal(
        result.route,
        "coder_executed"
      );

      assert.equal(
        approvalCalls,
        1
      );
    }
  );

  await check(
    "repeated file across attempts is blocked",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                symbols: [
                  "UserConfig"
                ]
              }),
            async () => "patch"
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.traces.length,
        2
      );

      assert.equal(
        result.issues[0].code,
        "context_request_repeated"
      );
    }
  );

  await check(
    "hard total budget blocks coder",
    async () => {
      let coderCalls = 0;

      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/large.ts"
                ],
                tests: [
                  "src/config.test.ts"
                ],
                symbols: [
                  "UserConfig"
                ],
                maxAdditionalTokens:
                  5000
              }),
            async () => {
              coderCalls += 1;
              return "patch";
            },
            {
              requiredSourceFiles: [
                "src/large.ts"
              ],
              hardTotalBudgetTokens:
                1400,
              reservedOutputTokens:
                500,
              allowedContextFiles: [
                "src/large.ts",
                "src/config.test.ts"
              ]
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        coderCalls,
        0
      );

      assert.ok(
        result.issues.some(
          (entry) =>
            entry.code ===
            "coder_context_hard_budget_exceeded"
        )
      );
    }
  );

  await check(
    "coder provider failure remains human review",
    async () => {
      const result =
        await runAdaptiveCoderContextFlow(
          baseInput(
            root,
            async () =>
              contextRequest({
                files: [
                  "src/config.ts"
                ],
                tests: [
                  "src/config.test.ts"
                ],
                symbols: [
                  "UserConfig"
                ]
              }),
            async () => {
              throw new Error(
                "coder unavailable"
              );
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.summary
          .coderProviderCallCount,
        1
      );

      assert.equal(
        result.issues[0].code,
        "coder_provider_failed"
      );
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
    "adaptive context orchestrator smoke passed (13 checks)"
  );
})().catch((error) => {
  console.error(
    error.stack || error
  );

  process.exitCode = 1;
});
