import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

type VerificationCommand = {
  id: string;
  script: string;
  description: string;
  requiredChecks?: Array<{
    path: string;
    expected?: unknown;
    min?: number;
  }>;
};

type VerificationCommandResult = {
  id: string;
  script: string;
  description: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutPreview: string;
  stderrPreview: string;
  parsedOutput: unknown | null;
  failures: string[];
};

type RealRepoVerificationReport = {
  ok: boolean;
  verificationName: string;
  suiteName: string;
  createdAt: string;
  commandCount: number;
  passedCount: number;
  failedCount: number;
  totalDurationMs: number;
  failedScripts: string[];
  commands: VerificationCommandResult[];
};

const verificationName = "real-repo-verify-v1";
const suiteName = "phase-k-real-repo-pr-model-free-verification";
const reportDir = "reports/real-repo-evaluation";
const createdAt = new Date().toISOString();
const safeTimestamp = createdAt.replace(/[:.]/g, "-");

const commands: VerificationCommand[] = [
  {
    id: "real_diff_smoke",
    script: "real:diff-smoke",
    description: "Verify git diff adapter, changed files extraction, and changed-files scoped repo intelligence."
  },
  {
    id: "real_evaluation_report",
    script: "real:evaluation-report",
    description: "Generate model-free real repo evaluation report across remask fixtures."
  },
  {
    id: "real_control_report",
    script: "real:control-report",
    description: "Verify positive and negative real diff control cases.",
    requiredChecks: [
      { path: "ok", expected: true },
      { path: "expectedOutcomeAccuracy", expected: 1 },
      { path: "positivePassRate", expected: 1 },
      { path: "negativeDetectionRate", expected: 1 }
    ]
  },
  {
    id: "pr_changed_files_smoke",
    script: "pr:changed-files-smoke",
    description: "Verify GitHub-style PR changed files input adapter."
  },
  {
    id: "pr_evaluation_report",
    script: "pr:evaluation-report",
    description: "Generate model-free PR input evaluation report across remask fixtures."
  },
  {
    id: "real_safety_regression",
    script: "real:safety-regression",
    description: "Verify real diff and PR safety regression scenarios.",
    requiredChecks: [
      { path: "ok", expected: true },
      { path: "expectedOutcomeAccuracy", expected: 1 },
      { path: "positivePassRate", expected: 1 },
      { path: "negativeDetectionRate", expected: 1 },
      { path: "repairBlockedRate", min: 0.8 }
    ]
  }
];

await runVerification();

async function runVerification(): Promise<void> {
  await mkdir(reportDir, { recursive: true });

  const startedAt = Date.now();
  const results: VerificationCommandResult[] = [];

  for (const command of commands) {
    console.log(`[real:verify] Running ${command.script}`);
    console.log(`[real:verify] ${command.description}`);

    const result = runCommand(command);
    results.push(result);

    if (!result.ok) {
      console.error(`[real:verify] FAILED ${command.script}`);
      console.error(result.failures.join("\n"));
      break;
    }

    console.log(`[real:verify] PASSED ${command.script}`);
  }

  const totalDurationMs = Date.now() - startedAt;
  const failedScripts = results.filter((result) => !result.ok).map((result) => result.script);
  const report: RealRepoVerificationReport = {
    ok: failedScripts.length === 0 && results.length === commands.length,
    verificationName,
    suiteName,
    createdAt,
    commandCount: commands.length,
    passedCount: results.filter((result) => result.ok).length,
    failedCount: failedScripts.length,
    totalDurationMs,
    failedScripts,
    commands: results
  };

  const jsonPath = join(reportDir, `${safeTimestamp}-real-repo-verify.json`);
  const markdownPath = join(reportDir, `${safeTimestamp}-real-repo-verify.md`);

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

function runCommand(command: VerificationCommand): VerificationCommandResult {
  const startedAt = Date.now();
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const child = spawnSync(npmCommand, ["run", "--silent", command.script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  const durationMs = Date.now() - startedAt;
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const parsedOutput = parseJsonObject(stdout);
  const failures: string[] = [];

  if (child.error) {
    failures.push(`Process error: ${formatError(child.error)}`);
  }

  if (child.status !== 0) {
    failures.push(`Command exited with status ${child.status}.`);
  }

  if (!parsedOutput || typeof parsedOutput !== "object") {
    failures.push("Command did not emit parseable JSON output.");
  }

  if (parsedOutput && typeof parsedOutput === "object") {
    const okValue = getPath(parsedOutput, "ok");
    if (okValue !== true) {
      failures.push(`Expected output.ok to be true, received ${JSON.stringify(okValue)}.`);
    }

    for (const check of command.requiredChecks ?? []) {
      const actual = getPath(parsedOutput, check.path);

      if ("expected" in check && actual !== check.expected) {
        failures.push(
          `Expected ${check.path} to equal ${JSON.stringify(check.expected)}, received ${JSON.stringify(actual)}.`
        );
      }

      if ("min" in check) {
        const min = check.min;

        if (typeof min !== "number") {
          failures.push(`Invalid verification check for ${check.path}: min is not a number.`);
        } else if (typeof actual !== "number" || actual < min) {
          failures.push(
            `Expected ${check.path} to be >= ${min}, received ${JSON.stringify(actual)}.`
          );
        }
      }
    }
  }

  return {
    id: command.id,
    script: command.script,
    description: command.description,
    ok: failures.length === 0,
    exitCode: child.status,
    durationMs,
    stdoutPreview: compact(stdout, 1200),
    stderrPreview: compact(stderr, 1200),
    parsedOutput,
    failures
  };
}

function parseJsonObject(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Bazı ortamlarda npm veya node uyarısı JSON'un önüne/arkasına yazılabilir.
    // Bu fallback ilk "{" ile son "}" arasını parse etmeyi dener.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");

    if (first === -1 || last === -1 || last <= first) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function getPath(value: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = value;

  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function reportToMarkdown(report: RealRepoVerificationReport): string {
  const lines: string[] = [];

  lines.push(`# Real Repo Verification Report`);
  lines.push("");
  lines.push(`- Verification: \`${report.verificationName}\``);
  lines.push(`- Suite: \`${report.suiteName}\``);
  lines.push(`- Created at: \`${report.createdAt}\``);
  lines.push(`- Overall: **${report.ok ? "PASS" : "FAIL"}**`);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Commands | ${report.commandCount} |`);
  lines.push(`| Passed | ${report.passedCount} |`);
  lines.push(`| Failed | ${report.failedCount} |`);
  lines.push(`| Duration ms | ${report.totalDurationMs} |`);
  lines.push("");

  lines.push(`## Commands`);
  lines.push("");
  lines.push(`| Script | Status | Duration ms | Description | Failures |`);
  lines.push(`| --- | --- | ---: | --- | --- |`);

  for (const command of report.commands) {
    lines.push(
      `| \`${escapeMarkdownCell(command.script)}\` | ${command.ok ? "PASS" : "FAIL"} | ${command.durationMs} | ${escapeMarkdownCell(command.description)} | ${escapeMarkdownCell(command.failures.join("; ") || "(none)")} |`
    );
  }

  lines.push("");

  if (report.failedScripts.length > 0) {
    lines.push(`## Failed Scripts`);
    lines.push("");
    for (const script of report.failedScripts) {
      lines.push(`- \`${script}\``);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
