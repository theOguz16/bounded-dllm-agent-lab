const assert =
  require("node:assert/strict");

const { createHash } =
  require("node:crypto");

const { pathToFileURL } =
  require("node:url");

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

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize(value[key])
        ])
    );
  }

  return value;
}

function hashCanonical(value) {
  return hashText(
    JSON.stringify(
      canonicalize(value)
    )
  );
}

function evidence(
  path,
  content,
  source = "fixture"
) {
  const bytes =
    Buffer.from(content, "utf8");

  return {
    path,
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

function readyExpansion(
  entries,
  overrides = {}
) {
  const core = {
    version: "1",
    expansionAttempt: 1,
    requestHash:
      hashText("request"),
    repositoryIdentityHash:
      hashText("repo"),
    budgetTokens: 2000,
    estimatedTokens: 200,
    entries,
    missingFiles: [],
    unresolvedSymbols: [],
    ...overrides
  };

  const packet = {
    ...core,
    packetHash:
      hashCanonical(core)
  };

  return {
    decision:
      "context_expansion_ready",
    issues: [],
    packet,
    summary: {
      requestedPathCount:
        entries.length,
      loadedFileCount:
        entries.length,
      missingFileCount:
        packet.missingFiles.length,
      unresolvedSymbolCount:
        packet
          .unresolvedSymbols.length,
      totalBytesRead:
        entries.reduce(
          (total, entry) =>
            total +
            entry.byteLength,
          0
        ),
      estimatedTokens:
        packet.estimatedTokens,
      budgetTokens:
        packet.budgetTokens,
      expansionAttempt: 1,
      repositoryWritePerformed:
        false
    }
  };
}

function baseInput(
  provider,
  overrides = {}
) {
  return {
    baseContext: {
      task:
        "Update config loader.",
      authority: [
        "Only modify config behavior."
      ],
      policy: [
        "Do not touch secrets."
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
    hardTotalBudgetTokens:
      6000,
    reservedOutputTokens:
      1000,
    provider,
    ...overrides
  };
}

(async () => {
  const modulePath =
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/coder-context-execution-gate.js`
    );

  const {
    executeCoderWithContextGate
  } = await import(
    modulePath.href
  );

  await check(
    "initial source context reaches provider",
    async () => {
      let calls = 0;

      const source = evidence(
        "src/config.ts",
        "export type UserConfig = { enabled: boolean };\n"
      );

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async (context) => {
              calls += 1;

              assert.ok(
                context.evidence.some(
                  (entry) =>
                    entry.path ===
                    "src/config.ts"
                )
              );

              assert.ok(
                context.evidence.some(
                  (entry) =>
                    entry.content.includes(
                      "UserConfig"
                    )
                )
              );

              return {
                patch: "ok"
              };
            },
            {
              initialEvidence: [
                source,
                evidence(
                  "src/config.test.ts",
                  "loadConfig();\n"
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
        result.providerCalled,
        true
      );

      assert.equal(calls, 1);
    }
  );

  await check(
    "resolved expansion completes missing source context",
    async () => {
      let calls = 0;

      const expansionEntry =
        evidence(
          "src/config.ts",
          "export type UserConfig = { enabled: boolean };\n",
          "requested_file"
        );

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async (context) => {
              calls += 1;

              assert.equal(
                context.evidence.find(
                  (entry) =>
                    entry.path ===
                    "src/config.ts"
                ).origin,
                "context_expansion"
              );

              return "patch";
            },
            {
              expansionResolution:
                readyExpansion([
                  expansionEntry
                ])
            }
          )
        );

      assert.equal(
        result.route,
        "coder_executed"
      );

      assert.equal(calls, 1);
    }
  );

  await check(
    "missing source blocks provider",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(async () => {
            calls += 1;
            return "patch";
          })
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        result.providerCalled,
        false
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "required_source_context_missing"
      );
    }
  );

  await check(
    "missing required test blocks provider",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              initialEvidence: [
                evidence(
                  "src/config.ts",
                  "export type UserConfig = {};\n"
                )
              ]
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "required_test_context_missing"
      );
    }
  );

  await check(
    "missing symbol blocks provider",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              initialEvidence: [
                evidence(
                  "src/config.ts",
                  "export const value = 1;\n"
                ),
                evidence(
                  "src/config.test.ts",
                  "value;\n"
                )
              ]
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "required_symbol_context_missing"
      );
    }
  );

  await check(
    "missing authority routes to human review",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              authorityPresent:
                false
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "context_authority_missing"
      );
    }
  );

  await check(
    "missing policy routes to human review",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              policyPresent:
                false
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "context_policy_missing"
      );
    }
  );

  await check(
    "incomplete expansion routes to replan",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              expansionResolution: {
                decision:
                  "context_expansion_incomplete",
                issues: [],
                packet: null,
                summary: {
                  requestedPathCount:
                    1,
                  loadedFileCount:
                    0,
                  missingFileCount:
                    1,
                  unresolvedSymbolCount:
                    0,
                  totalBytesRead:
                    0,
                  estimatedTokens:
                    0,
                  budgetTokens:
                    1000,
                  expansionAttempt:
                    1,
                  repositoryWritePerformed:
                    false
                }
              }
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(calls, 0);
    }
  );

  await check(
    "blocked expansion routes to human review",
    async () => {
      let calls = 0;

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              expansionResolution: {
                decision:
                  "context_expansion_blocked",
                issues: [],
                packet: null,
                summary: {
                  requestedPathCount:
                    1,
                  loadedFileCount:
                    0,
                  missingFileCount:
                    0,
                  unresolvedSymbolCount:
                    0,
                  totalBytesRead:
                    0,
                  estimatedTokens:
                    0,
                  budgetTokens:
                    1000,
                  expansionAttempt:
                    1,
                  repositoryWritePerformed:
                    false
                }
              }
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);
    }
  );

  await check(
    "hard budget blocks provider call",
    async () => {
      let calls = 0;

      const source = evidence(
        "src/config.ts",
        `export type UserConfig = {};\n${"x".repeat(12000)}`
      );

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              initialEvidence: [
                source,
                evidence(
                  "src/config.test.ts",
                  "UserConfig;\n"
                )
              ],
              hardTotalBudgetTokens:
                1200,
              reservedOutputTokens:
                800
            }
          )
        );

      assert.equal(
        result.route,
        "replan_required"
      );

      assert.equal(
        result.providerCalled,
        false
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "coder_context_hard_budget_exceeded"
      );
    }
  );

  await check(
    "tampered expansion packet is rejected",
    async () => {
      let calls = 0;

      const expansion =
        readyExpansion([
          evidence(
            "src/config.ts",
            "export type UserConfig = {};\n",
            "requested_file"
          )
        ]);

      expansion.packet
        .entries[0]
        .content = "tampered";

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              calls += 1;
              return "patch";
            },
            {
              expansionResolution:
                expansion
            }
          )
        );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(calls, 0);

      assert.equal(
        result.issues[0].code,
        "context_expansion_packet_tampered"
      );
    }
  );

  await check(
    "provider failure fails closed",
    async () => {
      const source = evidence(
        "src/config.ts",
        "export type UserConfig = {};\n"
      );

      const result =
        await executeCoderWithContextGate(
          baseInput(
            async () => {
              throw new Error(
                "provider unavailable"
              );
            },
            {
              initialEvidence: [
                source,
                evidence(
                  "src/config.test.ts",
                  "UserConfig;\n"
                )
              ]
            }
          )
        );

      assert.equal(
        result.decision,
        "coder_provider_failed"
      );

      assert.equal(
        result.route,
        "human_review_required"
      );

      assert.equal(
        result.providerCalled,
        true
      );

      assert.equal(
        result.summary
          .providerCallCount,
        1
      );
    }
  );

  console.log(
    "coder context execution gate smoke passed (12 checks)"
  );
})().catch((error) => {
  console.error(
    error.stack || error
  );

  process.exitCode = 1;
});
