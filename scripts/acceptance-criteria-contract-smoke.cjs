const assert = require("node:assert/strict");
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

(async () => {
  const runtime = await import(
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/index.js`
    ).href
  );

  const {
    buildTemporaryWorkspaceExecutionVerificationEvidence,
    createAcceptanceCriteriaContract,
    createHumanReviewAcceptanceEvidence,
    evaluateAcceptanceCriteria,
    hashCanonicalJson,
    verifyAcceptanceCriteriaCoverageReceipt
  } = runtime;

  const specification = {
    commands: [
      {
        id: "unit-tests",
        executable: "node",
        args: ["scripts/unit.cjs"]
      },
      {
        id: "static-check",
        executable: "node",
        args: ["scripts/static.cjs"]
      }
    ],
    allowedExecutables: ["node"]
  };

  function executionEvidence(
    passes,
    decision = null,
    cleanupSucceeded = true
  ) {
    const commandResults =
      specification.commands.map(
        (command, index) => ({
          id: command.id,
          executable:
            command.executable,
          args: [...command.args],
          startedAt:
            "2026-07-22T12:00:00.000Z",
          finishedAt:
            "2026-07-22T12:00:00.010Z",
          durationMs: 10,
          exitCode:
            passes[index] ? 0 : 1,
          signal: null,
          timedOut: false,
          stdout:
            passes[index]
              ? "passed\n"
              : "",
          stderr:
            passes[index]
              ? ""
              : "failed\n",
          stdoutTruncated: false,
          stderrTruncated: false,
          passed: passes[index]
        })
      );

    const passedCommands =
      commandResults.filter(
        (entry) => entry.passed
      ).length;

    const selectedDecision =
      decision ??
      (passedCommands ===
      commandResults.length
        ? "temp_validation_passed"
        : "temp_validation_failed");

    const result = {
      decision: selectedDecision,
      issues:
        selectedDecision ===
        "temp_validation_needs_review"
          ? [
              {
                code:
                  "fixture_review_required",
                message:
                  "Fixture requires review.",
                severity: "review"
              }
            ]
          : [],
      commandResults,
      summary: {
        totalCommands:
          commandResults.length,
        passedCommands,
        failedCommands:
          commandResults.length -
          passedCommands,
        timedOutCommands: 0,
        truncatedOutputs: 0,
        durationMs: 20
      }
    };

    return buildTemporaryWorkspaceExecutionVerificationEvidence(
      specification,
      result,
      cleanupSucceeded
    );
  }

  function contract(
    criteria = [
      {
        id: "unit-tests-pass",
        description:
          "Required unit tests pass.",
        required: true,
        evidence: {
          kind: "test",
          commandId: "unit-tests"
        }
      },
      {
        id: "static-check-pass",
        description:
          "Required static checks pass.",
        required: true,
        evidence: {
          kind: "static_check",
          commandId: "static-check"
        }
      },
      {
        id: "behavior-reviewed",
        description:
          "User-visible behavior receives explicit review.",
        required: true,
        evidence: {
          kind: "human_review",
          reviewKey:
            "behavior-review"
        }
      }
    ]
  ) {
    return createAcceptanceCriteriaContract({
      taskId: "ac-fixture-task",
      objectiveHash:
        hashCanonicalJson({
          objective:
            "Validate acceptance criteria."
        }),
      criteria
    });
  }

  function approvedReview(
    overrides = {}
  ) {
    return createHumanReviewAcceptanceEvidence({
      reviewKey: "behavior-review",
      criterionId:
        "behavior-reviewed",
      reviewerIdentityHash:
        hashCanonicalJson({
          reviewer: "fixture"
        }),
      decision: "approved",
      reviewedAt:
        "2026-07-22T12:00:00Z",
      rationaleHash:
        hashCanonicalJson({
          rationale:
            "Behavior matches contract."
        }),
      ...overrides
    });
  }

  await check(
    "all mapped evidence produces contract approved",
    async () => {
      const value = contract();
      const evidence =
        executionEvidence([
          true,
          true
        ]);

      const result =
        evaluateAcceptanceCriteria({
          contract: value,
          executionSpecification:
            specification,
          executionEvidence:
            evidence,
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_approved"
      );

      assert.equal(
        result.summary
          .coverageComplete,
        true
      );

      assert.equal(
        result.receipt
          .approvedCriterionCount,
        3
      );

      const verification =
        verifyAcceptanceCriteriaCoverageReceipt(
          result.receipt,
          value,
          evidence
        );

      assert.equal(
        verification.decision,
        "acceptance_coverage_current"
      );

      assert.equal(
        verification
          .downstreamEligible,
        true
      );
    }
  );

  await check(
    "failed test produces contract failed",
    async () => {
      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              false,
              true
            ]),
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_failed"
      );

      assert.equal(
        result.summary
          .failedCriterionCount,
        1
      );
    }
  );

  await check(
    "missing human review produces needs review",
    async () => {
      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              true,
              true
            ])
        });

      assert.equal(
        result.decision,
        "contract_needs_review"
      );

      assert.equal(
        result.summary
          .coverageComplete,
        false
      );
    }
  );

  await check(
    "rejected human review produces contract failed",
    async () => {
      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              true,
              true
            ]),
          humanReviewEvidence: [
            approvedReview({
              decision: "rejected"
            })
          ]
        });

      assert.equal(
        result.decision,
        "contract_failed"
      );
    }
  );

  await check(
    "missing command mapping is invalid",
    async () => {
      const value = contract([
        {
          id: "missing-command",
          description:
            "A missing command cannot satisfy a criterion.",
          required: true,
          evidence: {
            kind: "test",
            commandId:
              "does-not-exist"
          }
        }
      ]);

      const result =
        evaluateAcceptanceCriteria({
          contract: value,
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              true,
              true
            ])
        });

      assert.equal(
        result.decision,
        "contract_invalid"
      );
    }
  );

  await check(
    "tampered contract is invalid",
    async () => {
      const value = contract();
      const tampered = {
        ...value,
        taskId:
          "tampered-task"
      };

      const result =
        evaluateAcceptanceCriteria({
          contract: tampered,
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              true,
              true
            ]),
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_invalid"
      );
    }
  );

  await check(
    "tampered execution evidence is invalid",
    async () => {
      const original =
        executionEvidence([
          true,
          true
        ]);

      const tampered = {
        ...original,
        steps: [
          {
            ...original.steps[0],
            passed: false
          },
          original.steps[1]
        ]
      };

      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            tampered,
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_invalid"
      );
    }
  );

  await check(
    "duplicate criterion ids are rejected",
    async () => {
      assert.throws(() =>
        contract([
          {
            id: "duplicate",
            description:
              "First criterion.",
            required: true,
            evidence: {
              kind: "test",
              commandId:
                "unit-tests"
            }
          },
          {
            id: "duplicate",
            description:
              "Second criterion.",
            required: true,
            evidence: {
              kind:
                "static_check",
              commandId:
                "static-check"
            }
          }
        ])
      );
    }
  );

  await check(
    "optional criteria are rejected in version one",
    async () => {
      assert.throws(() =>
        contract([
          {
            id: "optional",
            description:
              "Optional criteria are not supported.",
            required: false,
            evidence: {
              kind: "test",
              commandId:
                "unit-tests"
            }
          }
        ])
      );
    }
  );

  await check(
    "human review must match criterion id",
    async () => {
      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence([
              true,
              true
            ]),
          humanReviewEvidence: [
            approvedReview({
              criterionId:
                "unit-tests-pass"
            })
          ]
        });

      assert.equal(
        result.decision,
        "contract_invalid"
      );
    }
  );

  await check(
    "tampered coverage receipt is not downstream eligible",
    async () => {
      const value = contract();
      const evidence =
        executionEvidence([
          true,
          true
        ]);

      const evaluated =
        evaluateAcceptanceCriteria({
          contract: value,
          executionSpecification:
            specification,
          executionEvidence:
            evidence,
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      const tampered = {
        ...evaluated.receipt,
        approvedCriterionCount: 2
      };

      const verification =
        verifyAcceptanceCriteriaCoverageReceipt(
          tampered,
          value,
          evidence
        );

      assert.equal(
        verification.decision,
        "acceptance_coverage_invalid"
      );

      assert.equal(
        verification
          .downstreamEligible,
        false
      );
    }
  );

  await check(
    "duplicate command ids make coverage invalid",
    async () => {
      const duplicateSpecification = {
        ...specification,
        commands: [
          specification.commands[0],
          {
            ...specification.commands[1],
            id: "unit-tests"
          }
        ]
      };

      const duplicateEvidence =
        buildTemporaryWorkspaceExecutionVerificationEvidence(
          duplicateSpecification,
          {
            decision:
              "temp_validation_passed",
            issues: [],
            commandResults:
              duplicateSpecification.commands.map(
                (command) => ({
                  id: command.id,
                  executable:
                    command.executable,
                  args: [...command.args],
                  startedAt:
                    "2026-07-22T12:00:00.000Z",
                  finishedAt:
                    "2026-07-22T12:00:00.010Z",
                  durationMs: 10,
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  stdout: "passed\n",
                  stderr: "",
                  stdoutTruncated:
                    false,
                  stderrTruncated:
                    false,
                  passed: true
                })
              ),
            summary: {
              totalCommands: 2,
              passedCommands: 2,
              failedCommands: 0,
              timedOutCommands: 0,
              truncatedOutputs: 0,
              durationMs: 20
            }
          },
          true
        );

      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            duplicateSpecification,
          executionEvidence:
            duplicateEvidence,
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_invalid"
      );
    }
  );

  await check(
    "execution needs review cannot be contract approved",
    async () => {
      const result =
        evaluateAcceptanceCriteria({
          contract: contract(),
          executionSpecification:
            specification,
          executionEvidence:
            executionEvidence(
              [true, true],
              "temp_validation_needs_review"
            ),
          humanReviewEvidence: [
            approvedReview()
          ]
        });

      assert.equal(
        result.decision,
        "contract_needs_review"
      );
    }
  );

  console.log(
    "acceptance criteria contract smoke passed (13 checks)"
  );
})().catch((error) => {
  console.error(
    error.stack || error
  );
  process.exitCode = 1;
});
