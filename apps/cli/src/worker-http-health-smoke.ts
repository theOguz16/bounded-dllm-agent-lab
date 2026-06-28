import {
  createHttpWorkspaceWorkerClient
} from "../../../packages/worker-contract/src/index.js";

const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:8765";
const workerApiKey = process.env.WORKER_API_KEY;
const timeoutMs = parseNumberEnv(process.env.WORKER_TIMEOUT_MS) ?? 60_000;

const client = createHttpWorkspaceWorkerClient({
  baseUrl: workerUrl,
  apiKey: workerApiKey,
  timeoutMs
});

const health = await client.health();

const failures = validateHealth();

if (failures.length) {
  throw new Error(
    JSON.stringify(
      {
        ok: false,
        reason: "Worker HTTP health smoke failed.",
        failures,
        workerUrl,
        health
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      smokeName: "worker-http-health-smoke",
      workerUrl,
      summary: {
        health
      }
    },
    null,
    2
  )
);

function validateHealth(): string[] {
  const failures: string[] = [];

  if (!health.ok) {
    failures.push("Expected health.ok=true.");
  }

  if (typeof health.workerName !== "string" || health.workerName.length === 0) {
    failures.push("Expected health.workerName to be a non-empty string.");
  }

  if (typeof health.mode !== "string" || health.mode.length === 0) {
    failures.push("Expected health.mode to be a non-empty string.");
  }

  return failures;
}

function parseNumberEnv(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}