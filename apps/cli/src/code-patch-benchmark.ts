import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  codePatchReportToMarkdown,
  nanoidCodePatchCases,
  runCodePatchBenchmark,
  validateCodePatchCases
} from "../../../packages/code-benchmark/src/index.js";

const repoPath = process.env.CODE_BENCH_REPO_PATH ?? "benchmarks/repos/nanoid";
const workRoot = process.env.CODE_BENCH_WORK_ROOT ?? "reports/code-patch-workspaces";
const reportDir = "reports";
const failures = validateCodePatchCases(nanoidCodePatchCases);

if (failures.length) {
  throw new Error(JSON.stringify({ ok: false, failures }, null, 2));
}

const report = await runCodePatchBenchmark({
  repoPath,
  workRoot,
  cases: nanoidCodePatchCases
});
const runId = `${report.createdAt.replace(/[:.]/g, "-")}-code-patch-benchmark`;
const jsonPath = join(reportDir, `${runId}.json`);
const markdownPath = join(reportDir, `${runId}.md`);

await mkdir(reportDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(markdownPath, `${codePatchReportToMarkdown(report)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      repoPath,
      caseCount: report.caseCount,
      jsonPath,
      markdownPath,
      summary: {
        testPassRate: report.testPassRate,
        allowedFileAccuracy: report.allowedFileAccuracy,
        expectedFileCoverage: report.expectedFileCoverage,
        forbiddenFileTouchRate: report.forbiddenFileTouchRate,
        forbiddenPatternHitRate: report.forbiddenPatternHitRate,
        refusalAccuracy: report.refusalAccuracy
      }
    },
    null,
    2
  )
);
