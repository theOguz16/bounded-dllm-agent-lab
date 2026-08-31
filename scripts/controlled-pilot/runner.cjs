"use strict";

const { mkdtemp, readFile, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const { DEFINITION, validateDefinition } = require("./definition.cjs");
const { resolvePilotConfiguration } = require("./profiles.cjs");
const {
  buildExecutionRequest,
  canonical,
  createCheckout,
  deriveExecutorMutationLineBudget,
  enforceSemanticPatchLimit,
  hash,
  patchLines,
  pathMatchesScope,
  sourceSnapshot,
  unifiedPatch
} = require("./context.cjs");
const {
  createCountedClient,
  createProviderSource,
  executorModelIdForProvider,
  liveProviderConfiguration,
  pilotProviderClientConfiguration,
  restoreProviderSource
} = require("./provider.cjs");
const { TARGET } = require("./text-edits.cjs");
const {
  persistAcceptedEvidence,
  persistVerifierRejection,
  reportBase,
  writeReport
} = require("./evidence.cjs");
const {
  classifyVerifierFailure,
  mapFailure,
  runVerificationProfile
} = require("./verification.cjs");

async function runControlledCodingPilot(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? process.cwd());
  const output = resolve(options.output ?? join(sourceRoot, "reports/controlled-coding-pilot"));
  const definitionPath = resolve(sourceRoot, options.definitionPath ?? DEFINITION);
  const lifecycle = ["pilot.started"];
  const providerState = {
    providerCallCount: 0,
    providerPilotFailure: null,
    providerDiagnostic: null
  };
  let definition;
  let profile;
  let runtimeBudget;
  let verificationProfile;
  let definitionHash = "";
  let sourceBefore;
  let temporaryRoot;
  let verifierDiagnostic = null;
  let activeModelId = options.modelId ?? null;
  let cleanupCompleted = false;
  let workingReport;

  try {
    definition = validateDefinition(JSON.parse(await readFile(definitionPath, "utf8")));
    const configuration = resolvePilotConfiguration(definition);
    profile = configuration.profile;
    runtimeBudget = configuration.runtimeBudget;
    verificationProfile = configuration.verificationProfile;
    definitionHash = hash(definition);
    lifecycle.push("pilot.definition.validated");
    sourceBefore = await sourceSnapshot(sourceRoot, TARGET);

    const execute = options.executeProvider === true;
    const confirm = options.confirmLive === true;
    if (!execute && !confirm) {
      return writeReport(output, reportBase({
        definition,
        definitionHash,
        sourceCommit: sourceBefore.commit,
        status: "dry_run",
        authorityPassed: true,
        cleanupCompleted: true,
        lifecycle
      }));
    }
    if (!execute || !confirm) {
      throw Object.assign(new Error("PILOT_CONFIRMATION_REQUIRED"), {
        pilotCode: "PILOT_CONFIRMATION_REQUIRED"
      });
    }
    if (options.abortSignal?.aborted) {
      throw Object.assign(new Error("PILOT_CANCELLED"), { pilotCode: "PILOT_CANCELLED" });
    }

    const providerConfig = options.modelClient
      ? {
          modelId: options.modelId ?? "fake-qwen2.5-coder-7b",
          credential: "fixture-value",
          baseUrl: "https://fixture.invalid/v1",
          transport: "injected"
        }
      : liveProviderConfiguration(options.environment ?? process.env);
    if (!providerConfig) {
      throw Object.assign(new Error("PILOT_PROVIDER_CONFIGURATION_MISSING"), {
        pilotCode: "PILOT_PROVIDER_CONFIGURATION_MISSING"
      });
    }
    activeModelId = providerConfig.modelId;

    temporaryRoot = await mkdtemp(join(tmpdir(), "controlled-coding-pilot-"));
    const checkout = await createCheckout(sourceRoot, temporaryRoot, sourceBefore.commit);
    lifecycle.push("pilot.worktree.created");

    const mutationBudgetSourceFiles = await Promise.all(
      definition.allowedMutationPaths
        .filter((filePath) => !definition.forbiddenPaths.some(
          (scope) => pathMatchesScope(filePath, scope)
        ))
        .map(async (filePath) => ({
          path: filePath,
          content: await readFile(join(checkout, ...filePath.split("/")), "utf8")
        }))
    );
    const executorMutationLineBudget = deriveExecutorMutationLineBudget({
      sourceFiles: mutationBudgetSourceFiles,
      allowedMutationPaths: definition.allowedMutationPaths,
      forbiddenPaths: definition.forbiddenPaths,
      maxPatchLines: definition.maxPatchLines
    });

    const coding = await import("../../dist/packages/integrations/src/coding-executor.js");
    const runpod = await import(
      "../../dist/packages/integrations/src/runpod-openai-compatible-model-client.js"
    );
    const localOpenAi = await import(
      "../../dist/packages/integrations/src/local-openai-compatible-model-client.js"
    );
    const credentials = { async getCredential() { return providerConfig.credential; } };
    const concreteClient = options.modelClient ??
      (providerConfig.transport === "local_openai_compatible"
        ? new localOpenAi.LocalOpenAICompatibleModelClient(
            pilotProviderClientConfiguration(
              localOpenAi.LOCAL_OPENAI_MODEL_CLIENT_VERSION,
              providerConfig,
              runtimeBudget
            ),
            credentials
          )
        : new runpod.RunpodOpenAICompatibleModelClient(
            pilotProviderClientConfiguration(
              runpod.RUNPOD_MODEL_CLIENT_VERSION,
              providerConfig,
              runtimeBudget
            ),
            credentials
          ));
    const countedClient = createCountedClient({
      concreteClient,
      definition,
      executorMutationLineBudget,
      lifecycle,
      output,
      profile,
      providerConfig,
      runtimeBudget,
      sourceCommit: sourceBefore.commit,
      state: providerState,
      temporaryRoot
    });
    const codingExecutor = new coding.ProductionCodingExecutorAdapter({
      adapterId: "controlled-coding-pilot",
      modelId: executorModelIdForProvider(providerConfig.modelId),
      transportRetries: 0
    }, countedClient, credentials);

    const sourceByPath = new Map(mutationBudgetSourceFiles.map(
      (file) => [file.path, file.content]
    ));
    if (profile.requiredMutationPaths.some(
      (filePath) => typeof sourceByPath.get(filePath) !== "string"
    )) {
      throw Object.assign(new Error("PILOT_AUTHORITY_VIOLATION"), {
        pilotCode: "PILOT_AUTHORITY_VIOLATION"
      });
    }
    const providerSources = new Map(profile.allowedMutationPaths.map((filePath) => [
      filePath,
      createProviderSource(sourceByPath.get(filePath), profile)
    ]));
    const { request, symbolForPath } = buildExecutionRequest({
      abortSignal: options.abortSignal,
      codingRequestVersion: coding.CODING_EXECUTOR_REQUEST_VERSION,
      definition,
      executorMutationLineBudget,
      profile,
      providerSources,
      runtimeBudget,
      sourceCommit: sourceBefore.commit
    });
    lifecycle.push("pilot.workspace.built");

    const execution = await codingExecutor.execute(request);
    if (execution.status !== "completed" || !execution.mutationSet) {
      const code = execution.diagnostics[0]?.code ?? "EXECUTOR_PROVIDER_RESPONSE_INVALID";
      if (!providerState.providerPilotFailure) {
        providerState.providerDiagnostic = {
          ...(providerState.providerDiagnostic ?? {}),
          executorMutationLineBudget,
          executorDiagnosticCode: code
        };
      }
      throw Object.assign(new Error(code), { code });
    }

    const mutations = execution.mutationSet.mutations;
    const expectedPaths = [...profile.requiredMutationPaths].sort();
    if (
      canonical(mutations.map((mutation) => mutation.path).sort()) !== canonical(expectedPaths) ||
      mutations.some((mutation) => {
        const sourceContent = providerSources.get(mutation.path)?.content;
        return mutation.operation !== "replace" ||
          mutation.expectedContentHash !== hash(sourceContent) ||
          typeof mutation.newContent !== "string" ||
          canonical(mutation.relatedPlanStepIds) !== canonical(["step-1"]) ||
          canonical(mutation.relatedSymbolIds) !== canonical([symbolForPath(mutation.path)]);
      })
    ) {
      throw Object.assign(new Error("PILOT_AUTHORITY_VIOLATION"), {
        pilotCode: "PILOT_AUTHORITY_VIOLATION"
      });
    }

    const changedFiles = mutations.map((mutation) => mutation.path).sort();
    const materializedMutations = mutations.map((mutation) => ({
      ...mutation,
      newContent: restoreProviderSource(
        mutation.newContent,
        providerSources.get(mutation.path)?.maskedLines ?? []
      )
    }));
    const generatedPatches = [];
    for (const mutation of materializedMutations) {
      generatedPatches.push(await unifiedPatch(
        mutation.path,
        sourceByPath.get(mutation.path),
        mutation.newContent,
        temporaryRoot
      ));
    }
    const generatedPatch = generatedPatches.join("");
    const lineCount = patchLines(generatedPatch);
    enforceSemanticPatchLimit(lineCount, definition.maxPatchLines);
    for (const mutation of materializedMutations) {
      await writeFile(join(checkout, ...mutation.path.split("/")), mutation.newContent);
    }

    lifecycle.push("pilot.verifier.started");
    let verifierStage = verificationProfile[0] ?? null;
    try {
      await symlink(join(sourceRoot, "node_modules"), join(checkout, "node_modules"), "dir");
      await runVerificationProfile(verificationProfile, { sourceRoot, checkout });
    } catch (error) {
      verifierStage = error?.verifierStage ?? verifierStage;
      const classified = classifyVerifierFailure(verifierStage, error);
      verifierDiagnostic = await persistVerifierRejection({
        classified,
        error,
        generatedPatch,
        output,
        sourceCommit: sourceBefore.commit,
        verifierStage
      });
      throw classified;
    }
    lifecycle.push("pilot.verifier.completed");

    const workspaceReceiptHash = await persistAcceptedEvidence({
      changedFiles,
      execution,
      generatedPatch,
      lifecycle,
      output,
      profile,
      request,
      sourceByPath,
      sourceCommit: sourceBefore.commit,
      verificationProfile
    });
    workingReport = reportBase({
      definition,
      definitionHash,
      sourceCommit: sourceBefore.commit,
      status: "completed",
      modelId: providerConfig.modelId,
      providerCallCount: providerState.providerCallCount,
      retryCount: 0,
      workspaceReceiptHash,
      changedFiles,
      patchLineCount: lineCount,
      authorityPassed: true,
      verifierPassed: true,
      artifactProduced: true,
      artifactValid: true,
      budgetExceeded: false,
      providerDiagnostic: providerState.providerDiagnostic,
      verifierDiagnostic,
      lifecycle
    });
  } catch (error) {
    if (process.env.CONTROLLED_PILOT_DEBUG === "1") {
      process.stderr.write(`${JSON.stringify(
        verifierDiagnostic ?? providerState.providerDiagnostic ?? {
          failureCode: providerState.providerPilotFailure ?? mapFailure(error)
        }
      )}\n`);
    }
    const failureCode = providerState.providerPilotFailure ?? mapFailure(error);
    if (failureCode === "PILOT_VERIFICATION_FAILED" ||
        failureCode === "PILOT_ARTIFACT_INVALID") {
      lifecycle.push("pilot.artifact.rejected");
    }
    workingReport = reportBase({
      definition,
      definitionHash,
      sourceCommit: sourceBefore?.commit,
      status: failureCode === "PILOT_CANCELLED" ? "cancelled" : "failed",
      modelId: activeModelId,
      providerCallCount: providerState.providerCallCount,
      retryCount: 0,
      failureCode,
      providerDiagnostic: providerState.providerDiagnostic,
      verifierDiagnostic,
      lifecycle
    });
  } finally {
    lifecycle.push("pilot.cleanup.started");
    try {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      cleanupCompleted = true;
      lifecycle.push("pilot.cleanup.completed");
    } catch {
      cleanupCompleted = false;
      if (workingReport) workingReport.failureCode = "PILOT_CLEANUP_FAILED";
    }
    lifecycle.push("pilot.finished");
    if (sourceBefore) {
      const after = await sourceSnapshot(sourceRoot, TARGET);
      const mutated = canonical(after) !== canonical(sourceBefore);
      if (workingReport) {
        workingReport.sourceWorktreeMutated = mutated;
        if (mutated) {
          workingReport.status = "failed";
          workingReport.failureCode = "PILOT_SOURCE_WORKTREE_MUTATED";
        }
      }
    }
    if (workingReport) {
      workingReport.cleanupCompleted = cleanupCompleted;
      workingReport.lifecycle = lifecycle;
    }
  }

  return writeReport(output, workingReport);
}

module.exports = { runControlledCodingPilot };
