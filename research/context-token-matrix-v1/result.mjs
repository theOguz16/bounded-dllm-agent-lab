import { EXPERIMENT_SCHEMA, VARIANTS, createResearchConfig } from './policy.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const numberOrNull = value => integer(value) ? value : null;
const safeArray = value => Array.isArray(value) ? value : [];
function requireValue(ok, message) { if (!ok) throw new Error(`research_result_invalid: ${message}`); }
function uniqueStrings(values) {
  requireValue(Array.isArray(values) && values.every(v => typeof v === 'string'), 'file list');
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}
function observation(raw, operation) {
  if (!raw) return null;
  const input = raw.reported === true ? numberOrNull(raw.cumulativeInputTokens) : null;
  const output = raw.reported === true ? numberOrNull(raw.outputTokens) : null;
  const cachedCandidate = raw.reported === true ? numberOrNull(raw.cumulativeCachedInputTokens) : null;
  const cached = input !== null && cachedCandidate !== null && cachedCandidate <= input ? cachedCandidate : null;
  const initial = numberOrNull(raw.initialPromptEstimatedTokens);
  const turns = raw.reported === true ? numberOrNull(raw.providerTurnCount) : null;
  const tools = raw.reported === true ? numberOrNull(raw.toolCallCount) : null;
  return Object.freeze({ operation, initialPromptEstimatedTokens: initial,
    cumulativeInputTokens: input, cumulativeCachedInputTokens: cached,
    cumulativeUncachedInputTokens: cached === null ? null : input - cached,
    outputTokens: output, providerTurnCount: turns, toolCallCount: tools,
    provenance: Object.freeze({ initialPromptEstimatedTokens: initial === null ? 'unavailable' : 'estimated',
      cumulativeInputTokens: input === null ? 'unavailable' : 'observed',
      cumulativeCachedInputTokens: cached === null ? 'unavailable' : 'observed',
      cumulativeUncachedInputTokens: cached === null ? 'unavailable' : 'derived',
      outputTokens: output === null ? 'unavailable' : 'observed',
      providerTurnCount: turns === null ? 'unavailable' : 'observed',
      toolCallCount: tools === null ? 'unavailable' : 'observed' }) });
}
function aggregate(tokens, observations, providerCalls) {
  const completeObservations = integer(providerCalls) && providerCalls === observations.length;
  const hasObservedUsage = completeObservations && observations.every(o =>
    o && o.cumulativeInputTokens !== null && o.outputTokens !== null);
  const sum = key => observations.reduce((amount, item) => amount + item[key], 0);
  const input = hasObservedUsage ? sum('cumulativeInputTokens') : numberOrNull(tokens?.input);
  const cachedValue = hasObservedUsage && observations.every(o => o.cumulativeCachedInputTokens !== null)
    ? sum('cumulativeCachedInputTokens') : hasObservedUsage ? null : numberOrNull(tokens?.cached);
  const cached = input !== null && cachedValue !== null && cachedValue <= input ? cachedValue : null;
  const output = hasObservedUsage ? sum('outputTokens') : numberOrNull(tokens?.output);
  const reportedTotal = numberOrNull(tokens?.total);
  const total = hasObservedUsage ? input + output : input !== null && output !== null &&
    reportedTotal === input + output ? reportedTotal : null;
  const sumIfKnown = key => completeObservations && observations.every(o => o && o[key] !== null)
    ? observations.reduce((sum, o) => sum + o[key], 0) : null;
  return Object.freeze({ input, cached, uncached: cached === null ? null : input - cached,
    output, total, providerCalls: numberOrNull(providerCalls),
    totalTurns: sumIfKnown('providerTurnCount'), totalToolCalls: sumIfKnown('toolCallCount'),
    aggregationSemantics: hasObservedUsage ? 'derived_sum_of_observed_operations' :
      tokens?.aggregation ?? 'available_task_output_totals',
    provenance: Object.freeze({ input: input === null ? 'unavailable' : hasObservedUsage ? 'derived' : 'observed',
      cached: cached === null ? 'unavailable' : hasObservedUsage ? 'derived' : 'observed',
      uncached: cached === null ? 'unavailable' : 'derived',
      output: output === null ? 'unavailable' : hasObservedUsage ? 'derived' : 'observed',
      total: total === null ? 'unavailable' : hasObservedUsage ? 'derived' : 'observed',
      providerCalls: integer(providerCalls) ? 'observed' : 'unavailable',
      totalTurns: sumIfKnown('providerTurnCount') === null ? 'unavailable' : 'derived',
      totalToolCalls: sumIfKnown('toolCallCount') === null ? 'unavailable' : 'derived' }) });
}
function expansionRecord(value) {
  const requested = numberOrNull(value?.requested);
  const granted = numberOrNull(value?.granted);
  requireValue(requested === null || granted === null || granted <= requested, 'expansion count');
  return Object.freeze({ requested, granted, tokens: numberOrNull(value?.tokens),
    bytes: numberOrNull(value?.bytes), provenance: Object.freeze({
      requested: requested === null ? 'unavailable' : 'observed',
      granted: granted === null ? 'unavailable' : 'observed',
      tokens: integer(value?.tokens) ? 'observed' : 'unavailable',
      bytes: integer(value?.bytes) ? 'observed' : 'unavailable' }) });
}

