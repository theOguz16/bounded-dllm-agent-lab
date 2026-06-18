import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import { defaultMaskingPolicy, applyMaskingPolicy } from "../../../packages/masking-policy/src/index.js";
import { scoreCase, aggregateScores } from "../../../packages/eval-core/src/index.js";
import { demoFixtures, validateFixtures } from "../../../packages/fixtures/src/index.js";
import { MockDllmEngine } from "../../../packages/providers/src/index.js";

const engine = new MockDllmEngine();
const scores = [];
const fixtureFailures = validateFixtures(demoFixtures);

// The CLI fails fast when fixtures are invalid. That matters because a benchmark
// with broken input can make a model look better or worse for the wrong reason.
if (fixtureFailures.length) {
  throw new Error(JSON.stringify({ ok: false, fixtureFailures }, null, 2));
} else {
  for (const fixture of demoFixtures) {
    const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
    const masked = applyMaskingPolicy(workspace, defaultMaskingPolicy("boundary"));
    const result = await engine.refineWorkspace(masked);
    scores.push(scoreCase(fixture.case, result.workspace));
  }

  console.log(JSON.stringify(aggregateScores(scores), null, 2));
}
