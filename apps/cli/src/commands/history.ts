import { findGitRepositoryRoot } from "../product-config.js";
import { listStoredProductRunArtifacts } from "../run-artifact-store.js";
import type { CliCommandResult, CliJson } from "../bounded-task.js";

function record(value: unknown): CliJson | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CliJson
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function taskText(run: CliJson): string | null {
  const task = record(run.task);
  return firstString(
    typeof run.task === "string" ? run.task : null,
    run.objective,
    run.taskDescription,
    task?.description,
    task?.objective,
    run.taskId
  );
}

export async function historyCommand(startPath = process.cwd()): Promise<CliCommandResult> {
  const repositoryRoot = await findGitRepositoryRoot(startPath);
  const artifacts = await listStoredProductRunArtifacts(repositoryRoot);
  const runs = artifacts.map(({ artifact, modifiedAtMs }) => {
    const run = artifact.run as CliJson;
    return Object.freeze({
      runId: artifact.runId,
      runKind: artifact.runKind,
      status: firstString(run.status, run.outcome),
      agent: firstString(run.agent),
      model: firstString(run.model),
      task: taskText(run),
      modifiedAtMs
    });
  });
  return Object.freeze({
    output: {
      ok: true,
      command: "history",
      count: runs.length,
      runs
    },
    exitCode: 0
  });
}