/** Build a bounded, prompt-free research record from an existing task result. */
export function createExperimentResult({ config, runId, selectedContext, codexOutput,
  validationProfile = null, validationSpecificationHash = null,
  validationDetail = null, expansion = null, providerCalls = null, timing = null }) {
  requireValue(config?.schemaVersion === EXPERIMENT_SCHEMA && VARIANTS.includes(config.variant) &&
    typeof runId === 'string' && runId.length > 0 && runId.length <= 128 &&
    typeof codexOutput?.taskId === 'string' && codexOutput.taskId.length > 0 &&
    typeof codexOutput.decision === 'string' && typeof codexOutput.route === 'string', 'identity or decision');
  requireValue((codexOutput.model === undefined || codexOutput.model === config.model) &&
    (codexOutput.reasoning === undefined || codexOutput.reasoning === config.reasoning), 'model or reasoning drift');
  requireValue(selectedContext?.config === config && Array.isArray(selectedContext.selectedFiles) &&
    integer(selectedContext.selectedFileCount) && integer(selectedContext.selectedBytes), 'selected context');
  requireValue(validationProfile === null || typeof validationProfile === 'string', 'validation profile');
  requireValue(validationSpecificationHash === null || /^sha256:[0-9a-f]{64}$/.test(validationSpecificationHash), 'validation hash');
  const changedFiles = uniqueStrings(codexOutput.candidate?.files ?? []);
  const allowed = new Set(config.allowedFiles);
  const scopeViolations = changedFiles.filter(p => !allowed.has(p));
  const raw = safeArray(codexOutput.tokens?.tokenObservability);
  const planner = observation(raw.find(x => x?.operation === 'planner'), 'planner');
  const coder = observation(raw.find(x => x?.operation === 'coder'), 'coder');
  const contextExpansion = raw.filter(x => x?.operation === 'expansion')
    .map(x => observation(x, 'expansion'));
  const known = [planner, coder, ...contextExpansion].filter(Boolean);
  const status = codexOutput.decision === 'bounded_task_completed' ? 'completed'
    : codexOutput.decision === 'bounded_task_stopped' ? 'stopped' : 'failed';
  const validation = codexOutput.validation ?? {};
  const elapsed = timing ?? {};
  return Object.freeze({ schemaVersion: EXPERIMENT_SCHEMA, runId,
    task: Object.freeze({ taskId: codexOutput.taskId, taskHash: config.taskHash,
      sourceHead: config.sourceHead, experimentId: config.experimentId }),
    configuration: config,
    validationConfiguration: Object.freeze({ profile: validationProfile,
      specificationHash: validationSpecificationHash }),
    outcome: Object.freeze({ status, decision: codexOutput.decision, route: codexOutput.route,
      validation: Object.freeze({ scope: validation.scope ?? null,
        syntax: validationDetail?.syntax ?? validation.syntax ?? null,
        typecheck: validation.typecheck ?? null, tests: validation.tests ?? null }),
      behavior: validation.behavior ?? null, candidateChangedFiles: Object.freeze(changedFiles),
      scopeViolations: Object.freeze(scopeViolations),
      sourceRepositoryUnchanged: codexOutput.sourceRepositoryUnchanged === true ? true
        : codexOutput.sourceRepositoryUnchanged === false ? false : null }),
    context: Object.freeze({ variant: config.variant,
      selectedFiles: Object.freeze([...selectedContext.selectedFiles]),
      selectedContentHashes: Object.freeze(selectedContext.initialEvidence.map(e =>
        Object.freeze({ path: e.path, contentHash: e.contentHash }))),
      intelligenceHash: selectedContext.intelligenceHash,
      selectedFileCount: selectedContext.selectedFileCount, selectedBytes: selectedContext.selectedBytes,
      initialPromptEstimatedTokens: coder?.initialPromptEstimatedTokens ?? null,
      initialPromptProvenance: coder?.provenance.initialPromptEstimatedTokens ?? 'unavailable',
      expansion: expansionRecord(expansion) }),
    usage: Object.freeze({ planner, coder, contextExpansion: Object.freeze(contextExpansion),
      aggregate: aggregate(codexOutput.tokens, known, providerCalls) }),
    timing: Object.freeze({ taskElapsedMs: numberOrNull(elapsed.taskElapsedMs),
      plannerElapsedMs: numberOrNull(elapsed.plannerElapsedMs),
      coderElapsedMs: numberOrNull(elapsed.coderElapsedMs),
      validationElapsedMs: numberOrNull(elapsed.validationElapsedMs) }) });
}

export function validateExperimentResult(value) {
  requireValue(value?.schemaVersion === EXPERIMENT_SCHEMA && VARIANTS.includes(value.context?.variant) &&
    value.configuration?.variant === value.context.variant &&
    value.configuration?.schemaVersion === EXPERIMENT_SCHEMA &&
    typeof value.runId === 'string' && typeof value.task?.taskHash === 'string' &&
    typeof value.task?.sourceHead === 'string' &&
    ['completed', 'stopped', 'failed'].includes(value.outcome?.status) &&
    Array.isArray(value.context?.selectedFiles) &&
    value.context.selectedFiles.length === value.context.selectedFileCount &&
    Array.isArray(value.context.selectedContentHashes) &&
    value.context.selectedContentHashes.length === value.context.selectedFileCount &&
    /^sha256:[0-9a-f]{64}$/.test(value.context.intelligenceHash) &&
    integer(value.context.selectedBytes) && Array.isArray(value.outcome?.candidateChangedFiles), 'schema');
  const expected = createResearchConfig(value.configuration);
  requireValue(JSON.stringify(value.configuration.effectivePolicy) ===
    JSON.stringify(expected.effectivePolicy), 'effective policy');
  const u = value.usage?.aggregate;
  requireValue(u && (u.input === null || integer(u.input)) &&
    (u.cached === null || integer(u.cached) && u.input !== null && u.cached <= u.input) &&
    (u.uncached === null || u.cached !== null && u.uncached === u.input - u.cached), 'aggregate usage');
  return value;
}
