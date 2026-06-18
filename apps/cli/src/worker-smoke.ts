import {
  isHealthResponse,
  isInfillResponse,
  isResolveConflictResponse
} from "../../../packages/worker-contract/src/index.js";
import { createWorkspace } from "../../../packages/workspace-core/src/index.js";
import { demoFixtures } from "../../../packages/fixtures/src/index.js";

const baseUrl = process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765";
const workspace = createWorkspace("worker-smoke-workspace", demoFixtures[0].packet);

const health = await getJson(`${baseUrl}/health`);
if (!isHealthResponse(health)) {
  throw new Error("Worker health response did not match the contract.");
}

// Smoke testi benchmark değildir; worker'ın model kalitesini ölçmez. Amacı TS ve
// Python arasında beklediğimiz endpoint sözleşmelerinin gerçekten çalıştığını
// göstermektir. Bu yüzden küçük, deterministik ve hızlı tutulur.
const infill = await postJson(`${baseUrl}/infill`, {
  requestId: "worker-smoke-infill",
  view: "implementer",
  workspace,
  region: "patch_intent",
  prompt: "Fill the patch intent for the masked workspace region."
});
if (!isInfillResponse(infill)) {
  throw new Error("Worker infill response did not match the contract.");
}

const conflict = await postJson(`${baseUrl}/resolve-conflict`, {
  requestId: "worker-smoke-conflict",
  workspace,
  conflictId: "conflict-smoke-001"
});
if (!isResolveConflictResponse(conflict)) {
  throw new Error("Worker conflict response did not match the contract.");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      worker: health.workerName,
      checked: ["/health", "/infill", "/resolve-conflict"],
      infillRegion: infill.region,
      conflictId: conflict.conflictId
    },
    null,
    2
  )
);

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return response.json();
}
