const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

function request(overrides = {}) {
  return {
    requestedFiles: [
      "src/config.ts"
    ],
    requestedSymbols: [
      "UserConfig"
    ],
    requestedTests: [
      "src/config.test.ts"
    ],
    evidenceKinds: [
      "target_file",
      "required_test"
    ],
    reason:
      "Need source and test evidence.",
    scopeExpansionRequested: false,
    maxAdditionalTokens: 2000,
    ...overrides
  };
}

(async () => {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "context-expansion-"
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
    "import { loadConfig } from \"./config.js\";\nif (!loadConfig().enabled) throw new Error(\"disabled\");\n"
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/large.ts"
    ),
    "x".repeat(6000)
  );

  fs.writeFileSync(
    path.join(
      root,
      "src/binary.bin"
    ),
    Buffer.from([0, 1, 2, 3])
  );

  fs.symlinkSync(
    "config.ts",
    path.join(
      root,
      "src/link.ts"
    )
  );

  const modulePath =
    pathToFileURL(
      `${process.cwd()}/dist/packages/product-runtime/src/context-expansion-resolver.js`
    );

  const {
    resolveContextExpansion
  } = await import(
    modulePath.href
  );

  const allowed = [
    "src/config.ts",
    "src/config.test.ts"
  ];

  await check(
    "valid request creates bounded packet with hashes",
    async () => {
      const beforeSource =
        fs.readFileSync(
          path.join(
            root,
            "src/config.ts"
          ),
          "utf8"
        );

      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request(),
          expansionAttempt: 1,
          allowedContextFiles:
            allowed,
          hardBudgetTokens: 2000
        });

      assert.equal(
        result.decision,
        "context_expansion_ready"
      );

      assert.equal(
        result.packet.entries.length,
        2
      );

      assert.match(
        result.packet.packetHash,
        /^sha256:[0-9a-f]{64}$/
      );

      assert.equal(
        result.packet
          .unresolvedSymbols.length,
        0
      );

      assert.equal(
        result.summary
          .repositoryWritePerformed,
        false
      );

      assert.equal(
        fs.readFileSync(
          path.join(
            root,
            "src/config.ts"
          ),
          "utf8"
        ),
        beforeSource
      );
    }
  );

  await check(
    "missing file returns incomplete packet",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            requestedFiles: [
              "src/missing.ts"
            ],
            requestedSymbols: []
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/missing.ts",
            "src/config.test.ts"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_incomplete"
      );

      assert.deepEqual(
        result.packet.missingFiles,
        ["src/missing.ts"]
      );
    }
  );

  await check(
    "forbidden context is blocked",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request(),
          expansionAttempt: 1,
          forbiddenFiles: [
            "src/config.ts"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.packet,
        null
      );

      assert.equal(
        result.issues[0].code,
        "context_file_forbidden"
      );
    }
  );

  await check(
    "scope expansion requires separate approval",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            scopeExpansionRequested:
              true
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/other.ts"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.issues[0].code,
        "context_scope_expansion_not_approved"
      );
    }
  );

  await check(
    "approved scope expansion can load requested files",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            scopeExpansionRequested:
              true
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/other.ts"
          ],
          scopeExpansionApproved: true
        });

      assert.equal(
        result.decision,
        "context_expansion_ready"
      );
    }
  );

  await check(
    "symlink context is rejected",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            requestedFiles: [
              "src/link.ts"
            ],
            requestedSymbols: [],
            requestedTests: []
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/link.ts"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.issues[0].code,
        "context_symlink_rejected"
      );
    }
  );

  await check(
    "repeated request across attempts is blocked",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request(),
          expansionAttempt: 2,
          allowedContextFiles:
            allowed,
          previouslyRequestedFiles: [
            "src/config.ts"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.issues[0].code,
        "context_request_repeated"
      );
    }
  );

  await check(
    "hard token budget blocks oversized packet",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            requestedFiles: [
              "src/large.ts"
            ],
            requestedSymbols: [],
            requestedTests: [],
            maxAdditionalTokens: 50
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/large.ts"
          ],
          hardBudgetTokens: 50
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.issues[0].code,
        "context_expansion_budget_exceeded"
      );
    }
  );

  await check(
    "binary file is rejected",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request({
            requestedFiles: [
              "src/binary.bin"
            ],
            requestedSymbols: [],
            requestedTests: []
          }),
          expansionAttempt: 1,
          allowedContextFiles: [
            "src/binary.bin"
          ]
        });

      assert.equal(
        result.decision,
        "context_expansion_blocked"
      );

      assert.equal(
        result.issues[0].code,
        "context_binary_file_rejected"
      );
    }
  );

  await check(
    "third expansion attempt is invalid",
    async () => {
      const result =
        await resolveContextExpansion({
          repositoryPath: root,
          request: request(),
          expansionAttempt: 3,
          allowedContextFiles:
            allowed
        });

      assert.equal(
        result.decision,
        "context_expansion_invalid"
      );

      assert.equal(
        result.issues[0].code,
        "context_expansion_attempt_invalid"
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
    "context expansion resolver smoke passed (10 checks)"
  );
})().catch((error) => {
  console.error(
    error.stack || error
  );

  process.exitCode = 1;
});
