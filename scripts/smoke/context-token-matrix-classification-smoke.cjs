#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const { classifyCell, shouldContinueAfterCell } = await import(pathToFileURL(path.resolve(
    __dirname, '../../research/context-token-matrix-v1/classification.mjs')).href);
  const allowed = ['packages/worker-contract/src/index.ts', 'tests/smoke/contracts.ts'];
  const check = (kind, status, commandId) => ({ kind, required: true, status,
    commandIds: [commandId], evidenceHashes: status === 'not_run' ? [] : ['sha256:evidence'],
    reasonCodes: status === 'failed' ? ['validation_command_failed'] :
      status === 'not_run' ? ['validation_command_not_executed'] : [] });
  const checks = [check('structural', 'passed', 'validation.structural'),
    check('syntax', 'failed', 'validation.syntax'),
    check('typecheck', 'not_run', 'validation.typecheck'),
    check('behavior_test', 'not_run', 'validation.test')];
  const base = () => ({ product: { decision: 'bounded_task_stopped',
    sourceRepositoryUnchanged: true, apply: 'NOT_RUN',
    failure: { stage: 'validation', code: 'bounded_task_required_validation_not_run' } },
  bounded: { decision: 'bounded_task_stopped',
    failure: { stage: 'validation', code: 'bounded_task_required_validation_not_run' },
    verifierResult: { decision: 'approve', validationEvidence: { checks: structuredClone(checks) } },
    plannerResult: { taskSeedResult: { repoResult: { adaptiveResult: { coderResult: {
      providerCalled: true, providerOutput: { claims: [
        { file: allowed[0] }, { file: allowed[1] }] } } } } } } },
  diagnostic: { commandId: 'validation.syntax', executed: true, exitCode: 2,
    timedOut: false, outputTruncated: false, failureKind: 'typescript_diagnostic',
    compilerDiagnostics: [{ file: allowed[1], line: 206, column: 20, code: 'TS2352' }] },
  behaviorStatus: 'FAIL', sourceBefore: '?? .bounded/', sourceAfter: '?? .bounded/',
  allowedFiles: allowed });
  const classify = value => classifyCell(value);
  const compile = base();
  const unchanged = structuredClone(compile);
  assert.equal(classify(compile), 'candidate_validation_failure');
  assert.deepEqual(compile, unchanged, 'research classification cannot change product outcome');
  assert.equal(shouldContinueAfterCell(classify(compile)), true);
  assert.equal(compile.bounded.verifierResult.validationEvidence.checks[2].status, 'not_run',
    'later checks remain not-run after the candidate compiler error');

  const typecheck = base();
  typecheck.bounded.verifierResult.validationEvidence.checks[1] =
    check('syntax', 'passed', 'validation.syntax');
  typecheck.bounded.verifierResult.validationEvidence.checks[2] =
    check('typecheck', 'failed', 'validation.typecheck');
  typecheck.diagnostic.commandId = 'validation.typecheck';
  assert.equal(classify(typecheck), 'candidate_validation_failure');

  const test = base();
  test.product.failure.code = 'bounded_task_required_validation_failed';
  test.bounded.failure.code = 'bounded_task_required_validation_failed';
  test.bounded.verifierResult.validationEvidence.checks[1] =
    check('syntax', 'passed', 'validation.syntax');
  test.bounded.verifierResult.validationEvidence.checks[2] =
    check('typecheck', 'passed', 'validation.typecheck');
  test.bounded.verifierResult.validationEvidence.checks[3] =
    check('behavior_test', 'failed', 'validation.test');
  test.diagnostic = { commandId: 'validation.test', executed: true, exitCode: 1,
    timedOut: false, outputTruncated: false, failureKind: 'candidate_assertion',
    checker: 'request_id_acceptance' };
  assert.equal(classify(test), 'candidate_validation_failure');

  const missingTool = base();
  missingTool.diagnostic = { commandId: 'validation.syntax', executed: false,
    exitCode: null, failureKind: 'missing_executable' };
  assert.equal(classify(missingTool), 'infrastructure_failure');
  assert.equal(shouldContinueAfterCell(classify(missingTool)), false);
  const container = base();
  container.bounded.verifierResult.validationEvidence.checks[1] =
    check('syntax', 'not_run', 'validation.syntax');
  container.diagnostic = { commandId: 'validation.syntax', executed: false,
    exitCode: null, failureKind: 'container_unavailable' };
  assert.equal(classify(container), 'infrastructure_failure');
  const sourceMismatch = base();
  sourceMismatch.product.sourceRepositoryUnchanged = false;
  assert.equal(classify(sourceMismatch), 'infrastructure_failure');
  const contradictory = base();
  contradictory.bounded.verifierResult.validationEvidence.checks[2] =
    check('typecheck', 'passed', 'validation.typecheck');
  assert.equal(classify(contradictory), 'ambiguous_failure');
  assert.equal(shouldContinueAfterCell(classify(contradictory)), false);
  const missingStatus = base();
  delete missingStatus.bounded.verifierResult.validationEvidence.checks[1].status;
  assert.equal(classify(missingStatus), 'ambiguous_failure');
  const sourceChanged = base();
  sourceChanged.sourceAfter = ' M tests/smoke/contracts.ts';
  assert.equal(classify(sourceChanged), 'infrastructure_failure');
  const outside = base();
  outside.product.failure = { stage: 'verification', code: 'bounded_task_mutation_scope_violation' };
  outside.bounded.failure = { ...outside.product.failure };
  outside.bounded.plannerResult.taskSeedResult.repoResult.adaptiveResult.coderResult
    .providerOutput.claims = [{ file: 'outside.ts' }];
  assert.equal(classify(outside), 'candidate_governance_failure');
  assert.equal(shouldContinueAfterCell(classify(outside)), true);
  const forged = base();
  forged.bounded.plannerResult.taskSeedResult.repoResult.adaptiveResult.coderResult
    .providerOutput.classification = 'candidate_validation_failure';
  forged.diagnostic = null;
  assert.equal(classify(forged), 'ambiguous_failure');
  const completed = base();
  completed.product.decision = completed.bounded.decision = 'bounded_task_completed';
  completed.product.failure = completed.bounded.failure = null;
  completed.behaviorStatus = 'PASS';
  assert.equal(classify(completed), 'completed');
  console.log('context-token-matrix-classification-smoke: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
