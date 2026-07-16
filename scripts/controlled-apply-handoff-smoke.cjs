#!/usr/bin/env node

const assert = require("node:assert/strict");

async function main() {
  const runtime = await import("../dist/packages/product-runtime/src/index.js");
  const {
    CONTROLLED_APPLY_HANDOFF_VERSION,
    DEFAULT_CONTROLLED_APPLY_CONSTRAINTS,
    buildControlledApplyHandoff,
    computeGovernedMutationHash,
    deriveGovernedMutationChangedFiles,
    hashCanonicalJson,
    verifyControlledApplyHandoff
  } = runtime;

  let checkCount = 0;
  function check(name, operation) {
    operation();
    checkCount += 1;
    console.log(`[ok] ${name}`);
  }

  const clone = (value) => structuredClone(value);
  const hash = (label) => hashCanonicalJson({ label });
  const otherHash = (label) => hash(`changed:${label}`);
  const files = ["src/a.ts", "src/b.ts"];

  function mutationFor(changeKind = "repair_draft", options = {}) {
    const repair = changeKind === "repair_draft";
    return {
      role: repair ? "remask" : "coder",
      target: repair ? "repairDraft" : "patchDraft",
      summary: repair ? "Bounded validated repair." : "Bounded validated patch draft.",
      claims: options.claims ?? [{
        type: repair ? "repair_draft" : "patch_draft",
        file: "src/a.ts",
        description: "MUTATION_DESCRIPTION_SENTINEL",
        proposedPatch: "MUTATION_BODY_SENTINEL"
      }],
      touchedFiles: options.touchedFiles ?? [...files],
      confidence: 0.9
    };
  }

  function artifactFor(options = {}) {
    const changeKind = options.changeKind ?? "repair_draft";
    const mutation = options.mutation ?? mutationFor(changeKind);
    const mutationHash = computeGovernedMutationHash(changeKind, mutation);
    const changedFiles = [...deriveGovernedMutationChangedFiles(mutation)];
    const route = options.route ?? "auto_continue";
    const phase = options.phase ?? "temp_validation_passed";
    const eligible = options.eligible ?? (route === "auto_continue" && phase === "temp_validation_passed");
    const policySkip = options.policySkip === true;
    const material = {
      artifactVersion: "2",
      change: {
        changeKind,
        mutationHash,
        changedFiles,
        patchDryRunResultHash: hash(`${changeKind}:dry-run`),
        temporaryApplyResultHash: hash(`${changeKind}:temp-apply`),
        executionVerificationResultHash: hash(`${changeKind}:execution`),
        stageEvents: {
          mutationSourceEventId: "run:event:000005",
          patchDryRunEventId: "run:event:000007",
          temporaryApplyEventId: "run:event:000008",
          executionVerifierEventId: "run:event:000009",
          shadowObserverEventId: "run:event:000010",
          deterministicGovernorEventId: "run:event:000011",
          adminInvocationPolicyEventId: "run:event:000012",
          adminAgentEventId: policySkip ? null : "run:event:000013",
          approvalRouterEventId: "run:event:000014"
        }
      },
      evidence: {
        runId: `controlled-${changeKind}-${route}-${phase}`,
        objectiveHash: hash(`${changeKind}:objective`),
        preShadowLedgerRootHash: hash(`${changeKind}:pre-root`),
        preShadowLedgerEventCount: 9,
        preShadowTraceHash: hash(`${changeKind}:trace`),
        observationHash: hash(`${changeKind}:observation`),
        governanceHash: hash(`${changeKind}:governance`),
        adminInvocationPolicyHash: hash(`${changeKind}:admin-invocation-policy`),
        adminInvocationAssessmentHash: hash(`${changeKind}:admin-invocation-assessment`),
        adminDecisionHash: policySkip ? null : hash(`${changeKind}:admin`),
        routeHash: hash(`${changeKind}:${route}:route`),
        governancePolicyHash: hash("governance-policy"),
        routerPolicyHash: hash("router-policy"),
        finalLedgerRootHash: hash(`${changeKind}:${route}:final-root`),
        finalLedgerEventCount: 14
      },
      decisions: {
        phaseVFinalDecision: phase,
        shadowStageDecision: "shadow_observer_completed",
        shadowValidationDecision: "shadow_observation_valid",
        governanceDecision: route === "auto_continue"
          ? "governance_passed"
          : route === "repair_required"
            ? "governance_repair_required"
            : route === "replan_required"
              ? "governance_replan_required"
              : route === "terminated"
                ? "governance_terminated"
                : "governance_escalation_required",
        adminInvocationMode: policySkip ? "conditional" : "always",
        adminInvocationDecision: policySkip ? "admin_invocation_skipped" : "admin_invocation_required",
        adminInvocationSkipKind: policySkip ? "clean_path" : null,
        adminResolutionKind: policySkip ? "verified_policy_skip" : "model_decision",
        adminStageDecision: policySkip ? "admin_skipped_by_policy" : "admin_agent_completed",
        adminValidationDecision: policySkip ? null : "admin_decision_valid",
        adminDecision: policySkip ? null : route === "auto_continue"
          ? "admin_auto_approved"
          : route === "repair_required"
            ? "admin_repair_required"
            : route === "replan_required"
              ? "admin_replan_required"
              : route === "terminated"
                ? "admin_run_terminated"
                : "admin_human_escalation_required",
        routerValidationDecision: "approval_route_valid",
        workflowRoute: route
      },
      applyEligibility: {
        eligible,
        reasonCodes: eligible ? [] : ["controlled_apply_not_permitted"]
      }
    };
    return {
      mutation,
      artifact: {
        ...material,
        governedArtifactHash: hashCanonicalJson(material)
      }
    };
  }

  function freshnessFrom(artifact) {
    return {
      runId: artifact.evidence.runId,
      objectiveHash: artifact.evidence.objectiveHash,
      mutationHash: artifact.change.mutationHash,
      changedFiles: [...artifact.change.changedFiles],
      patchDryRunResultHash: artifact.change.patchDryRunResultHash,
      temporaryApplyResultHash: artifact.change.temporaryApplyResultHash,
      executionVerificationResultHash: artifact.change.executionVerificationResultHash,
      preShadowTraceHash: artifact.evidence.preShadowTraceHash,
      observationHash: artifact.evidence.observationHash,
      governanceHash: artifact.evidence.governanceHash,
      adminInvocationPolicyHash: artifact.evidence.adminInvocationPolicyHash,
      adminInvocationAssessmentHash: artifact.evidence.adminInvocationAssessmentHash,
      adminDecisionHash: artifact.evidence.adminDecisionHash,
      routeHash: artifact.evidence.routeHash,
      governancePolicyHash: artifact.evidence.governancePolicyHash,
      routerPolicyHash: artifact.evidence.routerPolicyHash,
      finalLedgerRootHash: artifact.evidence.finalLedgerRootHash,
      finalLedgerEventCount: artifact.evidence.finalLedgerEventCount,
      phaseVFinalDecision: artifact.decisions.phaseVFinalDecision,
      workflowRoute: artifact.decisions.workflowRoute
    };
  }

  const target = {
    repositoryIdentityHash: hash("repository-identity"),
    baseRevisionHash: hash("base-revision"),
    worktreeStateHash: hash("worktree-state")
  };

  function inputFor(fixture = artifactFor(), overrides = {}) {
    return {
      artifact: fixture.artifact,
      currentFreshnessSnapshot: freshnessFrom(fixture.artifact),
      mutation: fixture.mutation,
      target: { ...target },
      ...overrides
    };
  }

  const cleanFixture = artifactFor();
  const cleanInput = inputFor(cleanFixture);
  const cleanInputBefore = clone(cleanInput);
  const clean = buildControlledApplyHandoff(cleanInput);

  check("clean current evidence builds a ready controlled apply handoff", () => {
    assert.equal(CONTROLLED_APPLY_HANDOFF_VERSION, "1");
    assert.equal(clean.decision, "controlled_apply_handoff_ready");
    assert.ok(clean.handoff);
    assert.equal(clean.freshness.decision, "governed_change_current");
    assert.equal(clean.summary.artifactIntegrityVerified, true);
    assert.equal(clean.summary.artifactCurrent, true);
    assert.equal(clean.summary.artifactApplyEligible, true);
    assert.equal(clean.summary.phaseVPassed, true);
    assert.equal(clean.summary.workflowRouteAutoContinue, true);
    assert.equal(clean.summary.mutationValid, true);
    assert.equal(clean.summary.mutationHashMatched, true);
    assert.equal(clean.summary.changedFilesMatched, true);
    assert.equal(clean.summary.targetValid, true);
    assert.equal(clean.summary.constraintsValid, true);
    assert.equal(clean.summary.externalConsumptionRegistryRequired, true);
    assert.equal(clean.summary.handoffBuilt, true);
    assert.match(clean.handoff.constraintsHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(clean.handoff.singleUse.consumptionKey, /^sha256:[0-9a-f]{64}$/);
    assert.match(clean.handoff.handoffHash, /^sha256:[0-9a-f]{64}$/);
  });

  check("clean policy-skip evidence builds a ready handoff without Admin decision hash", () => {
    const fixture = artifactFor({ policySkip: true });
    const result = buildControlledApplyHandoff(inputFor(fixture));
    assert.equal(result.decision, "controlled_apply_handoff_ready");
    assert.equal(result.handoff.evidence.adminDecisionHash, null);
    assert.notEqual(result.handoff.evidence.governedArtifactHash,
      clean.handoff.evidence.governedArtifactHash);
    assert.notEqual(result.handoff.evidence.currentSnapshotHash,
      clean.handoff.evidence.currentSnapshotHash);
  });

  check("coder and repair mutation hashes reproduce exact existing artifact labels", () => {
    for (const changeKind of ["coder_patch_draft", "repair_draft"]) {
      const mutation = mutationFor(changeKind);
      const artifactType = changeKind === "coder_patch_draft"
        ? "coder_validated_mutation"
        : "repair_draft_mutation";
      assert.equal(
        computeGovernedMutationHash(changeKind, mutation),
        hashCanonicalJson({ artifactType, value: mutation })
      );
      const fixture = artifactFor({ changeKind, mutation });
      const result = buildControlledApplyHandoff(inputFor(fixture));
      assert.equal(result.decision, "controlled_apply_handoff_ready");
      assert.equal(result.handoff.mutation.changeKind, changeKind);
      assert.equal(result.handoff.mutation.mutationHash, fixture.artifact.change.mutationHash);
    }
  });

  check("changed files derive only from bounded touchedFiles and normalize exactly", () => {
    const mutation = mutationFor("repair_draft", {
      touchedFiles: ["z.ts", "a.ts", "z.ts", ".git/config"]
    });
    assert.deepEqual(deriveGovernedMutationChangedFiles(mutation),
      [".git/config", "a.ts", "z.ts"]);
    assert.equal(Object.isFrozen(deriveGovernedMutationChangedFiles(mutation)), true);
  });

  check("reordered, duplicate, and suspicious governed file scopes remain exact", () => {
    for (const touchedFiles of [
      ["src/b.ts", "src/a.ts"],
      ["src/b.ts", "src/a.ts", "src/b.ts"],
      [".git/config"]
    ]) {
      const mutation = mutationFor("repair_draft", { touchedFiles });
      const fixture = artifactFor({ mutation });
      const result = buildControlledApplyHandoff(inputFor(fixture));
      assert.equal(result.decision, "controlled_apply_handoff_ready");
      assert.deepEqual(result.handoff.mutation.changedFiles,
        [...new Set(touchedFiles)].sort());
    }
  });

  check("mutation object insertion order does not affect the exact governed hash", () => {
    const mutation = mutationFor("repair_draft");
    const reordered = {
      confidence: mutation.confidence,
      touchedFiles: mutation.touchedFiles,
      claims: mutation.claims,
      summary: mutation.summary,
      target: mutation.target,
      role: mutation.role
    };
    assert.equal(computeGovernedMutationHash("repair_draft", reordered),
      computeGovernedMutationHash("repair_draft", mutation));
  });

  check("valid non-auto artifacts are blocked rather than invalid", () => {
    for (const route of ["repair_required", "replan_required", "human_required", "terminated"]) {
      const fixture = artifactFor({ route });
      const result = buildControlledApplyHandoff(inputFor(fixture));
      assert.equal(result.decision, "controlled_apply_handoff_blocked", route);
      assert.equal(result.handoff, null, route);
      assert.equal(result.freshness.decision, "governed_change_current", route);
      assert.equal(result.freshness.handoffEligible, false, route);
      assert.ok(result.issues.some((issue) =>
        issue.code === "controlled_apply_route_not_auto_continue"), route);
    }
  });

  check("valid current but non-authorizing evidence is blocked", () => {
    const cases = [
      artifactFor({ eligible: false }),
      artifactFor({ phase: "temp_validation_failed", route: "repair_required" }),
      artifactFor({ phase: "temp_validation_needs_review", route: "human_required" })
    ];
    for (const fixture of cases) {
      const result = buildControlledApplyHandoff(inputFor(fixture));
      assert.equal(result.decision, "controlled_apply_handoff_blocked");
      assert.equal(result.handoff, null);
      assert.equal(result.freshness.handoffEligible, false);
    }
  });

  const freshnessFields = Object.keys(freshnessFrom(cleanFixture.artifact));
  check("every W.17 freshness field change invalidates planning", () => {
    for (const field of freshnessFields) {
      const snapshot = freshnessFrom(cleanFixture.artifact);
      if (field === "runId") snapshot[field] = "different-run";
      else if (field === "changedFiles") snapshot[field] = ["different.ts"];
      else if (field === "finalLedgerEventCount") snapshot[field] += 1;
      else if (field === "phaseVFinalDecision") snapshot[field] = "temp_validation_failed";
      else if (field === "workflowRoute") snapshot[field] = "human_required";
      else if (field === "observationHash" || field === "adminDecisionHash") {
        snapshot[field] = otherHash(field);
      } else snapshot[field] = otherHash(field);
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, {
        currentFreshnessSnapshot: snapshot
      }));
      assert.equal(result.decision, "controlled_apply_handoff_invalid", field);
      assert.equal(result.handoff, null, field);
      assert.equal(result.freshness.decision, "governed_change_stale", field);
    }
  });

  check("artifact integrity and unsupported artifact versions fail planning", () => {
    const tampered = clone(cleanFixture.artifact);
    tampered.evidence.routeHash = otherHash("tampered-route");
    let result = buildControlledApplyHandoff(inputFor(cleanFixture, { artifact: tampered }));
    assert.equal(result.decision, "controlled_apply_handoff_invalid");
    assert.equal(result.handoff, null);
    assert.equal(result.summary.artifactIntegrityVerified, false);
    assert.ok(result.issues.some((issue) =>
      issue.code === "controlled_apply_artifact_integrity_mismatch"));
    const old = clone(cleanFixture.artifact);
    old.artifactVersion = "1";
    delete old.governedArtifactHash;
    old.governedArtifactHash = hashCanonicalJson(old);
    result = buildControlledApplyHandoff(inputFor(cleanFixture, { artifact: old }));
    assert.equal(result.decision, "controlled_apply_handoff_invalid");

    const oldSnapshot = freshnessFrom(cleanFixture.artifact);
    delete oldSnapshot.adminInvocationPolicyHash;
    delete oldSnapshot.adminInvocationAssessmentHash;
    result = buildControlledApplyHandoff(inputFor(cleanFixture, {
      currentFreshnessSnapshot: oldSnapshot
    }));
    assert.equal(result.decision, "controlled_apply_handoff_invalid");
    const unsupported = clone(cleanFixture.artifact);
    unsupported.artifactVersion = "3";
    delete unsupported.governedArtifactHash;
    unsupported.governedArtifactHash = hashCanonicalJson(unsupported);
    result = buildControlledApplyHandoff(inputFor(cleanFixture, { artifact: unsupported }));
    assert.equal(result.decision, "controlled_apply_handoff_invalid");
    assert.equal(result.handoff, null);
  });

  check("mutation semantic changes and malformed contracts fail closed", () => {
    const changedClaims = mutationFor("repair_draft", {
      claims: [{ type: "repair_draft", file: "src/a.ts", operation: "changed" }]
    });
    const reorderedClaims = mutationFor("repair_draft", {
      claims: [{ operation: "second" }, { operation: "first" }]
    });
    const missingOperation = mutationFor("repair_draft", { claims: [] });
    for (const mutation of [changedClaims, reorderedClaims, missingOperation]) {
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, { mutation }));
      assert.equal(result.decision, "controlled_apply_handoff_invalid");
      assert.equal(result.handoff, null);
      assert.ok(result.issues.some((issue) =>
        issue.code === "controlled_apply_mutation_hash_mismatch"));
    }
    for (const mutation of [null, [], {}, new Date(), new Map(), { ...cleanFixture.mutation,
      touchedFiles: "src/a.ts" }]) {
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, { mutation }));
      assert.equal(result.decision, "controlled_apply_handoff_invalid");
      assert.equal(result.handoff, null);
    }
  });

  check("semantically ordered mutation operations are hash-bound", () => {
    const mutation = mutationFor("repair_draft", {
      claims: [{ operation: "first" }, { operation: "second" }]
    });
    const fixture = artifactFor({ mutation });
    const reversed = clone(mutation);
    reversed.claims.reverse();
    const result = buildControlledApplyHandoff(inputFor(fixture, { mutation: reversed }));
    assert.equal(result.decision, "controlled_apply_handoff_invalid");
    assert.ok(result.issues.some((issue) =>
      issue.code === "controlled_apply_mutation_hash_mismatch"));
  });

  check("accessor, inherited, class, sparse, and wrong-kind mutations are rejected", () => {
    const accessor = clone(cleanFixture.mutation);
    Object.defineProperty(accessor, "summary", { get() { throw new Error("must not run"); } });
    class MutationClass {}
    const inherited = Object.create({ role: "remask" });
    Object.assign(inherited, cleanFixture.mutation);
    delete inherited.role;
    const sparse = clone(cleanFixture.mutation);
    sparse.touchedFiles = new Array(2);
    sparse.touchedFiles[0] = "src/a.ts";
    for (const mutation of [accessor, new MutationClass(), inherited, sparse]) {
      assert.doesNotThrow(() => {
        const result = buildControlledApplyHandoff(inputFor(cleanFixture, { mutation }));
        assert.equal(result.decision, "controlled_apply_handoff_invalid");
      });
    }
    assert.throws(() => computeGovernedMutationHash(
      "coder_patch_draft",
      mutationFor("repair_draft")
    ));
  });

  check("extra and missing changed files cannot match the governed artifact", () => {
    for (const touchedFiles of [[...files, "src/extra.ts"], [files[0]]]) {
      const mutation = mutationFor("repair_draft", { touchedFiles });
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, { mutation }));
      assert.equal(result.decision, "controlled_apply_handoff_invalid");
      assert.equal(result.handoff, null);
    }
  });

  check("target snapshots accept only exact lowercase SHA-256 values", () => {
    const invalidValues = [
      "not-a-hash", "/private/repository/path", "sha256:ABCDEF",
      `sha256:${"a".repeat(63)}`, `sha256:${"A".repeat(64)}`
    ];
    for (const field of Object.keys(target)) {
      for (const value of invalidValues) {
        const result = buildControlledApplyHandoff(inputFor(cleanFixture, {
          target: { ...target, [field]: value }
        }));
        assert.equal(result.decision, "controlled_apply_handoff_invalid", `${field}:${value}`);
        assert.equal(result.handoff, null);
      }
    }
  });

  check("omitted and explicit strict constraints are equivalent", () => {
    const explicit = buildControlledApplyHandoff(inputFor(cleanFixture, {
      constraints: { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS }
    }));
    assert.equal(explicit.decision, "controlled_apply_handoff_ready");
    assert.equal(explicit.handoff.constraintsHash, clean.handoff.constraintsHash);
    assert.equal(explicit.handoff.singleUse.consumptionKey,
      clean.handoff.singleUse.consumptionKey);
    assert.equal(explicit.handoff.handoffHash, clean.handoff.handoffHash);
  });

  check("every constraint relaxation is invalid", () => {
    for (const field of Object.keys(DEFAULT_CONTROLLED_APPLY_CONSTRAINTS)) {
      const constraints = { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS, [field]: false };
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, { constraints }));
      assert.equal(result.decision, "controlled_apply_handoff_invalid", field);
      assert.equal(result.handoff, null, field);
      assert.ok(result.issues.some((issue) =>
        issue.code === "controlled_apply_constraint_relaxation_forbidden"), field);
    }
  });

  check("missing, unknown, accessor, and symbol constraints are invalid", () => {
    const missing = { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS };
    delete missing.requireAtomicApply;
    const unknown = { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS, unknown: true };
    const accessor = { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS };
    Object.defineProperty(accessor, "requireAtomicApply", { get() { throw new Error("no"); } });
    const symbolic = { ...DEFAULT_CONTROLLED_APPLY_CONSTRAINTS };
    symbolic[Symbol("constraint")] = true;
    for (const constraints of [missing, unknown, accessor, symbolic]) {
      assert.doesNotThrow(() => {
        const result = buildControlledApplyHandoff(inputFor(cleanFixture, { constraints }));
        assert.equal(result.decision, "controlled_apply_handoff_invalid");
      });
    }
  });

  check("constraints, consumption, and handoff hashes recompute independently", () => {
    const handoff = clean.handoff;
    assert.equal(handoff.constraintsHash, hashCanonicalJson(handoff.constraints));
    assert.equal(handoff.singleUse.consumptionKey, hashCanonicalJson({
      artifactType: "controlled_apply_consumption_key",
      governedArtifactHash: handoff.evidence.governedArtifactHash,
      currentSnapshotHash: handoff.evidence.currentSnapshotHash,
      mutationHash: handoff.mutation.mutationHash,
      changedFiles: [...handoff.mutation.changedFiles],
      repositoryIdentityHash: handoff.target.repositoryIdentityHash,
      baseRevisionHash: handoff.target.baseRevisionHash,
      worktreeStateHash: handoff.target.worktreeStateHash,
      constraintsHash: handoff.constraintsHash
    }));
    const { handoffHash, ...material } = handoff;
    assert.equal(handoffHash, hashCanonicalJson(material));
  });

  check("every consumption identity binding changes its deterministic key", () => {
    const handoff = clean.handoff;
    const base = {
      artifactType: "controlled_apply_consumption_key",
      governedArtifactHash: handoff.evidence.governedArtifactHash,
      currentSnapshotHash: handoff.evidence.currentSnapshotHash,
      mutationHash: handoff.mutation.mutationHash,
      changedFiles: [...handoff.mutation.changedFiles],
      repositoryIdentityHash: handoff.target.repositoryIdentityHash,
      baseRevisionHash: handoff.target.baseRevisionHash,
      worktreeStateHash: handoff.target.worktreeStateHash,
      constraintsHash: handoff.constraintsHash
    };
    const variants = {
      governedArtifactHash: otherHash("artifact"),
      currentSnapshotHash: otherHash("snapshot"),
      mutationHash: otherHash("mutation"),
      changedFiles: ["different.ts"],
      repositoryIdentityHash: otherHash("repository"),
      baseRevisionHash: otherHash("revision"),
      worktreeStateHash: otherHash("worktree"),
      constraintsHash: otherHash("constraints")
    };
    for (const [field, value] of Object.entries(variants)) {
      assert.notEqual(hashCanonicalJson({ ...base, [field]: value }),
        handoff.singleUse.consumptionKey, field);
    }
  });

  check("every handoff hash binding participates in handoff integrity", () => {
    const { handoffHash, ...base } = clean.handoff;
    const variants = [
      { ...base, handoffVersion: "2" },
      { ...base, mutation: { ...base.mutation, mutationHash: otherHash("mutation") } },
      { ...base, evidence: { ...base.evidence, routeHash: otherHash("route") } },
      { ...base, target: { ...base.target, baseRevisionHash: otherHash("base") } },
      { ...base, constraints: { ...base.constraints, requireAtomicApply: false } },
      { ...base, executorRequirements: {
        ...base.executorRequirements, validateAfterApply: false
      } },
      { ...base, singleUse: {
        ...base.singleUse, consumptionKey: otherHash("consumption")
      } },
      { ...base, constraintsHash: otherHash("constraint-hash") }
    ];
    for (const material of variants) {
      assert.notEqual(hashCanonicalJson(material), handoffHash);
    }
  });

  check("repeated, round-trip, and insertion-order equivalent inputs are deterministic", () => {
    const repeated = buildControlledApplyHandoff(clone(cleanInput));
    const roundTrip = buildControlledApplyHandoff(JSON.parse(JSON.stringify(cleanInput)));
    const reorderedTarget = {
      worktreeStateHash: target.worktreeStateHash,
      repositoryIdentityHash: target.repositoryIdentityHash,
      baseRevisionHash: target.baseRevisionHash
    };
    const reordered = buildControlledApplyHandoff(inputFor(cleanFixture, {
      target: reorderedTarget
    }));
    for (const result of [repeated, roundTrip, reordered]) {
      assert.equal(result.handoff.constraintsHash, clean.handoff.constraintsHash);
      assert.equal(result.handoff.singleUse.consumptionKey,
        clean.handoff.singleUse.consumptionKey);
      assert.equal(result.handoff.handoffHash, clean.handoff.handoffHash);
    }
  });

  check("target changes deterministically change consumption and handoff hashes", () => {
    for (const field of Object.keys(target)) {
      const result = buildControlledApplyHandoff(inputFor(cleanFixture, {
        target: { ...target, [field]: otherHash(field) }
      }));
      assert.equal(result.decision, "controlled_apply_handoff_ready");
      assert.notEqual(result.handoff.singleUse.consumptionKey,
        clean.handoff.singleUse.consumptionKey);
      assert.notEqual(result.handoff.handoffHash, clean.handoff.handoffHash);
    }
  });

  const verificationInput = {
    handoff: clean.handoff,
    artifact: cleanFixture.artifact,
    currentFreshnessSnapshot: freshnessFrom(cleanFixture.artifact),
    mutation: cleanFixture.mutation,
    currentTarget: { ...target },
    consumptionStatus: "not_consumed"
  };
  const current = verifyControlledApplyHandoff(verificationInput);

  check("exact unconsumed handoff is current and execution-eligible", () => {
    assert.equal(current.decision, "controlled_apply_handoff_current");
    assert.equal(current.handoffIntegrityVerified, true);
    assert.equal(current.artifactIntegrityVerified, true);
    assert.equal(current.executionEligible, true);
    assert.deepEqual(current.staleFields, []);
    assert.deepEqual(current.reasonCodes, []);
    for (const value of Object.values(current.summary)) assert.equal(value, true);
  });

  check("consumed and unknown registry states fail closed", () => {
    const consumed = verifyControlledApplyHandoff({
      ...verificationInput,
      consumptionStatus: "already_consumed"
    });
    assert.equal(consumed.decision, "controlled_apply_handoff_consumed");
    assert.equal(consumed.executionEligible, false);
    assert.deepEqual(consumed.reasonCodes,
      ["controlled_apply_consumption_key_already_used"]);
    const unknown = verifyControlledApplyHandoff({
      ...verificationInput,
      consumptionStatus: "unknown"
    });
    assert.equal(unknown.decision, "controlled_apply_handoff_verification_invalid");
    assert.equal(unknown.executionEligible, false);
    assert.deepEqual(unknown.reasonCodes, ["controlled_apply_consumption_status_unknown"]);
  });

  check("artifact, snapshot, mutation, and target changes make the handoff stale", () => {
    const another = artifactFor({ changeKind: "coder_patch_draft" });
    const cases = [
      ["governedArtifactHash", {
        artifact: another.artifact,
        currentFreshnessSnapshot: freshnessFrom(another.artifact),
        mutation: another.mutation
      }],
      ["currentSnapshotHash", {
        currentFreshnessSnapshot: {
          ...freshnessFrom(cleanFixture.artifact),
          governanceHash: otherHash("governance")
        }
      }],
      ["mutationHash", { mutation: mutationFor("repair_draft", {
        claims: [{ operation: "changed" }]
      }) }],
      ["repositoryIdentityHash", { currentTarget: {
        ...target, repositoryIdentityHash: otherHash("repository")
      } }],
      ["baseRevisionHash", { currentTarget: {
        ...target, baseRevisionHash: otherHash("base")
      } }],
      ["worktreeStateHash", { currentTarget: {
        ...target, worktreeStateHash: otherHash("worktree")
      } }]
    ];
    for (const [field, overrides] of cases) {
      const result = verifyControlledApplyHandoff({ ...verificationInput, ...overrides });
      assert.equal(result.decision, "controlled_apply_handoff_stale", field);
      assert.equal(result.executionEligible, false, field);
      assert.ok(result.staleFields.includes(field), `${field}:${result.staleFields}`);
    }
  });

  check("a changed file set is reported with stable sorted stale fields", () => {
    const mutation = mutationFor("repair_draft", { touchedFiles: ["src/a.ts"] });
    const result = verifyControlledApplyHandoff({ ...verificationInput, mutation });
    assert.equal(result.decision, "controlled_apply_handoff_stale");
    assert.deepEqual(result.staleFields, ["changedFiles", "consumptionKey", "mutationHash"]);
  });

  check("a validly rehashed changed consumption key is stale", () => {
    const handoff = clone(clean.handoff);
    handoff.singleUse.consumptionKey = otherHash("consumption-key");
    delete handoff.handoffHash;
    handoff.handoffHash = hashCanonicalJson(handoff);
    const result = verifyControlledApplyHandoff({ ...verificationInput, handoff });
    assert.equal(result.decision, "controlled_apply_handoff_stale");
    assert.deepEqual(result.staleFields, ["consumptionKey"]);
    assert.ok(result.reasonCodes.includes("controlled_apply_consumption_key_mismatch"));
  });

  check("handoff and constraint integrity changes are invalid", () => {
    const handoff = clone(clean.handoff);
    handoff.target.baseRevisionHash = otherHash("tampered-base");
    let result = verifyControlledApplyHandoff({ ...verificationInput, handoff });
    assert.equal(result.decision, "controlled_apply_handoff_verification_invalid");
    assert.deepEqual(result.reasonCodes, ["controlled_apply_handoff_hash_mismatch"]);
    const constraintTamper = clone(clean.handoff);
    constraintTamper.constraintsHash = otherHash("constraints");
    delete constraintTamper.handoffHash;
    constraintTamper.handoffHash = hashCanonicalJson(constraintTamper);
    result = verifyControlledApplyHandoff({ ...verificationInput, handoff: constraintTamper });
    assert.equal(result.decision, "controlled_apply_handoff_verification_invalid");
    assert.deepEqual(result.reasonCodes, ["controlled_apply_constraints_hash_mismatch"]);
  });

  check("pre-W.17 handoff evidence is invalid rather than silently upgraded", () => {
    const oldHandoff = clone(clean.handoff);
    oldHandoff.evidence.governedArtifactHash = otherHash("pre-w17-artifact");
    oldHandoff.evidence.currentSnapshotHash = otherHash("pre-w17-snapshot");
    delete oldHandoff.handoffHash;
    oldHandoff.handoffHash = hashCanonicalJson(oldHandoff);
    const result = verifyControlledApplyHandoff({
      ...verificationInput,
      handoff: oldHandoff
    });
    assert.equal(result.decision, "controlled_apply_handoff_stale");
    assert.equal(result.executionEligible, false);
  });

  check("planner and verifier outputs are deeply immutable without freezing inputs", () => {
    assert.deepEqual(cleanInput, cleanInputBefore);
    assert.equal(Object.isFrozen(cleanInput), false);
    assert.equal(Object.isFrozen(cleanInput.artifact), false);
    for (const value of [
      clean, clean.issues, clean.summary, clean.handoff, clean.handoff.mutation,
      clean.handoff.mutation.changedFiles, clean.handoff.evidence, clean.handoff.target,
      clean.handoff.constraints, clean.handoff.executorRequirements, clean.handoff.singleUse,
      current, current.staleFields, current.reasonCodes, current.summary
    ]) assert.equal(Object.isFrozen(value), true);
    const blocked = buildControlledApplyHandoff(inputFor(artifactFor({
      route: "human_required"
    })));
    assert.equal(Object.isFrozen(blocked.issues), true);
    assert.ok(blocked.issues.length > 0);
    for (const issue of blocked.issues) assert.equal(Object.isFrozen(issue), true);
    assert.equal(Object.isFrozen(verificationInput), false);
  });

  check("single-use contract is honest and contains no local persistence claim", () => {
    const serialized = JSON.stringify(clean.handoff);
    assert.ok(serialized.includes("external_consumption_registry_required"));
    for (const prohibited of ["locallyConsumed", "guaranteedUnused", "randomNonce",
      "persistedRegistryReceipt"]) assert.equal(serialized.includes(prohibited), false);
  });

  check("handoff and results contain no sensitive or executable content", () => {
    const serialized = JSON.stringify({ clean, current });
    for (const sentinel of [
      "MUTATION_BODY_SENTINEL", "MUTATION_DESCRIPTION_SENTINEL", "SOURCE_CODE_SENTINEL",
      "DIFF_SENTINEL", "OBJECTIVE_TEXT_SENTINEL", "PLANNER_PROMPT_SENTINEL",
      "CODER_PROMPT_SENTINEL", "REPAIR_PROMPT_SENTINEL", "SHADOW_PROMPT_SENTINEL",
      "ADMIN_PROMPT_SENTINEL", "RAW_MODEL_OUTPUT_SENTINEL", "STDOUT_SENTINEL",
      "STDERR_SENTINEL", "/private/repository/path", "https://remote.example/repo.git",
      "main-branch", "git apply", "sh -c", "API_KEY_SENTINEL", "ENV_SECRET_SENTINEL",
      "ROLLBACK_CONTENT_SENTINEL"
    ]) assert.equal(serialized.includes(sentinel), false, sentinel);
    assert.equal(serialized.includes("proposedPatch"), false);
    assert.equal(serialized.includes("claims"), false);
  });

  check("malformed planner structures never throw", () => {
    class Custom {}
    const cyclic = {}; cyclic.self = cyclic;
    const accessor = { ...cleanInput };
    Object.defineProperty(accessor, "mutation", { get() { throw new Error("must not run"); } });
    const symbolic = { ...cleanInput }; symbolic[Symbol("x")] = true;
    const inherited = Object.create({ artifact: cleanInput.artifact });
    Object.assign(inherited, cleanInput); delete inherited.artifact;
    const missing = { ...cleanInput }; delete missing.target;
    const unknown = { ...cleanInput, command: "git apply" };
    for (const input of [null, undefined, 1, "x", [], new Custom(), new Date(),
      new Map(), new Set(), cyclic, accessor, symbolic, inherited, missing, unknown]) {
      assert.doesNotThrow(() => {
        const result = buildControlledApplyHandoff(input);
        assert.ok([
          "controlled_apply_handoff_invalid",
          "controlled_apply_handoff_needs_review"
        ].includes(result.decision));
        assert.equal(result.handoff, null);
      });
    }
  });

  check("malformed verifier structures never throw", () => {
    const handoffAccessor = clone(clean.handoff);
    Object.defineProperty(handoffAccessor, "handoffHash", {
      get() { throw new Error("must not run"); }
    });
    for (const input of [null, [], {}, new Date(), new Map(), handoffAccessor,
      { ...verificationInput, unknown: true },
      { ...verificationInput, handoff: { ...clean.handoff, unknown: true } }]) {
      assert.doesNotThrow(() => {
        const candidate = input === handoffAccessor
          ? { ...verificationInput, handoff: input }
          : input;
        const result = verifyControlledApplyHandoff(candidate);
        assert.equal(result.decision, "controlled_apply_handoff_verification_invalid");
        assert.equal(result.executionEligible, false);
      });
    }
  });

  check("runtime index exports the complete W.15 value API", () => {
    assert.equal(runtime.CONTROLLED_APPLY_HANDOFF_VERSION, "1");
    assert.equal(typeof runtime.DEFAULT_CONTROLLED_APPLY_CONSTRAINTS, "object");
    assert.equal(typeof runtime.computeGovernedMutationHash, "function");
    assert.equal(typeof runtime.deriveGovernedMutationChangedFiles, "function");
    assert.equal(typeof runtime.buildControlledApplyHandoff, "function");
    assert.equal(typeof runtime.verifyControlledApplyHandoff, "function");
  });

  console.log(`controlled apply handoff smoke passed (${checkCount} checks)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
