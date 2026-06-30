import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<FetchResponse>;

type GithubFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
};

const reportName = "github-live-pr-fetch-v1";
const outputDir = "reports/github-pr-live";
const outputPath = join(outputDir, "live-pr-input.json");

main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reportName,
        status: "failed",
        failureReason: error instanceof Error ? error.message : "unknown_error"
      },
      null,
      2
    )
  );
  process.exit(1);
});

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const required = isTruthy(process.env.GITHUB_PR_FETCH_REQUIRED);
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const prNumber = resolvePrNumber();

  if (!repository || !token || !prNumber) {
    const report = {
      ok: !required,
      reportName,
      status: required ? "failed" : "skipped",
      reason: "missing_github_pr_context",
      repository: repository || null,
      pullRequestNumber: prNumber,
      hasToken: Boolean(token),
      outputPath
    };

    if (required) {
      console.error(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const fetchFn = (globalThis as typeof globalThis & { fetch?: FetchFn }).fetch;
  if (!fetchFn) throw new Error("fetch_not_available");

  const files = await fetchPrFiles(fetchFn, repository, prNumber, token);

  const payload = {
    source: "github_live_pr_api",
    repository,
    pullRequestNumber: prNumber,
    fetchedAt: new Date().toISOString(),
    changedFiles: files
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportName,
        status: "completed",
        repository,
        pullRequestNumber: prNumber,
        changedFileCount: files.length,
        outputPath
      },
      null,
      2
    )
  );
}

async function fetchPrFiles(
  fetchFn: FetchFn,
  repository: string,
  prNumber: number,
  token: string
): Promise<GithubFile[]> {
  const files: GithubFile[] = [];
  let page = 1;

  while (true) {
    const response = await fetchFn(
      `https://api.github.com/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "bounded-dllm-agent-lab-phase-k"
        }
      }
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`github_http_${response.status}: ${text.slice(0, 200)}`);
    }

    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("github_files_response_not_array");

    const pageFiles = parsed.map(normalizeFile);
    files.push(...pageFiles);

    if (pageFiles.length < 100) break;
    page += 1;
  }

  return files;
}

function normalizeFile(value: unknown): GithubFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_github_file_entry");
  }

  const record = value as Record<string, unknown>;

  return {
    filename: readString(record, "filename"),
    status: readString(record, "status"),
    additions: readNumber(record, "additions"),
    deletions: readNumber(record, "deletions"),
    changes: readNumber(record, "changes"),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(typeof record.previous_filename === "string"
      ? { previous_filename: record.previous_filename }
      : {})
  };
}

function resolvePrNumber(): number | null {
  const direct = process.env.PR_NUMBER ?? process.env.GITHUB_PR_NUMBER ?? process.env.PULL_REQUEST_NUMBER;

  if (direct) {
    const parsed = Number(direct);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  const ref = process.env.GITHUB_REF ?? "";
  const match = ref.match(/^refs\/pull\/(\d+)\/merge$/) ?? ref.match(/^refs\/pull\/(\d+)\/head$/);

  if (!match) return null;

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected_${key}_string`);
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`expected_${key}_number`);
  return value;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}
