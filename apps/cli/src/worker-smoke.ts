import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import {
  remaskFixtures,
  validateFixtures
} from "../../../packages/fixtures/src/index.js";
import {
  createHttpWorkspaceWorkerClient
} from "../../../packages/worker-contract/src/index.js";

const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8765";

const fixtureFailures = validateFixtures(remaskFixtures, {
  expectedFamilyCount: undefined
});

if (fixtureFailures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Fixture validation failed before worker smoke.",
        fixtureFailures
      },
      null,
      2
    )
  );
}

const fixture = remaskFixtures[0];

if (!fixture) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "No fixture found for worker smoke."
      },
      null,
      2
    )
  );
}

const workspace = createWorkspaceFromPacket(fixture.packet, {
  id: `worker-smoke-${fixture.case.id}`
});

const client = createHttpWorkspaceWorkerClient({
  baseUrl: workerUrl,
  timeoutMs: 60_000
});

const health = await client.health();

const infill = await client.infill({
  requestId: "worker-smoke-infill",
  region: "patch_intent",
  prompt: "Fill the bounded patch intent region with a minimal safe output."
});

const conflict = await client.resolveConflict({
  requestId: "worker-smoke-resolve-conflict",
  conflictId: "worker-smoke-conflict",
  workspace
});

console.log(
  JSON.stringify(
    {
      ok: true,
      smokeName: "worker-smoke",
      workerUrl,
      summary: {
        worker: health.workerName,
        mode: health.mode,
        infillRegion: infill.region,
        conflictId: conflict.conflictId,
        engineNames: {
          infill: infill.engineName,
          resolveConflict: conflict.engineName
        }
      }
    },
    null,
    2
  )
);