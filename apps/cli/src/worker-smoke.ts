import {
  isHealthResponse,
  isInfillResponse,
  isResolveConflictResponse
} from "../../../packages/worker-contract/src/index.js";
import { createWorkspaceFromPacket } from "../../../packages/context-core/src/workspace-adapter.js";
import { demoFixtures } from "../../../packages/fixtures/src/index.js";

const baseUrl = process.env.DLLM_WORKER_URL ?? "http://127.0.0.1:8765";

const fixture = demoFixtures[0];

if (!fixture) {
  throw new Error("worker-smoke requires at least one demo fixture.");
}

/**
 * workspace-core artık createWorkspace(id, packet) desteklemiyor.
 * Packet -> canonical workspace dönüşümü bilinçli olarak context-core adapter
 * üzerinden yapılıyor.
 */
const workspace = createWorkspaceFromPacket(fixture.packet, {
  id: `worker-smoke-${fixture.case.id}`
});

const health = await getJson(`${baseUrl}/health`);

if (!isHealthResponse(health)) {
  throw new Error("Worker health response did not match the contract.");
}

/**
 * Smoke testi benchmark değildir; worker'ın model kalitesini ölçmez.
 * Amacı TS ve Python arasında beklediğimiz endpoint sözleşmelerinin gerçekten
 * çalıştığını göstermektir.
 *
 * Eski view "implementer" idi. Yeni canonical mimaride implementer yok.
 * Patch üretim/refine işi coder view üzerinden temsil edilir.
 */
const infill = await postJson(`${baseUrl}/infill`, {
  requestId: "worker-smoke-infill",
  view: "coder",
  workspace,
  region: "patch_draft",
  prompt: "Fill the patch draft for the masked workspace region."
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