const REQUIRED_CHECKS = ['syntax', 'typecheck', 'behavior_test'];
const COMMAND_IDS = { syntax: 'validation.syntax', typecheck: 'validation.typecheck',
  behavior_test: 'validation.test' };
const INFRASTRUCTURE_CODES = new Set([
  'invocation_journal_unavailable', 'bounded_task_policy_changed',
  'bounded_task_required_validation_not_run'
]);

/** Interpret trusted product and locally reproduced validation evidence; never alter either. */
export function classifyCell({ product, bounded, diagnostic, behaviorStatus, sourceBefore,
  sourceAfter, allowedFiles }) {
  if (sourceBefore !== sourceAfter || product?.sourceRepositoryUnchanged !== true ||
      product?.apply !== 'NOT_RUN') return 'infrastructure_failure';
  if (product?.decision === 'bounded_task_completed' &&
      bounded?.decision === 'bounded_task_completed' && !product.failure) {
    if (behaviorStatus === 'PASS') return 'completed';
    return behaviorStatus === 'FAIL' && diagnostic?.failureKind === 'candidate_assertion' &&
      diagnostic.checker === 'request_id_acceptance'
      ? 'candidate_validation_failure' : 'ambiguous_failure';
  }
  const failure = product?.failure;
  if (!failure || !bounded || failure.code !== bounded.failure?.code ||
      failure.stage !== bounded.failure?.stage) return 'ambiguous_failure';
  if (failure.stage === 'coding' && failure.code === 'bounded_task_coder_output_invalid' &&
      bounded.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult?.coderResult?.providerCalled === true)
    return 'candidate_model_failure';
  const mutation = bounded.plannerResult?.taskSeedResult?.repoResult?.adaptiveResult
    ?.coderResult?.providerOutput;
  const claims = mutation?.claims;
  const candidateFiles = Array.isArray(claims) && claims.length > 0 &&
    claims.every(claim => typeof claim?.file === 'string')
    ? claims.map(claim => claim.file) : null;
  if (failure.stage === 'verification' &&
      failure.code === 'bounded_task_mutation_scope_violation' && candidateFiles)
    return 'candidate_governance_failure';
  if (failure.stage !== 'validation')
    return INFRASTRUCTURE_CODES.has(failure.code) ? 'infrastructure_failure' : 'ambiguous_failure';
  const checks = bounded.verifierResult?.validationEvidence?.checks;
  if (!candidateFiles || !Array.isArray(allowedFiles) ||
      candidateFiles.some(file => !allowedFiles.includes(file)) ||
      bounded.verifierResult?.decision !== 'approve' || !Array.isArray(checks))
    return 'ambiguous_failure';
  const structural = checks.find(check => check.kind === 'structural');
  const ordered = REQUIRED_CHECKS.map(kind => checks.find(check => check.kind === kind));
  if (structural?.status !== 'passed' || ordered.some(check => !check || check.required !== true))
    return 'ambiguous_failure';
  if (ordered.some(check => !['passed', 'failed', 'not_run'].includes(check.status)))
    return 'ambiguous_failure';
  const failedIndex = ordered.findIndex(check => check.status === 'failed');
  if (failedIndex < 0) {
    return failure.code === 'bounded_task_required_validation_not_run' &&
      ordered[0].status === 'not_run' && ordered.every(check =>
        check.status === 'not_run' && check.reasonCodes?.includes('validation_command_not_executed'))
      ? 'infrastructure_failure' : 'ambiguous_failure';
  }
  if (ordered.slice(0, failedIndex).some(check => check.status !== 'passed') ||
      ordered.slice(failedIndex + 1).some(check => check.status !== 'not_run' ||
        !check.reasonCodes?.includes('validation_command_not_executed')))
    return 'ambiguous_failure';
  const failed = ordered[failedIndex];
  const commandId = COMMAND_IDS[failed.kind];
  if (failed.commandIds?.length !== 1 || failed.commandIds[0] !== commandId ||
      failed.reasonCodes?.length !== 1 || failed.reasonCodes[0] !== 'validation_command_failed' ||
      !Array.isArray(failed.evidenceHashes) || failed.evidenceHashes.length === 0)
    return 'ambiguous_failure';
  if (diagnostic?.commandId !== commandId || diagnostic.executed !== true ||
      !Number.isInteger(diagnostic.exitCode) || diagnostic.exitCode === 0 ||
      diagnostic.timedOut === true || diagnostic.outputTruncated === true)
    return diagnostic?.failureKind === 'missing_executable' ||
      diagnostic?.failureKind === 'container_unavailable'
      ? 'infrastructure_failure' : 'ambiguous_failure';
  if (diagnostic.failureKind === 'missing_executable' ||
      diagnostic.failureKind === 'container_unavailable') return 'infrastructure_failure';
  if (failure.code !== 'bounded_task_required_validation_not_run' &&
      failure.code !== 'bounded_task_required_validation_failed') return 'ambiguous_failure';
  const compiler = ['syntax', 'typecheck'].includes(failed.kind) &&
    diagnostic.failureKind === 'typescript_diagnostic' &&
    Array.isArray(diagnostic.compilerDiagnostics) &&
    diagnostic.compilerDiagnostics.some(item => /^TS\d{4,5}$/.test(item.code) &&
      Number.isInteger(item.line) && item.line > 0 &&
      candidateFiles.includes(item.file) && allowedFiles.includes(item.file));
  const behavior = failed.kind === 'behavior_test' &&
    diagnostic.failureKind === 'candidate_assertion' &&
    diagnostic.checker === 'request_id_acceptance';
  return compiler || behavior ? 'candidate_validation_failure' : 'ambiguous_failure';
}

export function shouldContinueAfterCell(classification) {
  return classification === 'completed' || classification === 'candidate_model_failure' ||
    classification === 'candidate_validation_failure' ||
    classification === 'candidate_governance_failure';
}
