"use strict";

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { hash } = require("./context.cjs");

const REPORT_VERSION = "bounded.controlled-coding-pilot-report/v1";

function reportBase(input) {
  return {
    schemaVersion: REPORT_VERSION,
    pilotId: input.definition?.pilotId ?? "controlled-real-coding-v1.runpod-live-help",
    status: input.status ?? "failed",
    sourceCommit: input.sourceCommit ?? "",
    pilotDefinitionHash: input.definitionHash ?? "",
    providerKind: "existing-runpod-openai-compatible-model-worker",
    modelId: input.modelId ?? null,
    providerCallCount: input.providerCallCount ?? 0,
    retryCount: input.retryCount ?? 0,
    workspaceReceiptHash: input.workspaceReceiptHash ?? null,
    changedFiles: input.changedFiles ?? [],
    patchLineCount: input.patchLineCount ?? 0,
    authorityPassed: input.authorityPassed ?? false,
    verifierPassed: input.verifierPassed ?? false,
    artifactProduced: input.artifactProduced ?? false,
    artifactValid: input.artifactValid ?? false,
    sourceWorktreeMutated: input.sourceWorktreeMutated ?? false,
    githubMutationObserved: false,
    budgetExceeded: input.budgetExceeded ?? false,
    cleanupCompleted: input.cleanupCompleted ?? false,
    failureCode: input.failureCode ?? null,
    providerDiagnostic: input.providerDiagnostic ?? null,
    verifierDiagnostic: input.verifierDiagnostic ?? null,
    lifecycle: input.lifecycle ?? []
  };
}

function markdown(report) {
  return [
    "# Controlled Real Coding Pilot", "",
    `- Status: \`${report.status}\``, `- Source commit: \`${report.sourceCommit}\``,
    `- Definition hash: \`${report.pilotDefinitionHash}\``,
    `- Provider calls: \`${report.providerCallCount}\``,
    `- Changed files: \`${report.changedFiles.join(", ") || "none"}\``,
    `- Patch lines: \`${report.patchLineCount}\``,
    `- Authority: \`${report.authorityPassed ? "passed" : "not passed"}\``,
    `- Verifier: \`${report.verifierPassed ? "passed" : "not passed"}\``,
    `- Artifact: \`${report.artifactValid ? "valid" : "not produced or invalid"}\``,
    `- Source worktree mutated: \`${report.sourceWorktreeMutated}\``,
    `- GitHub mutation observed: \`${report.githubMutationObserved}\``,
    `- Cleanup completed: \`${report.cleanupCompleted}\``,
    `- Failure code: \`${report.failureCode ?? "none"}\``, "", "## Lifecycle", "",
    ...report.lifecycle.map((event) => `- \`${event}\``), ""
  ].join("\n");
}

async function writeReport(output, report) {
  await mkdir(output, { recursive: true });
  const clean = JSON.parse(JSON.stringify(report));
  await writeFile(join(output, "pilot-report.json"), `${JSON.stringify(clean, null, 2)}\n`);
  await writeFile(join(output, "pilot-report.md"), markdown(clean));
  return { ...clean, reportHash: hash(clean) };
}

async function persistVerifierRejection(input) {
  const {
    classified,
    error,
    generatedPatch,
    output,
    sourceCommit,
    verifierStage
  } = input;
  const verifierStdout = typeof error?.stdout === "string"
    ? error.stdout
    : error?.stdout ? String(error.stdout) : "";
  const verifierStderr = typeof error?.stderr === "string"
    ? error.stderr
    : error?.stderr ? String(error.stderr) : "";
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "rejected-candidate.patch"), generatedPatch);
  await writeFile(join(output, "verifier-error.json"), `${JSON.stringify({
    schemaVersion: "bounded.controlled-pilot-verifier-error/v1",
    sourceCommit,
    verifierStage,
    verifierExitCode: Number.isSafeInteger(error?.code) ? error.code : null,
    stdout: verifierStdout,
    stderr: verifierStderr
  }, null, 2)}\n`);
  return {
    ...(classified.verifierDiagnostic ?? {}),
    rejectedCandidateArtifact: "rejected-candidate.patch",
    verifierErrorArtifact: "verifier-error.json"
  };
}

async function persistAcceptedEvidence(input) {
  const {
    changedFiles,
    execution,
    generatedPatch,
    lifecycle,
    output,
    profile,
    request,
    sourceByPath,
    sourceCommit,
    verificationProfile
  } = input;
  const workspaceReceipt = {
    schemaVersion: "bounded.controlled-pilot-workspace-receipt/v1",
    repositoryId: request.repository.repositoryId,
    sourceCommit,
    workspaceManifestHash: request.workspace.manifestHash,
    planHash: request.plan.planHash,
    authorityHash: request.authority.authorityHash,
    ...(profile.requiredMutationPaths.length === 1
      ? {
          targetPath: profile.requiredMutationPaths[0],
          targetContentHash: hash(sourceByPath.get(profile.requiredMutationPaths[0]))
        }
      : {
          targetPaths: profile.requiredMutationPaths,
          targetContentHashes: Object.fromEntries(profile.requiredMutationPaths.map(
            (filePath) => [filePath, hash(sourceByPath.get(filePath))]
          ))
        })
  };
  const artifactIdentity = {
    schemaVersion: "bounded.controlled-pilot-change-artifact/v1",
    sourceCommit,
    mutationSetHash: execution.mutationSet.mutationSetHash,
    changedFiles,
    patchHash: hash(generatedPatch),
    verifierStages: [...verificationProfile]
  };
  const artifact = {
    ...artifactIdentity,
    artifactId: hash(artifactIdentity),
    githubMutationObserved: false
  };
  lifecycle.push("pilot.artifact.created");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "workspace-receipt.json"),
    `${JSON.stringify(workspaceReceipt, null, 2)}\n`
  );
  await writeFile(
    join(output, "runtime-events.jsonl"),
    `${lifecycle.map((type) => JSON.stringify({ type })).join("\n")}\n`
  );
  await writeFile(
    join(output, "verifier-report.json"),
    `${JSON.stringify({ passed: true, stages: [...verificationProfile] }, null, 2)}\n`
  );
  await writeFile(
    join(output, "governed-change-artifact.json"),
    `${JSON.stringify(artifact, null, 2)}\n`
  );
  await writeFile(join(output, "generated.patch"), generatedPatch);
  return hash(await readFile(join(output, "workspace-receipt.json"), "utf8"));
}

module.exports = {
  REPORT_VERSION,
  markdown,
  persistAcceptedEvidence,
  persistVerifierRejection,
  reportBase,
  writeReport
};
