#!/usr/bin/env node
"use strict";

// Deterministic offline proof that the durable invocation journal can never be
// placed inside the source repository, and that repository currentness is
// unaffected by journal writes living outside it. Uses an injected fake SDK
// client only; zero real provider calls.

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, statSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");

const repoRoot = resolve(__dirname, "../..");

const FAKE_EVENTS = [
  { type: "thread.started", thread_id: "thread-location-smoke" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "msg-1", type: "agent_message", text: "Done." }
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 }
  }
];

function makeAdapter(CodexAgentAdapter, options) {
  const calls = { provider: 0 };
  const adapter = new CodexAgentAdapter({
    environment: { HOME: options.temp, PATH: process.env.PATH },
    authCheck: async () => true,
    clientFactory: () => {
      calls.provider += 1;
      return {
        startThread() {
          return {
            async runStreamed() {
              return {
                events: (async function* () {
                  for (const event of FAKE_EVENTS) yield event;
                })()
              };
            }
          };
        }
      };
    },
    invocationJournalPath: options.invocationJournalPath
  });
  return { adapter, calls };
}

function makeRequest(overrides = {}) {
  return {
    runId: "location.smoke.run",
    agentId: "codex",
    workingDirectory: null,
    task: "offline journal location probe",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    mode: "discovery",
    timeoutMs: 10_000,
    networkAllowed: false,
    sandboxMode: "read_only",
    repositoryRequirement: "none",
    ...overrides
  };
}

function journalRowCount(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS c FROM provider_invocations").get().c;
  } finally { db.close(); }
}

