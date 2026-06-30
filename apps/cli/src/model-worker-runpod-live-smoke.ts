import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type LiveSmokeStatus = "skipped" | "completed" | "failed";

type LiveSmokeReport = {
  ok: boolean;
  reportName: string;
  suiteName: string;
  createdAt: string;
  status: LiveSmokeStatus;
  required: boolean;
  missingEnv: string[];
  proxy: {
    host: string;
    port: number;
    llmWorkerUrl: string;
    dllmWorkerUrl: string;
    healthUrl: string;
  };
  upstream: {
    llmConfigured: boolean;
    dllmConfigured: boolean;
    llmModelId: string;
    dllmModelId: string;
  };
  acceptanceExitCode: number | null;
  notes: string[];
  jsonPath: string;
  markdownPath: string;
};

const reportName = "model-worker-runpod-live-smoke-v1";
const suiteName = "runpod-live-model-worker-acceptance";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");
const outputDir = "reports/model-worker-live-smoke";

const host = process.env.MODEL_WORKER_PROXY_HOST ?? "127.0.0.1";
const port = Number(process.env.MODEL_WORKER_PROXY_PORT ?? "8790");
const baseUrl = `http://${host}:${port}`;
const llmWorkerUrl = `${baseUrl}/llm`;
const dllmWorkerUrl = `${baseUrl}/dllm`;
const healthUrl = `${baseUrl}/healthz`;

const required =
  process.env.RUNPOD_LIVE_REQUIRED === "1" ||
  process.env.MODEL_ACCEPTANCE_REQUIRED === "1";

const proxyPath = fileURLToPath(
  new URL("./model-worker-runpod-proxy.js", import.meta.url)
);

const acceptanceReportPath = fileURLToPath(
  new URL("./model-worker-acceptance-report.js", import.meta.url)
);

await main();

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const missingEnv = getMissingEnv();

  if (missingEnv.length > 0) {
    const report = createReport({
      ok: !required,
      status: required ? "failed" : "skipped",
      required,
      missingEnv,
      acceptanceExitCode: null,
      notes: [
        "RunPod live smoke skipped because upstream URL environment variables are not configured.",
        "Set LLM_UPSTREAM_URL and DLLM_UPSTREAM_URL to run live model acceptance.",
        "Set RUNPOD_LIVE_REQUIRED=1 to fail when live upstreams are missing."
      ]
    });

    await writeReport(report);

    if (!report.ok) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          reportName,
          suiteName,
          status: report.status,
          required: report.required,
          missingEnv: report.missingEnv,
          jsonPath: report.jsonPath,
          markdownPath: report.markdownPath
        },
        null,
        2
      )
    );
    return;
  }

  const proxy = spawn(process.execPath, [proxyPath], {
    env: {
      ...process.env,
      MODEL_WORKER_PROXY_HOST: host,
      MODEL_WORKER_PROXY_PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  proxy.stdout?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[runpod-proxy] ${chunk.toString()}`);
  });

  proxy.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[runpod-proxy:err] ${chunk.toString()}`);
  });

  try {
    await waitForHealth(healthUrl, 10000);

    const acceptance = spawn(process.execPath, [acceptanceReportPath], {
      env: {
        ...process.env,
        LLM_WORKER_URL: llmWorkerUrl,
        DLLM_WORKER_URL: dllmWorkerUrl,
        MODEL_ACCEPTANCE_REQUIRED: "1",
        LLM_MODEL_ID: process.env.LLM_MODEL_ID ?? "llm-worker",
        DLLM_MODEL_ID: process.env.DLLM_MODEL_ID ?? "dllm-worker"
      },
      stdio: "inherit"
    });

    const [exitCode] = (await once(acceptance, "exit")) as [number | null];
    const ok = exitCode === 0;

    const report = createReport({
      ok,
      status: ok ? "completed" : "failed",
      required: true,
      missingEnv: [],
      acceptanceExitCode: exitCode,
      notes: ok
        ? [
            "RunPod live smoke completed successfully.",
            "Both LLM and dLLM worker URLs were evaluated through the local proxy.",
            "The model acceptance report was executed with MODEL_ACCEPTANCE_REQUIRED=1."
          ]
        : [
            "RunPod live smoke failed.",
            "Inspect the model-worker-acceptance report and proxy logs for upstream or contract errors."
          ]
    });

    await writeReport(report);

    if (!ok) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          reportName,
          suiteName,
          status: report.status,
          required: report.required,
          acceptanceExitCode: report.acceptanceExitCode,
          jsonPath: report.jsonPath,
          markdownPath: report.markdownPath
        },
        null,
        2
      )
    );
  } finally {
    stopProcess(proxy);
  }
}

