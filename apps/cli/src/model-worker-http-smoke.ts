import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { get } from "node:http";

const port = Number(process.env.MODEL_WORKER_MOCK_PORT ?? "8787");
const host = process.env.MODEL_WORKER_MOCK_HOST ?? "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const serverPath = fileURLToPath(new URL("./model-worker-mock-server.js", import.meta.url));
const acceptanceReportPath = fileURLToPath(
  new URL("./model-worker-acceptance-report.js", import.meta.url)
);

await main();

async function main(): Promise<void> {
  const server = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      MODEL_WORKER_MOCK_HOST: host,
      MODEL_WORKER_MOCK_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  server.stdout?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mock-worker] ${chunk.toString()}`);
  });

  server.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mock-worker:err] ${chunk.toString()}`);
  });

  try {
    await waitForHealth(`${baseUrl}/healthz`, 5000);

    const report = spawn(process.execPath, [acceptanceReportPath], {
      env: {
        ...process.env,
        LLM_WORKER_URL: `${baseUrl}/llm`,
        DLLM_WORKER_URL: `${baseUrl}/dllm`,
        MODEL_ACCEPTANCE_REQUIRED: "1",
        LLM_MODEL_ID: process.env.LLM_MODEL_ID ?? "mock-llm-worker",
        DLLM_MODEL_ID: process.env.DLLM_MODEL_ID ?? "mock-dllm-worker"
      },
      stdio: "inherit"
    });

    const [code] = (await once(report, "exit")) as [number | null];

    if (code !== 0) {
      throw new Error(`model worker HTTP smoke failed with exit code ${code}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          smokeName: "model-worker-http-smoke-v1",
          llmWorkerUrl: `${baseUrl}/llm`,
          dllmWorkerUrl: `${baseUrl}/dllm`,
          requiredAcceptance: true
        },
        null,
        2
      )
    );
  } finally {
    stopProcess(server);
  }
}

function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const request = get(url, (response) => {
        response.resume();

        if (response.statusCode === 200) {
          resolve();
          return;
        }

        retry();
      });

      request.on("error", retry);

      request.setTimeout(1000, () => {
        request.destroy();
        retry();
      });
    };

    const retry = (): void => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for mock worker health at ${url}`));
        return;
      }

      setTimeout(attempt, 100);
    };

    attempt();
  });
}

function stopProcess(processToStop: ChildProcess): void {
  if (processToStop.killed) {
    return;
  }

  processToStop.kill("SIGTERM");
}
