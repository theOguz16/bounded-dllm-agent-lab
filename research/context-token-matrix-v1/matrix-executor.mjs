import fs from 'node:fs';
import path from 'node:path';

function gate(ok, reason) { if (!ok) throw Error(`matrix_executor_invalid: ${reason}`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }

/** A plan may require actual interval coverage before another observation is reserved. */
export function meetsTelemetryValidity(requirement, observation) {
  if (requirement === undefined) return true;
  const sample = observation?.telemetryValidity;
  if (sample?.schemaVersion !== requirement.schemaVersion ||
      !['observed', 'partial'].includes(sample.status) || sample.truncated === true ||
      !Number.isSafeInteger(sample.toolEvents) || sample.toolEvents <= 0 ||
      !Number.isSafeInteger(sample.usableIntervals) || sample.usableIntervals < 0 ||
      sample.usableIntervals > sample.toolEvents) return false;
  const requiredCount = Math.ceil(sample.toolEvents * requirement.minimumUsableIntervalFraction);
  if (sample.usableIntervals < requiredCount) return false;
  return requirement.requiredFields.every(field =>
    Number.isSafeInteger(sample.fieldCoverage?.[field]) &&
    sample.fieldCoverage[field] >= requiredCount &&
    sample.fieldCoverage[field] <= sample.toolEvents);
}

/** Structural matrix loop. The callback owns context, provider execution, Candidate and oracle semantics. */
export async function executeOrderedMatrix({ plan, planHash, sessionId, slots, sessionRoot,
  beforeSlot = async () => {}, executeObservation, mayContinue }) {
  gate(typeof planHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(planHash),
    'plan hash');
  gate(slots.length === plan.orderedSlots.length &&
    slots.length <= plan.limits.maxObservations &&
    slots.every((slot, index) => same(Object.fromEntries(
      Object.keys(plan.orderedSlots[index]).map(key => [key, slot[key]])),
      plan.orderedSlots[index]) &&
      slot.sessionId === sessionId), 'ordered slots');
  gate(plan.policy.retry === 0 && plan.policy.repair === 0 && plan.policy.apply === 0,
    'nonzero mutation or retry policy');
  gate(!fs.existsSync(sessionRoot), 'session reuse');
  fs.mkdirSync(sessionRoot, { mode: 0o700 });
  save(path.join(sessionRoot, 'execution-plan.snapshot.json'), plan);
  const observations = [];
  const reserved = new Set();
  const perSlot = new Map();
  let calls = 0;
  let stop = null;
  const budget = {
    reserveObservation(identity) {
      gate(!reserved.has(identity) && reserved.size < plan.limits.maxObservations,
        'observation ceiling or replay');
      reserved.add(identity);
    },
    recordInvocation(identity) {
      gate(reserved.has(identity) && (perSlot.get(identity) ?? 0) <
        plan.limits.maxProviderStagesPerObservation && calls < plan.limits.maxProviderStages,
      'provider-stage ceiling');
      perSlot.set(identity, (perSlot.get(identity) ?? 0) + 1); calls++;
    },
    snapshot() { return { observations: reserved.size, providerStageInvocations: calls }; }
  };
  for (const slot of slots) {
    try {
      await beforeSlot(slot);
      budget.reserveObservation(slot.observationId);
      save(path.join(sessionRoot, `reservation-${slot.position}.json`), slot);
      const result = await executeObservation(slot, budget);
      gate(result?.observationId === slot.observationId &&
        result?.position === slot.position && result?.replicate === slot.replicate &&
        result?.variant === slot.variant &&
        Object.keys(plan.orderedSlots[slot.position - 1]).every(key =>
          same(result?.[key], slot[key])), 'observation result identity');
      observations.push(result);
      if (!mayContinue(result.classification)) { stop = result.classification; break; }
      if (!meetsTelemetryValidity(plan.telemetryValidity, result)) {
        stop = 'telemetry_unusable'; break;
      }
    } catch (error) {
      stop = `infrastructure_or_ambiguous: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  const report = { schemaVersion: 'context-matrix-stage-summary/v1', sessionId, planHash,
    stage: plan.stage, observations, stop, budget: budget.snapshot(),
    providerModelCalls: calls };
  save(path.join(sessionRoot, `${plan.stage}-summary.json`), report);
  return { sessionRoot, ...report };
}
