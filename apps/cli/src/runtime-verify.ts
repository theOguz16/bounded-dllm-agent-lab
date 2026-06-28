import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type RuntimeVerifyCommand = {
  script: string;
  purpose: string;
};

type RuntimeCommandResult = {
  script: string;
  purpose: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  parsedPayload: unknown | null;
};

type RuntimeVerifyReport = {
  ok: boolean;
  verificationName: string;
  createdAt: string;
  suiteName: string;
  commandCount: number;
  passedCount: number;
  failedCount: number;
  totalDurationMs: number;
  failedScripts: string[];
  commands: RuntimeCommandResult[];
};

const reportDir = "reports/runtime-verification";
const verificationName = "runtime-verify-v1";
const suiteName = "changed-files-repo-orchestrator-remask-repair-safety";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

const commands: RuntimeVerifyCommand[] = [
  {
    script: "repo:changed-files-smoke",
    purpose: "Verify changed-files scoped repo intelligence."
  },
  {
    script: "repo:changed-context-report",
    purpose: "Compare full repo context with changed-files scoped context."
  },
  {
    script: "repo:orchestrator-smoke",
    purpose: "Verify changed-files repo intelligence through orchestrator and merge."
  },
  {
    script: "repo:orchestrator-report",
    purpose: "Generate repo-aware orchestrator report across fixtures."
  },
  {
    script: "remask:repair-smoke",
    purpose: "Verify deterministic remask repair loop on one fixture."
  },
  {
    script: "remask:repair-report",
    purpose: "Generate remask repair report across fixtures."
  },
  {
    script: "remask:repair-safety-smoke",
    purpose: "Verify repair loop blocks unrepairable safety cases."
  },
  {
    script: "remask:repair-safety-report",
    purpose: "Generate repair safety report across fixtures."
  },
  {
    script: "worker:http-mock-contract-smoke",
    purpose: "Verify canonical HTTP worker contract with local mock worker."
  },
  {
    script: "worker:orchestrator-smoke",
    purpose: "Verify worker-backed orchestrator smoke with local mock worker."
  }
];

await runVerification();

async function runVerification(): Promise<void> {
  await mkdir(reportDir, {
    recursive: true
  });

  const startedAt = Date.now();
  const results: RuntimeCommandResult[] = [];

  for (const command of commands) {
    console.log(`\n[runtime:verify] Running ${command.script}`);
    console.log(`[runtime:verify] ${command.purpose}\n`);

    const result = await runNpmScript(command);

    results.push(result);

    if (!result.ok) {
      console.error(`\n[runtime:verify] FAILED ${command.script}`);
      break;
    }

    console.log(`\n[runtime:verify] PASSED ${command.script}`);
  }

  const totalDurationMs = Date.now() - startedAt;
  const failedScripts = results
    .filter((result) => !result.ok)
    .map((result) => result.script);

  const report: RuntimeVerifyReport = {
    ok: failedScripts.length === 0 && results.length === commands.length,
    verificationName,
    createdAt,
    suiteName,
    commandCount: commands.length,
    passedCount: results.filter((result) => result.ok).length,
    failedCount: failedScripts.length,
    totalDurationMs,
    failedScripts,
    commands: results
  };

  const jsonPath = join(reportDir, `${safeTimestamp}-runtime-verify.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-runtime-verify.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, reportToMarkdown(report));

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        verificationName,
        suiteName,
        commandCount: report.commandCount,
        passedCount: report.passedCount,
        failedCount: report.failedCount,
        totalDurationMs: report.totalDurationMs,
        failedScripts: report.failedScripts,
        jsonPath,
        markdownPath
      },
      null,
      2
    )
  );

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function runNpmScript(
  command: RuntimeVerifyCommand
): Promise<RuntimeCommandResult> {
  const startedAt = Date.now();
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return new Promise((resolve) => {
    const child = spawn(npmCommand, ["run", command.script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      const durationMs = Date.now() - startedAt;

      resolve({
        script: command.script,
        purpose: command.purpose,
        ok: false,
        exitCode: null,
        signal: null,
        durationMs,
        stdoutTail: "",
        stderrTail: String(error),
        parsedPayload: null
      });
    });

    child.on("close", (exitCode, signal) => {
      const durationMs = Date.now() - startedAt;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      resolve({
        script: command.script,
        purpose: command.purpose,
        ok: exitCode === 0,
        exitCode,
        signal,
        durationMs,
        stdoutTail: tail(stdout, 5000),
        stderrTail: tail(stderr, 5000),
        parsedPayload: extractJsonPayload(stdout)
      });
    });
  });
}

function extractJsonPayload(stdout: string): unknown | null {
  const lines = stdout.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().startsWith("{"));

  if (startIndex === -1) {
    return null;
  }

  const candidate = lines.slice(startIndex).join("\n").trim();

  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function reportToMarkdown(report: RuntimeVerifyReport): string {
  const lines: string[] = [];

  lines.push(`# Runtime Verification Report`);
  lines.push("");
  lines.push(`- Verification: \`${report.verificationName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- OK: \`${report.ok}\``);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Commands | ${report.commandCount} |`);
  lines.push(`| Passed | ${report.passedCount} |`);
  lines.push(`| Failed | ${report.failedCount} |`);
  lines.push(`| Total duration ms | ${report.totalDurationMs} |`);
  lines.push("");

  lines.push(`## Commands`);
  lines.push("");
  lines.push(`| Script | Status | Duration ms | Purpose |`);
  lines.push(`| --- | --- | ---: | --- |`);

  for (const result of report.commands) {
    lines.push(
      `| \`${escapeMarkdownCell(result.script)}\` | ${result.ok ? "passed" : "failed"} | ${result.durationMs} | ${escapeMarkdownCell(result.purpose)} |`
    );
  }

  lines.push("");

  if (report.failedScripts.length) {
    lines.push(`## Failed Scripts`);
    lines.push("");

    for (const script of report.failedScripts) {
      lines.push(`- \`${script}\``);
    }

    lines.push("");
  }

  lines.push(`## Parsed Payloads`);
  lines.push("");

  for (const result of report.commands) {
    lines.push(`### \`${result.script}\``);
    lines.push("");
    lines.push(`- Status: \`${result.ok ? "passed" : "failed"}\``);
    lines.push(`- Duration ms: \`${result.durationMs}\``);
    lines.push("");

    if (result.parsedPayload) {
      lines.push("```json");
      lines.push(JSON.stringify(result.parsedPayload, null, 2));
      lines.push("```");
    } else {
      lines.push("_No JSON payload parsed._");
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return value.slice(value.length - maxChars);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
}