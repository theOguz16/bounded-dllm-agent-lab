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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

(async () => {
  const modulePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/agent-event-ledger-verifier.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const ledgerPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/agent-event-ledger.js`
  );
  const { verifyAgentEventLedger } = await import(modulePath.href);
  const runtimeIndex = await import(indexPath.href);
  const { appendAgentEvent, canonicalizeJson, createAgentEventLedger } = await import(ledgerPath.href);

  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const hashC = `sha256:${"c".repeat(64)}`;
  const ledgerInput = { runId: "run-w2", objectiveHash: hashA };

  function draft(overrides = {}) {
    return {
      actor: "planner",
      action: "plan.created",
      startedAt: "2026-07-13T07:00:00.000Z",
      finishedAt: "2026-07-13T07:00:01.250Z",
      inputArtifactHashes: [hashA, hashB],
      outputArtifactHashes: [hashC],
      filesRead: ["src/a.ts", "src/z.ts"],
      filesProposed: ["src/new.ts"],
      decision: "continue",
      reasonCodes: ["INPUT.OK", "PLAN.READY"],
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ...overrides
    };
  }

  function makeLedger(count = 1, overrides = {}) {
    let ledger = createAgentEventLedger(ledgerInput);
    for (let index = 0; index < count; index += 1) {
      ledger = appendAgentEvent(
        ledger,
        draft({
          actor: index === 0 ? "planner" : "coder",
          action: index === 0 ? "plan.created" : `patch.drafted:${index}`,
          startedAt: `2026-07-13T07:00:0${index}.000Z`,
          finishedAt: `2026-07-13T07:00:0${index}.500Z`
        })
      );
    }
    return overrides.suspicious
      ? appendAgentEvent(
          createAgentEventLedger(ledgerInput),
          draft({
            filesRead: ["../outside.ts", "/absolute/path.ts", ".git/config", "folder\\windows-path.ts"],
            filesProposed: ["../outside.ts", "/absolute/path.ts", ".git/config", "folder\\windows-path.ts"]
          })
        )
      : ledger;
  }

  function assertDecision(result, decision, code) {
    assert.equal(result.decision, decision, JSON.stringify(result.issues));
    if (code !== undefined) {
      assert.ok(result.issues.some((entry) => entry.code === code), JSON.stringify(result.issues));
    }
    if (decision !== "ledger_valid") {
      assert.equal(result.verifiedLedger, null);
    }
  }

  function mutatedEvent(name, mutate, code) {
    check(`event mutation: ${name}`, () => {
      const input = clone(makeLedger(2));
      mutate(input.events[0], input);
      assertDecision(verifyAgentEventLedger(input), "ledger_invalid", code);
    });
  }

  function mutatedLedger(name, mutate, code, options) {
    check(`ledger mutation: ${name}`, () => {
      const original = makeLedger(3);
      const input = clone(original);
      mutate(input, original);
      assertDecision(verifyAgentEventLedger(input, options?.(original)), "ledger_invalid", code);
    });
  }

  const emptyLedger = createAgentEventLedger(ledgerInput);
  const oneEventLedger = makeLedger(1);
  const multiEventLedger = makeLedger(3);

  check("valid empty ledger verifies", () => {
    const result = verifyAgentEventLedger(emptyLedger);
    assertDecision(result, "ledger_valid");
    assert.equal(result.summary.verifiedEventCount, 0);
    assert.equal(result.summary.internallyConsistent, true);
    assert.equal(result.summary.externallyAnchored, false);
    assert.equal(result.summary.externalAnchorsMatched, true);
  });

  check("valid one-event ledger verifies", () => {
    const result = verifyAgentEventLedger(oneEventLedger);
    assertDecision(result, "ledger_valid");
    assert.equal(result.summary.verifiedEventCount, 1);
  });

  check("valid multi-event ledger verifies", () => {
    const result = verifyAgentEventLedger(multiEventLedger);
    assertDecision(result, "ledger_valid");
    assert.equal(result.summary.verifiedEventCount, 3);
    assert.equal(result.summary.boundedVerificationCompleted, true);
  });

  check("JSON round-trip ledger verifies", () => {
    assertDecision(verifyAgentEventLedger(clone(multiEventLedger)), "ledger_valid");
  });

  check("null-prototype ledger and nested objects verify", () => {
    const ordinary = clone(oneEventLedger);
    const nullEvent = Object.assign(Object.create(null), ordinary.events[0]);
    nullEvent.tokenUsage = Object.assign(Object.create(null), ordinary.events[0].tokenUsage);
    const nullLedger = Object.assign(Object.create(null), ordinary, { events: [nullEvent] });
    assertDecision(verifyAgentEventLedger(nullLedger), "ledger_valid");
  });

  check("suspicious file evidence remains integrity-valid", () => {
    const ledger = makeLedger(1, { suspicious: true });
    const result = verifyAgentEventLedger(clone(ledger));
    assertDecision(result, "ledger_valid");
    for (const file of ["../outside.ts", "/absolute/path.ts", ".git/config", "folder\\windows-path.ts"]) {
      assert.ok(result.verifiedLedger.events[0].filesRead.includes(file));
      assert.ok(result.verifiedLedger.events[0].filesProposed.includes(file));
    }
  });

  check("each matching external anchor passes", () => {
    for (const options of [
      { expectedRunId: oneEventLedger.runId },
      { expectedObjectiveHash: oneEventLedger.objectiveHash },
      { expectedRootHash: oneEventLedger.rootHash },
      { expectedEventCount: oneEventLedger.eventCount }
    ]) {
      const result = verifyAgentEventLedger(oneEventLedger, options);
      assertDecision(result, "ledger_valid");
      assert.equal(result.summary.externallyAnchored, true);
      assert.equal(result.summary.externalAnchorsMatched, true);
    }
  });

  check("all matching external anchors pass", () => {
    assertDecision(
      verifyAgentEventLedger(oneEventLedger, {
        expectedRunId: oneEventLedger.runId,
        expectedObjectiveHash: oneEventLedger.objectiveHash,
        expectedRootHash: oneEventLedger.rootHash,
        expectedEventCount: oneEventLedger.eventCount
      }),
      "ledger_valid"
    );
  });

  check("external anchor mismatches invalidate with stable codes", () => {
    const cases = [
      [{ expectedRunId: "other-run" }, "external_run_id_anchor_mismatch"],
      [{ expectedObjectiveHash: hashB }, "external_objective_hash_anchor_mismatch"],
      [{ expectedRootHash: hashB }, "external_root_hash_anchor_mismatch"],
      [{ expectedEventCount: 2 }, "external_event_count_anchor_mismatch"]
    ];
    for (const [options, code] of cases) {
      assertDecision(verifyAgentEventLedger(oneEventLedger, options), "ledger_invalid", code);
    }
  });

  check("invalid verifier options throw TypeError", () => {
    for (const options of [
      null,
      { expectedRunId: "bad/run" },
      { expectedObjectiveHash: "bad" },
      { expectedRootHash: "bad" },
      { expectedEventCount: -1 },
      { expectedEventCount: 1001 },
      { expectedEventCount: 1.5 }
    ]) {
      assert.throws(() => verifyAgentEventLedger(emptyLedger, options), TypeError);
    }
  });

  mutatedEvent("actor", (event) => { event.actor = "coder"; }, "event_hash_mismatch");
  mutatedEvent("action", (event) => { event.action = "plan.changed"; }, "event_hash_mismatch");
  mutatedEvent("startedAt", (event) => { event.startedAt = "2026-07-13T06:59:59.000Z"; }, "event_hash_mismatch");
  mutatedEvent("finishedAt", (event) => { event.finishedAt = "2026-07-13T07:00:01.000Z"; }, "event_hash_mismatch");
  mutatedEvent("durationMs", (event) => { event.durationMs += 1; }, "event_duration_mismatch");
  mutatedEvent("inputArtifactHashes", (event) => { event.inputArtifactHashes = [hashC]; }, "event_hash_mismatch");
  mutatedEvent("outputArtifactHashes", (event) => { event.outputArtifactHashes = [hashA]; }, "event_hash_mismatch");
  mutatedEvent("filesRead", (event) => { event.filesRead = ["different.ts"]; }, "event_hash_mismatch");
  mutatedEvent("filesProposed", (event) => { event.filesProposed = ["different.ts"]; }, "event_hash_mismatch");
  mutatedEvent("decision", (event) => { event.decision = "stop"; }, "event_hash_mismatch");
  mutatedEvent("reasonCodes", (event) => { event.reasonCodes = ["CHANGED"]; }, "event_hash_mismatch");
  mutatedEvent("tokenUsage", (event) => { event.tokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }; }, "event_hash_mismatch");
  mutatedEvent("previousEventHash", (event) => { event.previousEventHash = hashA; }, "event_previous_hash_mismatch");
  mutatedEvent("eventHash", (event) => { event.eventHash = hashA; }, "event_hash_mismatch");
  mutatedEvent("sequence", (event) => { event.sequence = 7; }, "event_sequence_mismatch");
  mutatedEvent("eventId", (event) => { event.eventId = "run-w2:event:999999"; }, "event_id_mismatch");
  mutatedEvent("event runId", (event) => { event.runId = "other-run"; }, "event_run_id_mismatch");
  mutatedEvent("malformed eventVersion", (event) => { event.eventVersion = 2; }, "unsupported_event_version");

  mutatedLedger("runId", (ledger) => { ledger.runId = "other-run"; }, "event_id_mismatch");
  mutatedLedger(
    "objectiveHash against trusted anchor",
    (ledger) => { ledger.objectiveHash = hashB; },
    "external_objective_hash_anchor_mismatch",
    (original) => ({ expectedObjectiveHash: original.objectiveHash })
  );
  mutatedLedger("rootHash", (ledger) => { ledger.rootHash = hashB; }, "ledger_root_hash_mismatch");
  mutatedLedger("eventCount", (ledger) => { ledger.eventCount -= 1; }, "event_count_mismatch");
  mutatedLedger("remove event", (ledger) => { ledger.events.pop(); ledger.eventCount -= 1; }, "ledger_root_hash_mismatch");
  mutatedLedger("duplicate event", (ledger) => { ledger.events.push(clone(ledger.events[0])); ledger.eventCount += 1; }, "duplicate_event_id");
  mutatedLedger("reorder events", (ledger) => { ledger.events.reverse(); }, "event_sequence_mismatch");
  mutatedLedger("insert event", (ledger) => { ledger.events.splice(1, 0, clone(ledger.events[0])); ledger.eventCount += 1; }, "duplicate_event_id");
  mutatedLedger("sequence gap", (ledger) => { ledger.events[1].sequence = 9; }, "event_sequence_mismatch");
  mutatedLedger("wrong previous hash", (ledger) => { ledger.events[1].previousEventHash = hashA; }, "event_previous_hash_mismatch");
  mutatedLedger("wrong final root", (ledger) => { ledger.rootHash = hashC; }, "ledger_root_hash_mismatch");

  check("unsupported event string version needs review", () => {
    const input = clone(oneEventLedger);
    input.events[0].eventVersion = "2";
    const result = verifyAgentEventLedger(input);
    assertDecision(result, "ledger_needs_review", "unsupported_event_version");
    assert.equal(result.summary.eventVersionsSupported, false);
  });

  check("unsupported event version stops reconstruction without false later corruption", () => {
    const input = clone(multiEventLedger);
    input.events[0].eventVersion = "2";
    const result = verifyAgentEventLedger(input);
    assertDecision(result, "ledger_needs_review", "unsupported_event_version");
    assert.equal(result.issues.some((entry) => entry.severity === "error"), false);
    assert.equal(result.summary.boundedVerificationCompleted, true);
  });

  const normalizationCases = [
    ["duplicated input hashes", (event) => { event.inputArtifactHashes.push(event.inputArtifactHashes[0]); }],
    ["unsorted input hashes", (event) => { event.inputArtifactHashes.reverse(); }],
    ["duplicated output hashes", (event) => { event.outputArtifactHashes.push(event.outputArtifactHashes[0]); }],
    ["duplicated files", (event) => { event.filesRead.push(event.filesRead[0]); }],
    ["unsorted files", (event) => { event.filesRead.reverse(); }],
    ["duplicated reason codes", (event) => { event.reasonCodes.push(event.reasonCodes[0]); }],
    ["unsorted reason codes", (event) => { event.reasonCodes.reverse(); }],
    ["non-normalized timestamp", (event) => { event.startedAt = "2026-07-13T10:00:00+03:00"; }],
    ["incorrect duration", (event) => { event.durationMs = 999; }]
  ];
  for (const [name, mutate] of normalizationCases) {
    check(`noncanonical ledger rejects ${name}`, () => {
      const input = clone(oneEventLedger);
      mutate(input.events[0]);
      assertDecision(verifyAgentEventLedger(input), "ledger_invalid");
      assert.ok(
        verifyAgentEventLedger(input).issues.some((entry) =>
          ["event_normalization_mismatch", "event_duration_mismatch"].includes(entry.code)
        )
      );
    });
  }

  check("unknown top-level field is rejected", () => {
    const input = clone(emptyLedger);
    input.extra = true;
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "unknown_ledger_field");
  });

  check("unknown event field is rejected", () => {
    const input = clone(oneEventLedger);
    input.events[0].extra = true;
    const result = verifyAgentEventLedger(input);
    assertDecision(result, "ledger_invalid", "unknown_event_field");
    assert.equal(result.summary.verifiedEventCount, 0);
  });

  check("unknown tokenUsage field is rejected", () => {
    const input = clone(oneEventLedger);
    input.events[0].tokenUsage.extra = true;
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "unknown_event_field");
  });

  check("top-level accessor is rejected without invoking it", () => {
    const input = clone(emptyLedger);
    let invoked = false;
    delete input.runId;
    Object.defineProperty(input, "runId", { enumerable: true, get() { invoked = true; throw new Error("getter"); } });
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "ledger_accessor_property");
    assert.equal(invoked, false);
  });

  check("event accessor is rejected without invoking it", () => {
    const input = clone(oneEventLedger);
    let invoked = false;
    delete input.events[0].actor;
    Object.defineProperty(input.events[0], "actor", { enumerable: true, get() { invoked = true; throw new Error("getter"); } });
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "event_accessor_property");
    assert.equal(invoked, false);
  });

  check("tokenUsage accessor is rejected without invoking it", () => {
    const input = clone(oneEventLedger);
    let invoked = false;
    delete input.events[0].tokenUsage.inputTokens;
    Object.defineProperty(input.events[0].tokenUsage, "inputTokens", { enumerable: true, get() { invoked = true; throw new Error("getter"); } });
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "event_accessor_property");
    assert.equal(invoked, false);
  });

  check("symbol properties are rejected", () => {
    const top = clone(emptyLedger);
    top[Symbol("hidden")] = true;
    assertDecision(verifyAgentEventLedger(top), "ledger_invalid", "ledger_symbol_property");
    const event = clone(oneEventLedger);
    event.events[0][Symbol("hidden")] = true;
    assertDecision(verifyAgentEventLedger(event), "ledger_invalid", "event_symbol_property");
  });

  check("inherited ledger and event data are rejected", () => {
    assertDecision(
      verifyAgentEventLedger(Object.create(clone(emptyLedger))),
      "ledger_invalid",
      "invalid_ledger_object"
    );
    const input = clone(oneEventLedger);
    input.events[0] = Object.create(input.events[0]);
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "invalid_event_object");
  });

  check("class instances, Date, Map, and Set are rejected", () => {
    class LedgerLike {}
    for (const input of [new LedgerLike(), new Date(), new Map(), new Set()]) {
      assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "invalid_ledger_object");
    }
  });

  check("sparse events array is rejected", () => {
    const input = clone(emptyLedger);
    input.events = [];
    input.events.length = 1;
    input.eventCount = 1;
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "sparse_events_array");
  });

  check("all malformed primitives and cyclic input return invalid without throwing", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    for (const input of [null, undefined, "x", 1, true, [], () => {}, Symbol("x"), 1n, cyclic]) {
      let result;
      assert.doesNotThrow(() => { result = verifyAgentEventLedger(input); });
      assertDecision(result, "ledger_invalid");
    }
  });

  check("throwing proxy returns invalid without throwing", () => {
    const proxy = new Proxy({}, { ownKeys() { throw new Error("blocked"); } });
    let result;
    assert.doesNotThrow(() => { result = verifyAgentEventLedger(proxy); });
    assertDecision(result, "ledger_invalid", "verification_exception");
  });

  check("unsupported ledger version needs review", () => {
    const input = clone(emptyLedger);
    input.ledgerVersion = "2";
    assertDecision(verifyAgentEventLedger(input), "ledger_needs_review", "unsupported_ledger_version");
  });

  check("more than 1000 events needs review and is not inspected", () => {
    const input = clone(emptyLedger);
    let inspected = 0;
    input.events = Array(1001).fill(null);
    Object.defineProperty(input.events, "0", {
      enumerable: true,
      configurable: true,
      get() { inspected += 1; throw new Error("must not inspect"); }
    });
    input.eventCount = 1001;
    const result = verifyAgentEventLedger(input);
    assertDecision(result, "ledger_needs_review", "too_many_events");
    assert.equal(inspected, 0);
    assert.equal(result.summary.boundedVerificationCompleted, false);
  });

  check("duplicate event hashes produce a warning issue", () => {
    const input = clone(multiEventLedger);
    input.events[1].eventHash = input.events[0].eventHash;
    assertDecision(verifyAgentEventLedger(input), "ledger_invalid", "duplicate_event_hash");
    assert.equal(
      verifyAgentEventLedger(input).issues.find((entry) => entry.code === "duplicate_event_hash").severity,
      "warning"
    );
  });

  check("external root anchor detects a complete internally consistent replacement", () => {
    const original = appendAgentEvent(
      createAgentEventLedger(ledgerInput),
      draft({ action: "original.action" })
    );
    const replacement = appendAgentEvent(
      createAgentEventLedger(ledgerInput),
      draft({ action: "replacement.action", decision: "replacement" })
    );
    assert.notEqual(original.rootHash, replacement.rootHash);
    assertDecision(verifyAgentEventLedger(replacement), "ledger_valid");
    assertDecision(
      verifyAgentEventLedger(replacement, { expectedRootHash: original.rootHash }),
      "ledger_invalid",
      "external_root_hash_anchor_mismatch"
    );
  });

  check("verification is pure, deterministic, and deeply frozen", () => {
    const input = clone(multiEventLedger);
    const options = { expectedRunId: input.runId, expectedRootHash: input.rootHash };
    const inputSnapshot = JSON.stringify(input);
    const optionsSnapshot = JSON.stringify(options);
    const first = verifyAgentEventLedger(input, options);
    const second = verifyAgentEventLedger(input, options);
    assert.equal(JSON.stringify(input), inputSnapshot);
    assert.equal(JSON.stringify(options), optionsSnapshot);
    assert.equal(canonicalizeJson(first), canonicalizeJson(second));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.issues));
    assert.ok(Object.isFrozen(first.summary));
    assert.ok(Object.isFrozen(first.verifiedLedger));
    assert.ok(Object.isFrozen(first.verifiedLedger.events));
    assert.ok(Object.isFrozen(first.verifiedLedger.events[0]));
    assert.ok(Object.isFrozen(first.verifiedLedger.events[0].tokenUsage));

    const invalid = verifyAgentEventLedger({});
    assert.ok(invalid.issues.length > 0);
    assert.ok(invalid.issues.every(Object.isFrozen));
  });

  check("product-runtime index exports the verifier", () => {
    assert.equal(typeof verifyAgentEventLedger, "function");
    assert.equal(runtimeIndex.verifyAgentEventLedger, verifyAgentEventLedger);
  });

  console.log("agent event ledger verifier smoke passed");
})();