async function main() {
  const journalModule = await import(pathToFileURL(join(repoRoot,
    "dist/packages/integrations/src/invocation-journal-location.js")).href);
  const snapshotModule = await import(pathToFileURL(join(repoRoot,
    "dist/packages/product-runtime/src/canonical-policy-compiler.js")).href);
  const adapterModule = await import(pathToFileURL(join(repoRoot,
    "dist/packages/integrations/src/codex-agent-adapter.js")).href);
  const { CodexAgentAdapter } = adapterModule;
  const {
    INVOCATION_JOURNAL_LOCATION_POLICY_VERSION,
    resolveInvocationJournalLocation
  } = journalModule;

  assert.equal(INVOCATION_JOURNAL_LOCATION_POLICY_VERSION, "invocation-journal-location/v1");

  const temp = mkdtempSync(join(tmpdir(), "journal-location-smoke-"));
  try {
    // Fake source repository with tracked source; fake disposable workspace
    // outside it (the discovery execution shape that caused the incident).
    const repositoryRoot = join(temp, "source-repo");
    const workspaceRoot = join(temp, "disposable-workspace");
    const outside = join(temp, "external-state");
    for (const dir of [repositoryRoot, workspaceRoot, outside]) mkdirSync(dir, { recursive: true });
    mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
    mkdirSync(join(repositoryRoot, "src"), { recursive: true });
    writeFileSync(join(repositoryRoot, "src", "app.ts"), "export const app = 1;\n");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    mkdirSync(join(repositoryRoot, ".r06-dogfood"), { recursive: true });

    const rejectionRequest = (overrides = {}) => makeRequest({
      workingDirectory: workspaceRoot,
      sourceRepositoryPath: repositoryRoot,
      ...overrides
    });

    // ---------- Unit-level policy behavior ----------
    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(repositoryRoot, "provider-invocations.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, true, "direct-inside must assess inside");

    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(repositoryRoot, ".r06-dogfood", "provider-invocations.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, true, "nested-inside must assess inside");

    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(outside, "provider-invocations.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, false, "outside must assess outside");

    // Equivalent normalized paths through a symlinked repository alias.
    symlinkSync(repositoryRoot, join(temp, "repo-alias"), "dir");
    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(temp, "repo-alias", "state.sqlite"),
      sourceRepositoryRoot: join(temp, "repo-alias")
    }).insideSourceRepository, true, "alias-normalized inside must be detected");
    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(temp, "repo-alias", "state.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, true, "alias-expressed inside must be detected");

    // Missing journal file under a symlinked directory resolving into the
    // repository: rejected although the configured path is outside.
    symlinkSync(join(repositoryRoot, ".r06-dogfood"), join(temp, "dogfood-link"), "dir");
    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(temp, "dogfood-link", "provider-invocations.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, true, "symlink resolving inside must be detected");

    // Broken symlink whose missing target would be inside the repository.
    symlinkSync(join(repositoryRoot, "missing-dir"), join(temp, "broken-link"), "dir");
    assert.equal(resolveInvocationJournalLocation({
      journalPath: join(temp, "broken-link", "provider-invocations.sqlite"),
      sourceRepositoryRoot: repositoryRoot
    }).insideSourceRepository, true, "broken link into repository must be detected");

    // Relative journal paths are invalid input and fail closed.
    assert.throws(
      () => resolveInvocationJournalLocation({
        journalPath: "relative/journal.sqlite", sourceRepositoryRoot: repositoryRoot
      }),
      (error) => error.code === "invocation_journal_unavailable"
    );

    // 1. Journal directly inside the repo is rejected before the provider runs.
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: join(repositoryRoot, "provider-invocations.sqlite")
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "rejected");
      assert.equal(result.failureCode, "invocation_journal_inside_source_repository");
      assert.equal(result.invocationOccurred ?? null, null);
      assert.ok(result.diagnostics.some((entry) =>
        entry.code === "invocation_journal_inside_source_repository" && entry.severity === "error"));
      assert.equal(calls.provider, 0, "zero provider calls on rejected direct-inside path");
      assert.equal(existsSync(join(repositoryRoot, "provider-invocations.sqlite")), false,
        "no journal file may be created inside the repository");
    }

    // 2. Nested inside the repo (the incident shape) is rejected.
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: join(repositoryRoot, ".r06-dogfood", "provider-invocations.sqlite")
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "rejected");
      assert.equal(result.failureCode, "invocation_journal_inside_source_repository");
      assert.equal(calls.provider, 0, "zero provider calls on rejected nested path");
      assert.equal(existsSync(join(repositoryRoot, ".r06-dogfood", "provider-invocations.sqlite")), false,
        "no nested journal file may be created inside the repository");
    }

    // 3. Symlink resolving inside the repo is rejected with zero provider calls.
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: join(temp, "dogfood-link", "provider-invocations.sqlite")
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "rejected");
      assert.equal(result.failureCode, "invocation_journal_inside_source_repository");
      assert.equal(calls.provider, 0, "zero provider calls on rejected symlink path");
      assert.equal(existsSync(join(repositoryRoot, ".r06-dogfood", "provider-invocations.sqlite")), false,
        "symlinked journal must not create files inside the repository");
    }

    // 4. Journal outside the repository is accepted and durably records the run.
    const outsideJournal = join(outside, "provider-invocations.sqlite");
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: outsideJournal
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "completed");
      assert.equal(result.invocationOccurred, true);
      assert.equal(result.failureCode ?? null, null);
      assert.equal(calls.provider, 1, "exactly one fake provider call on the accepted path");
      assert.ok(existsSync(outsideJournal), "journal is created outside the repository");
      assert.equal(journalRowCount(outsideJournal), 1, "accepted run is journaled exactly once");
    }

    // 5. Source snapshot remains stable while the outside journal changes.
    {
      const snapshotHash = () =>
        snapshotModule.createCanonicalRepositoryContentSnapshot(repositoryRoot).snapshotHash;
      const before = snapshotHash();
      const rowsBefore = journalRowCount(outsideJournal);
      const { adapter } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: outsideJournal
      });
      const result = await adapter.run(rejectionRequest({
        runId: "location.smoke.second",
        task: "offline journal location probe (second)"
      }));
      assert.equal(result.status, "completed");
      assert.equal(snapshotHash(), before,
        "repository snapshot must not change while the journal grows outside");
      assert.equal(journalRowCount(outsideJournal), rowsBefore + 1,
        "the outside journal actually changed during the run");
    }

    // 6. Incident regression: discovery executes in a disposable workspace;
    //    with the source repository declared explicitly, a journal inside the
    //    SOURCE repository is still rejected even though the working directory
    //    is outside it.
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: join(repositoryRoot, ".r06-dogfood", "provider-invocations.sqlite")
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "rejected");
      assert.equal(result.failureCode, "invocation_journal_inside_source_repository");
      assert.equal(calls.provider, 0);
    }

    // 7. Without a declared source repository, derivation from the working
    //    directory still rejects a journal inside that repository.
    {
      const { adapter, calls } = makeAdapter(CodexAgentAdapter, {
        temp, invocationJournalPath: join(repositoryRoot, "provider-invocations.sqlite")
      });
      const result = await adapter.run(makeRequest({
        workingDirectory: join(repositoryRoot, "src")
      }));
      assert.equal(result.status, "rejected");
      assert.equal(result.failureCode, "invocation_journal_inside_source_repository");
      assert.equal(calls.provider, 0, "zero provider calls on derived-root rejection");
    }

    // 8. No journal configured: nothing to validate, run proceeds.
    {
      const calls = { provider: 0 };
      const adapter = new CodexAgentAdapter({
        environment: { HOME: temp, PATH: process.env.PATH },
        authCheck: async () => true,
        clientFactory: () => {
          calls.provider += 1;
          return {
            startThread() {
              return {
                async runStreamed() {
                  return {
                    events: (async function* () {
                      for (const event of FAKE_EVENTS) yield event;
                    })()
                  };
                }
              };
            }
          };
        }
      });
      const result = await adapter.run(rejectionRequest());
      assert.equal(result.status, "completed");
      assert.equal(calls.provider, 1);
    }

    console.log("invocation-journal-location-smoke: PASS");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
