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

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

(async () => {
  const modulePath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/agent-event-ledger.js`
  );
  const indexPath = pathToFileURL(
    `${process.cwd()}/dist/packages/product-runtime/src/index.js`
  );
  const ledgerRuntime = await import(modulePath.href);
  const runtimeIndex = await import(indexPath.href);
  const {
    AGENT_EVENT_LEDGER_VERSION,
    appendAgentEvent,
    canonicalizeJson,
    computeAgentEventHash,
    computeEmptyLedgerRootHash,
    createAgentEventLedger,
    hashCanonicalJson
  } = ledgerRuntime;

  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const hashC = `sha256:${"c".repeat(64)}`;
  const hashPattern = /^sha256:[0-9a-f]{64}$/;
  const ledgerInput = { runId: "run-123", objectiveHash: hashA };
  const baseDraft = {
    actor: "planner",
    action: "plan.created",
    startedAt: "2026-07-13T10:00:00+03:00",
    finishedAt: "2026-07-13T07:00:01.250Z",
    inputArtifactHashes: [hashB, hashA, hashB],
    outputArtifactHashes: [hashC, hashC],
    filesRead: ["src/z.ts", "src/a.ts", "src/z.ts"],
    filesProposed: ["src/new.ts", "src/a.ts", "src/new.ts"],
    decision: "continue",
    reasonCodes: ["PLAN.READY", "INPUT.OK", "PLAN.READY"],
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  };

  check("canonical JSON ignores object key insertion order", () => {
    assert.equal(
      canonicalizeJson({ z: 1, a: 2 }),
      canonicalizeJson({ a: 2, z: 1 })
    );
    assert.equal(canonicalizeJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
  });

  check("canonical JSON recursively sorts nested object keys", () => {
    assert.equal(
      canonicalizeJson({ outer: { z: true, a: null }, first: "x" }),
      '{"first":"x","outer":{"a":null,"z":true}}'
    );
  });

  check("canonical JSON preserves array order", () => {
    assert.notEqual(canonicalizeJson([1, 2]), canonicalizeJson([2, 1]));
    assert.equal(canonicalizeJson(["b", "a"]), '["b","a"]');
  });

  check("canonical JSON normalizes negative zero", () => {
    assert.equal(canonicalizeJson(-0), "0");
    assert.equal(canonicalizeJson({ value: -0 }), '{"value":0}');
  });

  check("canonical JSON preserves Unicode strings and JSON primitives", () => {
    const value = { unicode: "İstanbul 🧪", nil: null, yes: true, no: false, text: "x", number: 1.5 };
    assert.deepEqual(JSON.parse(canonicalizeJson(value)), value);
    const nullPrototype = Object.create(null);
    nullPrototype.answer = 42;
    assert.equal(canonicalizeJson(nullPrototype), '{"answer":42}');
  });

  check("canonical JSON rejects unsupported primitive values", () => {
    rejects(() => canonicalizeJson(undefined), /undefined is not supported/);
    rejects(() => canonicalizeJson(() => {}), /function is not supported/);
    rejects(() => canonicalizeJson(Symbol("x")), /symbol is not supported/);
    rejects(() => canonicalizeJson(1n), /bigint is not supported/);
    rejects(() => canonicalizeJson(NaN), /numbers must be finite/);
    rejects(() => canonicalizeJson(Infinity), /numbers must be finite/);
  });

  check("canonical JSON rejects non-plain objects", () => {
    class Example {}
    rejects(() => canonicalizeJson(new Date()), /only plain objects/);
    rejects(() => canonicalizeJson(new Map()), /only plain objects/);
    rejects(() => canonicalizeJson(new Set()), /only plain objects/);
    rejects(() => canonicalizeJson(new Example()), /only plain objects/);
  });

  check("canonical JSON rejects cycles and sparse arrays", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const sparse = [];
    sparse.length = 1;
    rejects(() => canonicalizeJson(cyclic), /cyclic objects/);
    rejects(() => canonicalizeJson(sparse), /sparse arrays/);
  });

  check("canonical hashing is stable, sensitive, and formatted", () => {
    const first = hashCanonicalJson({ b: 2, a: 1 });
    assert.equal(first, hashCanonicalJson({ a: 1, b: 2 }));
    assert.notEqual(first, hashCanonicalJson({ a: 1, b: 3 }));
    assert.match(first, hashPattern);
  });

  const emptyLedger = createAgentEventLedger(ledgerInput);

  check("empty ledger has a deterministic non-null root", () => {
    const duplicate = createAgentEventLedger(ledgerInput);
    const changed = createAgentEventLedger({ ...ledgerInput, objectiveHash: hashB });
    assert.equal(AGENT_EVENT_LEDGER_VERSION, "1");
    assert.equal(emptyLedger.ledgerVersion, "1");
    assert.equal(emptyLedger.eventCount, 0);
    assert.deepEqual(emptyLedger.events, []);
    assert.match(emptyLedger.rootHash, hashPattern);
    assert.equal(emptyLedger.rootHash, duplicate.rootHash);
    assert.equal(
      emptyLedger.rootHash,
      computeEmptyLedgerRootHash(ledgerInput.runId, ledgerInput.objectiveHash)
    );
    assert.notEqual(emptyLedger.rootHash, changed.rootHash);
  });

  const draftSnapshot = JSON.stringify(baseDraft);
  const firstLedger = appendAgentEvent(emptyLedger, baseDraft);
  const firstEvent = firstLedger.events[0];

  check("first event is normalized, linked, and hashed", () => {
    assert.equal(firstEvent.sequence, 1);
    assert.equal(firstEvent.eventId, "run-123:event:000001");
    assert.equal(firstEvent.previousEventHash, null);
    assert.match(firstEvent.eventHash, hashPattern);
    assert.equal(firstLedger.rootHash, firstEvent.eventHash);
    assert.equal(firstLedger.eventCount, 1);
    assert.equal(firstEvent.startedAt, "2026-07-13T07:00:00.000Z");
    assert.equal(firstEvent.finishedAt, "2026-07-13T07:00:01.250Z");
    assert.equal(firstEvent.durationMs, 1250);
    assert.deepEqual(firstEvent.inputArtifactHashes, [hashA, hashB]);
    assert.deepEqual(firstEvent.outputArtifactHashes, [hashC]);
    assert.deepEqual(firstEvent.filesRead, ["src/a.ts", "src/z.ts"]);
    assert.deepEqual(firstEvent.filesProposed, ["src/a.ts", "src/new.ts"]);
    assert.deepEqual(firstEvent.reasonCodes, ["INPUT.OK", "PLAN.READY"]);
  });

  const secondDraft = {
    ...baseDraft,
    actor: "coder",
    action: "patch.drafted",
    startedAt: "2026-07-13T07:00:02.000Z",
    finishedAt: "2026-07-13T07:00:02.000Z",
    decision: null,
    tokenUsage: undefined
  };
  const firstEventSnapshot = JSON.stringify(firstEvent);
  const secondLedger = appendAgentEvent(firstLedger, secondDraft);

  check("second event extends the hash chain without changing the first", () => {
    const secondEvent = secondLedger.events[1];
    assert.equal(secondEvent.sequence, 2);
    assert.equal(secondEvent.eventId, "run-123:event:000002");
    assert.equal(secondEvent.previousEventHash, firstEvent.eventHash);
    assert.equal(secondLedger.rootHash, secondEvent.eventHash);
    assert.equal(secondLedger.eventCount, 2);
    assert.equal(JSON.stringify(secondLedger.events[0]), firstEventSnapshot);
    assert.equal("tokenUsage" in secondEvent, false);
  });

  check("identical normalized inputs produce identical event hashes", () => {
    const reordered = {
      ...baseDraft,
      inputArtifactHashes: [hashA, hashB],
      outputArtifactHashes: [hashC],
      filesRead: ["src/a.ts", "src/z.ts"],
      filesProposed: ["src/a.ts", "src/new.ts"],
      reasonCodes: ["INPUT.OK", "PLAN.READY"]
    };
    assert.equal(
      appendAgentEvent(emptyLedger, baseDraft).events[0].eventHash,
      appendAgentEvent(emptyLedger, reordered).events[0].eventHash
    );
  });

  check("decision and file evidence changes affect event hashes", () => {
    const baseline = appendAgentEvent(emptyLedger, baseDraft).events[0].eventHash;
    assert.notEqual(
      baseline,
      appendAgentEvent(emptyLedger, { ...baseDraft, decision: "stop" }).events[0].eventHash
    );
    assert.notEqual(
      baseline,
      appendAgentEvent(emptyLedger, { ...baseDraft, filesRead: ["different.ts"] }).events[0].eventHash
    );
  });

  check("previous event hash is included in event hash material", () => {
    const { eventHash, ...material } = secondLedger.events[1];
    assert.equal(computeAgentEventHash(material), eventHash);
    assert.notEqual(
      computeAgentEventHash(material),
      computeAgentEventHash({ ...material, previousEventHash: hashA })
    );
  });

  check("append is pure and returns deeply frozen values", () => {
    assert.equal(emptyLedger.eventCount, 0);
    assert.equal(JSON.stringify(baseDraft), draftSnapshot);
    assert.notEqual(firstLedger, emptyLedger);
    assert.ok(Object.isFrozen(firstLedger));
    assert.ok(Object.isFrozen(firstLedger.events));
    assert.ok(Object.isFrozen(firstEvent));
    assert.ok(Object.isFrozen(firstEvent.inputArtifactHashes));
    assert.ok(Object.isFrozen(firstEvent.outputArtifactHashes));
    assert.ok(Object.isFrozen(firstEvent.filesRead));
    assert.ok(Object.isFrozen(firstEvent.filesProposed));
    assert.ok(Object.isFrozen(firstEvent.reasonCodes));
    assert.ok(Object.isFrozen(firstEvent.tokenUsage));
    assert.equal(JSON.stringify(firstLedger), JSON.stringify(appendAgentEvent(emptyLedger, baseDraft)));
  });

  check("append does not freeze a mutable caller-owned ledger", () => {
    const mutableLedger = JSON.parse(JSON.stringify(firstLedger));
    const mutableExistingEvent = mutableLedger.events[0];
    const result = appendAgentEvent(mutableLedger, secondDraft);
    assert.equal(Object.isFrozen(mutableLedger), false);
    assert.equal(Object.isFrozen(mutableLedger.events), false);
    assert.equal(Object.isFrozen(mutableExistingEvent), false);
    assert.ok(Object.isFrozen(result.events[0]));
    assert.notEqual(result.events[0], mutableExistingEvent);
  });

  check("suspicious bounded file evidence is preserved exactly", () => {
    const suspicious = ["../outside.ts", "/absolute/path.ts", ".git/config", "folder\\windows-path.ts"];
    const event = appendAgentEvent(emptyLedger, {
      ...baseDraft,
      filesRead: [...suspicious].reverse(),
      filesProposed: suspicious
    }).events[0];
    assert.deepEqual(event.filesRead, [...suspicious].sort());
    assert.deepEqual(event.filesProposed, [...suspicious].sort());
    for (const file of suspicious) {
      assert.ok(event.filesRead.includes(file));
      assert.ok(event.filesProposed.includes(file));
    }
  });

  check("invalid ledger creation input is rejected", () => {
    rejects(() => createAgentEventLedger({ runId: " bad", objectiveHash: hashA }), /runId/);
    rejects(() => createAgentEventLedger({ runId: "bad/run", objectiveHash: hashA }), /runId/);
    rejects(() => createAgentEventLedger({ runId: "x".repeat(129), objectiveHash: hashA }), /runId/);
    rejects(() => createAgentEventLedger({ runId: "run", objectiveHash: "sha256:ABC" }), /objectiveHash/);
  });

  check("invalid actors and actions are rejected", () => {
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, actor: "verifier" }), /actor/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, action: " bad" }), /action/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, action: "bad/action" }), /action/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, action: "x".repeat(129) }), /action/);
  });

  check("invalid timestamps and reversed intervals are rejected", () => {
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, startedAt: "not-a-date" }), /startedAt/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, startedAt: "2026-02-30T00:00:00Z" }), /startedAt/);
    rejects(
      () => appendAgentEvent(emptyLedger, {
        ...baseDraft,
        startedAt: "2026-07-13T07:00:02Z",
        finishedAt: "2026-07-13T07:00:01Z"
      }),
      /equal to or after/
    );
  });

  check("invalid and excessive artifact hashes are rejected", () => {
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, inputArtifactHashes: ["bad"] }), /inputArtifactHashes/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, outputArtifactHashes: Array(65).fill(hashA) }), /at most 64/);
  });

  check("invalid and excessive file evidence is rejected", () => {
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, filesRead: [""] }), /filesRead/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, filesRead: [" bad.ts"] }), /filesRead/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, filesRead: ["bad\u0000.ts"] }), /filesRead/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, filesProposed: Array(129).fill("x.ts") }), /at most 128/);
  });

  check("invalid decisions and reason codes are rejected", () => {
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, decision: "" }), /decision/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, decision: "bad\nvalue" }), /decision/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, reasonCodes: ["bad code"] }), /reasonCodes/);
    rejects(() => appendAgentEvent(emptyLedger, { ...baseDraft, reasonCodes: Array(65).fill("OK") }), /at most 64/);
  });

  check("invalid token usage and total mismatches are rejected", () => {
    for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      rejects(
        () => appendAgentEvent(emptyLedger, {
          ...baseDraft,
          tokenUsage: { inputTokens: invalid, outputTokens: 0, totalTokens: invalid }
        }),
        /non-negative safe integer/
      );
    }
    rejects(
      () => appendAgentEvent(emptyLedger, {
        ...baseDraft,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 1 }
      }),
      /must equal/
    );
  });

  check("the 1001st event is rejected", () => {
    let boundedLedger = emptyLedger;
    const boundedDraft = {
      ...baseDraft,
      inputArtifactHashes: [],
      outputArtifactHashes: [],
      filesRead: [],
      filesProposed: [],
      reasonCodes: [],
      tokenUsage: undefined
    };
    for (let index = 0; index < 1000; index += 1) {
      boundedLedger = appendAgentEvent(boundedLedger, boundedDraft);
    }
    assert.equal(boundedLedger.eventCount, 1000);
    rejects(() => appendAgentEvent(boundedLedger, boundedDraft), /more than 1000 events/);
  });

  check("product-runtime index exports the ledger API", () => {
    for (const name of [
      "AGENT_EVENT_LEDGER_VERSION",
      "canonicalizeJson",
      "hashCanonicalJson",
      "computeAgentEventHash",
      "computeEmptyLedgerRootHash",
      "createAgentEventLedger",
      "appendAgentEvent"
    ]) {
      assert.equal(runtimeIndex[name], ledgerRuntime[name], `${name} export mismatch`);
    }
  });

  check("events contain only the bounded W.1 contract fields", () => {
    for (const forbidden of ["prompt", "response", "sourceContent", "patch", "environment", "secret", "credential"]) {
      assert.equal(forbidden in firstEvent, false);
    }
  });

  console.log("agent event ledger smoke passed");
})();
