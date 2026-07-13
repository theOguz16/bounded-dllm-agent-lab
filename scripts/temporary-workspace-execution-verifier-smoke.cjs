const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "temp-execution-verifier-smoke-"));
}

function removeIfExists(targetPath) {
  if (targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function command(overrides = {}) {
  return {
    id: "node-check",
    executable: "node",
    args: ["-e", "process.exit(0)"],
    ...overrides
  };
}

function context(overrides = {}) {
  const workspace = overrides.tempWorkspacePath ?? tempWorkspace();

  return {
    tempWorkspacePath: workspace,
    tempApplyDecision: "temp_apply_ready",
    tempWorkspaceCleanedUp: false,
    commands: [command()],
    allowedExecutables: ["node"],
    ...overrides
  };
}

function assertDecision(result, decision, code) {
  assert.equal(result.decision, decision);

  if (code) {
    assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result.issues));
  }
}

function withWorkspace(fn) {
  const workspace = tempWorkspace();

  try {
    fn(workspace);
  } finally {
    removeIfExists(workspace);
  }
}

(async () => {
  const verifierPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/temporary-workspace-execution-verifier.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const { verifyTemporaryWorkspaceExecution } = await import(verifierPath.href);
  const runtime = await import(indexPath.href);

  check("valid node validation command returns temp_validation_passed", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(context({ tempWorkspacePath: workspace })),
        "temp_validation_passed"
      );
    });
  });

  check("multiple passing commands return passed", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [
            command({ id: "one" }),
            command({ id: "two", args: ["-e", "console.log('two')"] })
          ]
        })
      );

      assertDecision(result, "temp_validation_passed");
      assert.equal(result.summary.totalCommands, 2);
      assert.equal(result.summary.passedCommands, 2);
    });
  });

  check("non-zero exit returns temp_validation_failed", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ args: ["-e", "process.exit(2)"] })]
          })
        ),
        "temp_validation_failed",
        "validation_command_failed"
      );
    });
  });

  check("expected non-zero exit code can pass", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ args: ["-e", "process.exit(2)"], expectedExitCodes: [2] })]
          })
        ),
        "temp_validation_passed"
      );
    });
  });

  check("timeout returns temp_validation_failed", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [
              command({
                args: ["-e", "setTimeout(() => {}, 1000)"],
                timeoutMs: 20
              })
            ]
          })
        ),
        "temp_validation_failed",
        "validation_command_timeout"
      );
    });
  });

  check("missing temp workspace needs_review", () => {
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}`);

    assertDecision(
      verifyTemporaryWorkspaceExecution(context({ tempWorkspacePath: missing })),
      "temp_validation_needs_review",
      "temp_workspace_missing"
    );
  });

  check("non-directory temp workspace needs_review", () => {
    const target = path.join(os.tmpdir(), `temp-execution-file-${Date.now()}`);
    fs.writeFileSync(target, "not a directory\n");

    try {
      assertDecision(
        verifyTemporaryWorkspaceExecution(context({ tempWorkspacePath: target })),
        "temp_validation_needs_review",
        "temp_workspace_not_directory"
      );
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  check("workspace outside temp root needs_review", () => {
    assertDecision(
      verifyTemporaryWorkspaceExecution(context({ tempWorkspacePath: process.cwd() })),
      "temp_validation_needs_review",
      "workspace_outside_temp_root"
    );
  });

  check("temp apply not ready needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({ tempWorkspacePath: workspace, tempApplyDecision: "temp_apply_needs_review" })
        ),
        "temp_validation_needs_review",
        "temp_apply_not_ready"
      );
    });
  });

  check("already cleaned workspace needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({ tempWorkspacePath: workspace, tempWorkspaceCleanedUp: true })
        ),
        "temp_validation_needs_review",
        "temp_workspace_already_cleaned"
      );
    });
  });

  check("no commands needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(context({ tempWorkspacePath: workspace, commands: [] })),
        "temp_validation_needs_review",
        "no_validation_commands"
      );
    });
  });

  check("too many commands needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [
              command({ id: "one" }),
              command({ id: "two" }),
              command({ id: "three" })
            ],
            maxCommands: 2
          })
        ),
        "temp_validation_needs_review",
        "too_many_validation_commands"
      );
    });
  });

  check("unsafe executable absolute path needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ executable: process.execPath })],
            allowedExecutables: [process.execPath]
          })
        ),
        "temp_validation_needs_review",
        "unsafe_executable"
      );
    });
  });

  check("unsafe executable with slash needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ executable: "bin/node" })],
            allowedExecutables: ["bin/node"]
          })
        ),
        "temp_validation_needs_review",
        "unsafe_executable"
      );
    });
  });

  check("executable not allowlisted needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ executable: "npm" })],
            allowedExecutables: ["node"]
          })
        ),
        "temp_validation_needs_review",
        "executable_not_allowed"
      );
    });
  });

  check("invalid args needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ args: "not-array" })]
          })
        ),
        "temp_validation_needs_review",
        "invalid_command_args"
      );
    });
  });

  check("null-byte argument needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ args: ["-e", "console.log('x')", "bad\0arg"] })]
          })
        ),
        "temp_validation_needs_review",
        "unsafe_command_argument"
      );
    });
  });

  check("invalid timeout needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ timeoutMs: 0 })]
          })
        ),
        "temp_validation_needs_review",
        "invalid_command_timeout"
      );
    });
  });

  check("timeout above maximum needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ timeoutMs: 200 })],
            maxTimeoutMs: 100
          })
        ),
        "temp_validation_needs_review",
        "invalid_command_timeout"
      );
    });
  });

  check("invalid expectedExitCodes needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [command({ expectedExitCodes: [] })]
          })
        ),
        "temp_validation_needs_review",
        "invalid_expected_exit_codes"
      );
    });
  });

  check("unsafe environment key needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            environment: { API_KEY: "nope" }
          })
        ),
        "temp_validation_needs_review",
        "unsafe_environment_key"
      );
    });
  });

  check("invalid environment value needs_review", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            environment: { SAFE_VALUE: 42 }
          })
        ),
        "temp_validation_needs_review",
        "invalid_environment_value"
      );
    });
  });

  check("stdout is captured", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [command({ args: ["-e", "process.stdout.write('hello stdout')"] })]
        })
      );

      assertDecision(result, "temp_validation_passed");
      assert.equal(result.commandResults[0].stdout, "hello stdout");
    });
  });

  check("stderr is captured", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [command({ args: ["-e", "process.stderr.write('hello stderr')"] })]
        })
      );

      assertDecision(result, "temp_validation_passed");
      assert.equal(result.commandResults[0].stderr, "hello stderr");
    });
  });

  check("stdout truncation is reported", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [command({ args: ["-e", "process.stdout.write('abcdef')"] })],
          maxOutputChars: 3
        })
      );

      assertDecision(result, "temp_validation_needs_review", "validation_output_truncated");
      assert.equal(result.commandResults[0].stdout, "abc");
      assert.equal(result.commandResults[0].stdoutTruncated, true);
    });
  });

  check("stderr truncation is reported", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [command({ args: ["-e", "process.stderr.write('abcdef')"] })],
          maxOutputChars: 3
        })
      );

      assertDecision(result, "temp_validation_needs_review", "validation_output_truncated");
      assert.equal(result.commandResults[0].stderr, "abc");
      assert.equal(result.commandResults[0].stderrTruncated, true);
    });
  });

  check("command cwd is temporary workspace", () => {
    withWorkspace((workspace) => {
      const result = verifyTemporaryWorkspaceExecution(
        context({
          tempWorkspacePath: workspace,
          commands: [command({ args: ["-e", "process.stdout.write(process.cwd())"] })]
        })
      );

      assertDecision(result, "temp_validation_passed");
      assert.equal(result.commandResults[0].stdout, fs.realpathSync(workspace));
    });
  });

  check("command cannot write to real repo fixture", () => {
    withWorkspace((workspace) => {
      const fixtureName = `temp-execution-real-repo-fixture-${Date.now()}.txt`;
      const repoFixture = path.join(process.cwd(), fixtureName);
      const tempFixture = path.join(workspace, fixtureName);

      try {
        const result = verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [
              command({
                args: [
                  "-e",
                  `require('node:fs').writeFileSync(${JSON.stringify(fixtureName)}, 'temp only')`
                ]
              })
            ]
          })
        );

        assertDecision(result, "temp_validation_passed");
        assert.equal(fs.existsSync(tempFixture), true);
        assert.equal(fs.existsSync(repoFixture), false);
      } finally {
        fs.rmSync(repoFixture, { force: true });
        fs.rmSync(tempFixture, { force: true });
      }
    });
  });

  check("process launch failure returns temp_validation_failed", () => {
    withWorkspace((workspace) => {
      assertDecision(
        verifyTemporaryWorkspaceExecution(
          context({
            tempWorkspacePath: workspace,
            commands: [
              command({
                id: "missing-executable",
                executable: "definitely-not-a-real-node-executable",
                args: []
              })
            ],
            allowedExecutables: ["definitely-not-a-real-node-executable"]
          })
        ),
        "temp_validation_failed",
        "validation_command_launch_failed"
      );
    });
  });

  check("context is not mutated", () => {
    withWorkspace((workspace) => {
      const original = context({
        tempWorkspacePath: workspace,
        commands: [command({ args: ["-e", "process.exit(0)"] })],
        environment: { SAFE_VALUE: "ok" }
      });
      const before = JSON.stringify(original);

      verifyTemporaryWorkspaceExecution(original);

      assert.equal(JSON.stringify(original), before);
    });
  });

  check("runtime index exports temporary workspace execution verifier", () => {
    assert.equal(typeof runtime.verifyTemporaryWorkspaceExecution, "function");
  });

  console.log("temporary workspace execution verifier smoke passed");
})();