function getMissingEnv(): string[] {
  const missing: string[] = [];

  if (!process.env.LLM_UPSTREAM_URL && !process.env.MODEL_WORKER_UPSTREAM_URL) {
    missing.push("LLM_UPSTREAM_URL");
  }

  if (!process.env.DLLM_UPSTREAM_URL && !process.env.MODEL_WORKER_UPSTREAM_URL) {
    missing.push("DLLM_UPSTREAM_URL");
  }

  return missing;
}

function createReport(input: {
  ok: boolean;
  status: LiveSmokeStatus;
  required: boolean;
  missingEnv: string[];
  acceptanceExitCode: number | null;
  notes: string[];
}): LiveSmokeReport {
  const jsonPath = join(
    outputDir,
    `${safeTimestamp}-model-worker-runpod-live-smoke.json`
  );
  const markdownPath = join(
    outputDir,
    `${safeTimestamp}-model-worker-runpod-live-smoke.md`
  );

  return {
    ok: input.ok,
    reportName,
    suiteName,
    createdAt,
    status: input.status,
    required: input.required,
    missingEnv: input.missingEnv,
    proxy: {
      host,
      port,
      llmWorkerUrl,
      dllmWorkerUrl,
      healthUrl
    },
    upstream: {
      llmConfigured: Boolean(process.env.LLM_UPSTREAM_URL ?? process.env.MODEL_WORKER_UPSTREAM_URL),
      dllmConfigured: Boolean(process.env.DLLM_UPSTREAM_URL ?? process.env.MODEL_WORKER_UPSTREAM_URL),
      llmModelId: process.env.LLM_MODEL_ID ?? "llm-worker",
      dllmModelId: process.env.DLLM_MODEL_ID ?? "dllm-worker"
    },
    acceptanceExitCode: input.acceptanceExitCode,
    notes: input.notes,
    jsonPath,
    markdownPath
  };
}

async function writeReport(report: LiveSmokeReport): Promise<void> {
  await writeFile(report.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(report.markdownPath, reportToMarkdown(report));
}

function reportToMarkdown(report: LiveSmokeReport): string {
  const lines: string[] = [];

  lines.push("# RunPod Live Model Worker Smoke");
  lines.push("");
  lines.push(`- Report: \`${report.reportName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Status: \`${report.status}\``);
  lines.push(`- OK: \`${report.ok}\``);
  lines.push(`- Required: \`${report.required}\``);
  lines.push("");

  lines.push("## Proxy");
  lines.push("");
  lines.push(`- Health: \`${report.proxy.healthUrl}\``);
  lines.push(`- LLM worker URL: \`${report.proxy.llmWorkerUrl}\``);
  lines.push(`- dLLM worker URL: \`${report.proxy.dllmWorkerUrl}\``);
  lines.push("");

  lines.push("## Upstream");
  lines.push("");
  lines.push(`- LLM configured: \`${report.upstream.llmConfigured}\``);
  lines.push(`- dLLM configured: \`${report.upstream.dllmConfigured}\``);
  lines.push(`- LLM model ID: \`${report.upstream.llmModelId}\``);
  lines.push(`- dLLM model ID: \`${report.upstream.dllmModelId}\``);
  lines.push("");

  lines.push("## Acceptance");
  lines.push("");
  lines.push(`- Exit code: \`${report.acceptanceExitCode ?? "n/a"}\``);
  lines.push("");

  if (report.missingEnv.length > 0) {
    lines.push("## Missing Environment");
    lines.push("");
    for (const item of report.missingEnv) {
      lines.push(`- \`${item}\``);
    }
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  for (const note of report.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
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
        reject(new Error(`Timed out waiting for proxy health at ${url}`));
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
