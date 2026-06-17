import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import { defaultMaskingPolicy, applyMaskingPolicy } from "../../../packages/masking-policy/src/index.js";
import { scoreCase, aggregateScores } from "../../../packages/eval-core/src/index.js";
import { demoFixtures } from "../../../packages/fixtures/src/index.js";
import { MockDllmEngine } from "../../../packages/providers/src/index.js";

const engine = new MockDllmEngine();
const scores = [];

for (const fixture of demoFixtures) {
  const workspace = createWorkspace(`workspace-${fixture.case.id}`, fixture.packet);
  const masked = applyMaskingPolicy(workspace, defaultMaskingPolicy("boundary"));
  const result = await engine.refineWorkspace(masked);
  scores.push(scoreCase(fixture.case, result.workspace));
}

console.log(JSON.stringify(aggregateScores(scores), null, 2));

