"use strict";

const { createHash } = require("node:crypto");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { V1_RUNTIME_BUDGET } = require("./definition.cjs");
const {
  enforceSemanticPatchLimit,
  hash,
  patchLines,
  unifiedPatch
} = require("./context.cjs");
const {
  TEXT_EDIT_OUTPUT_VERSION,
  boundedTextEditInstruction,
  boundedTextEditOutputSchema,
  controlledInsertionInstruction,
  controlledInsertionOutputSchema,
  materializeBoundedTextEdits,
  materializeControlledInsertion
} = require("./text-edits.cjs");
const { FAILURE_CODES } = require("./verification.cjs");

const PROVIDER_SENSITIVE_LINE = [
  /bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /authorization\s*:\s*[^\n]+/i,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i
];
const EXECUTOR_SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function executorModelIdForProvider(providerModelId) {
  if (typeof providerModelId !== "string" || providerModelId.length === 0) {
    throw new TypeError("Controlled pilot provider model ID is invalid.");
  }
  return EXECUTOR_SAFE_MODEL_ID.test(providerModelId)
    ? providerModelId
    : `model:${createHash("sha256").update(providerModelId).digest("hex")}`;
}

function createProviderSource(content, profile) {
  if (!["executor_mutations", "bounded_text_edits"].includes(profile.providerMode)) {
    return { content, maskedLines: [] };
  }
  const maskedLines = [];
  const providerContent = content.split("\n").map((line, index) => {
    if (!PROVIDER_SENSITIVE_LINE.some((pattern) => pattern.test(line))) return line;
    const redactionMarker = `/* PILOT_REDACTED_LINE_${index} */`;
    maskedLines.push({ redactionMarker, line });
    return redactionMarker;
  }).join("\n");
  return { content: providerContent, maskedLines };
}

function restoreProviderSource(content, maskedLines) {
  let restored = content;
  for (const masked of maskedLines) {
    if (restored.split(masked.redactionMarker).length !== 2) {
      throw Object.assign(new Error("PILOT_AUTHORITY_VIOLATION"), {
        pilotCode: "PILOT_AUTHORITY_VIOLATION"
      });
    }
    restored = restored.replace(masked.redactionMarker, masked.line);
  }
  return restored;
}

function liveProviderConfiguration(environment) {
  const endpoint = environment.LLM_UPSTREAM_URL ?? environment.MODEL_WORKER_UPSTREAM_URL;
  const modelId = environment.LLM_MODEL_ID;
  if (!endpoint || !modelId) return null;
  let url;
  try { url = new URL(endpoint); } catch { return null; }
  if (!url.pathname.endsWith("/v1/chat/completions") &&
      !url.pathname.endsWith("/chat/completions")) return null;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  let transport;
  let credential;
  if (loopback) {
    if (url.protocol !== "http:") return null;
    transport = "local_openai_compatible";
    credential = environment.LOCAL_OPENAI_API_KEY ??
      environment.LLM_UPSTREAM_API_KEY ??
      environment.MODEL_WORKER_UPSTREAM_API_KEY ?? "local-loopback";
  } else {
    if (url.protocol !== "https:") return null;
    credential = environment.LLM_UPSTREAM_API_KEY ?? environment.MODEL_WORKER_UPSTREAM_API_KEY;
    if (!credential) return null;
    transport = "runpod_openai_compatible";
  }
  url.pathname = url.pathname.replace(/\/chat\/completions$/, "");
  return { baseUrl: url.toString().replace(/\/+$/, ""), credential, modelId, transport };
}

function pilotProviderClientConfiguration(
  schemaVersion,
  providerConfig,
  runtimeBudget = V1_RUNTIME_BUDGET
) {
  return {
    schemaVersion,
    modelId: providerConfig.modelId,
    endpoint: { type: "custom_openai_compatible", baseUrl: providerConfig.baseUrl },
    structuredOutputMode: "json_schema",
    requestTimeoutMs: runtimeBudget.providerTimeoutMs,
    temperature: 0,
    maxOutputTokens: runtimeBudget.providerMaxOutputTokens
  };
}

function createCountedClient(input) {
  const {
    concreteClient,
    definition,
    executorMutationLineBudget,
    lifecycle,
    output,
    profile,
    providerConfig,
    runtimeBudget,
    sourceCommit,
    state,
    temporaryRoot
  } = input;

  return {
    async execute(request, executionOptions) {
      const insertionInstruction = profile.providerMode === "controlled_help_copy"
        ? controlledInsertionInstruction(request) : null;
      const textEditInstruction = profile.providerMode === "bounded_text_edits"
        ? boundedTextEditInstruction(request, profile, definition) : null;
      state.providerCallCount += 1;
      lifecycle.push("pilot.provider.started");
      if (state.providerCallCount > definition.providerCallBudget) {
        throw Object.assign(new Error("PILOT_PROVIDER_CALL_FAILED"), {
          pilotCode: "PILOT_PROVIDER_CALL_FAILED"
        });
      }
      try {
        if (runtimeBudget.providerTimeoutMs > request.remainingRuntimeMs ||
            runtimeBudget.providerMaxOutputTokens > request.outputTokenLimit) {
          state.providerDiagnostic = {
            remainingRuntimeMs: request.remainingRuntimeMs,
            outputTokenLimit: request.outputTokenLimit ?? 0,
            configuredRequestTimeoutMs: runtimeBudget.providerTimeoutMs,
            configuredMaxOutputTokens: runtimeBudget.providerMaxOutputTokens,
            executorMutationLineBudget,
            providerErrorCode: "RUNPOD_REQUEST_REJECTED"
          };
        }
        const providerRequest = profile.providerMode === "controlled_help_copy"
          ? {
              ...request, instruction: insertionInstruction,
              instructionHash: hash(insertionInstruction),
              outputSchema: controlledInsertionOutputSchema()
            }
          : profile.providerMode === "bounded_text_edits"
            ? {
                ...request, instruction: textEditInstruction,
                instructionHash: hash(textEditInstruction),
                outputSchema: boundedTextEditOutputSchema()
              }
            : request;
        const providerResult = await concreteClient.execute(
          { ...providerRequest, modelId: providerConfig.modelId }, executionOptions
        );
        const boundedMaterialization = profile.providerMode === "bounded_text_edits"
          ? materializeBoundedTextEdits(request, providerResult.output, profile) : null;
        const result = profile.providerMode === "controlled_help_copy"
          ? {
              ...providerResult,
              output: materializeControlledInsertion(request, providerResult.output).output
            }
          : profile.providerMode === "bounded_text_edits"
            ? { ...providerResult, output: boundedMaterialization.output }
            : providerResult;

        if (result?.output && typeof result.output === "object" &&
            Array.isArray(result.output.mutations)) {
          const bounded = JSON.parse(request.instruction);
          let proposedPatchLines = 0;
          const perFilePatchLines = {};
          const candidatePatches = [];
          for (const mutation of result.output.mutations) {
            const source = bounded.workspaceFiles.find((file) => file.path === mutation.path);
            if (source && typeof mutation.newContent === "string") {
              const candidatePatch = await unifiedPatch(
                mutation.path, source.content, mutation.newContent, temporaryRoot
              );
              const candidateLineCount = patchLines(candidatePatch);
              candidatePatches.push(candidatePatch);
              perFilePatchLines[mutation.path] = candidateLineCount;
              proposedPatchLines += candidateLineCount;
            }
          }
          const boundedEdits = boundedMaterialization
            ? providerResult.output.edits.map((edit, index) => ({
                index, path: edit.path,
                oldTextLines: edit.oldText.split(/\r?\n/).length,
                newTextLines: edit.newText.split(/\r?\n/).length,
                oldTextBytes: Buffer.byteLength(edit.oldText),
                newTextBytes: Buffer.byteLength(edit.newText)
              })) : null;
          const rejectedCandidateArtifacts = {
            patch: "rejected-candidate.patch",
            providerOutput: boundedMaterialization ? "rejected-provider-output.json" : null
          };
          const persistRejectedCandidate = async () => {
            await mkdir(output, { recursive: true });
            await writeFile(join(output, rejectedCandidateArtifacts.patch), candidatePatches.join(""));
            if (boundedMaterialization) {
              await writeFile(
                join(output, rejectedCandidateArtifacts.providerOutput),
                `${JSON.stringify({
                  schemaVersion: TEXT_EDIT_OUTPUT_VERSION,
                  sourceCommit,
                  proposedPatchLines,
                  maxPatchLines: definition.maxPatchLines,
                  perFilePatchLines,
                  editCounts: boundedMaterialization.editCounts,
                  providerOutput: providerResult.output
                }, null, 2)}\n`
              );
            }
          };
          const patchDiagnostic = {
            proposedPatchLines, maxPatchLines: definition.maxPatchLines,
            executorMutationLineBudget, perFilePatchLines,
            boundedEditCounts: boundedMaterialization?.editCounts ?? null,
            boundedEdits, rejectedCandidateArtifacts
          };
          if (result.output.mutations.length > definition.maxChangedFiles) {
            state.providerDiagnostic = patchDiagnostic;
            await persistRejectedCandidate();
            state.providerPilotFailure = "PILOT_PATCH_LIMIT_EXCEEDED";
            throw Object.assign(new Error("PILOT_PATCH_LIMIT_EXCEEDED"), {
              pilotCode: "PILOT_PATCH_LIMIT_EXCEEDED"
            });
          }
          try {
            enforceSemanticPatchLimit(proposedPatchLines, definition.maxPatchLines);
          } catch (error) {
            state.providerDiagnostic = patchDiagnostic;
            await persistRejectedCandidate();
            state.providerPilotFailure = "PILOT_PATCH_LIMIT_EXCEEDED";
            throw error;
          }
          state.providerDiagnostic = patchDiagnostic;
        }
        lifecycle.push("pilot.provider.completed");
        return result;
      } catch (error) {
        if (FAILURE_CODES.has(error?.pilotCode)) state.providerPilotFailure = error.pilotCode;
        const errorCode = typeof error?.code === "string" &&
          /^(?:RUNPOD|LOCAL)_[A-Z0-9_]+$/.test(error.code) ? error.code : null;
        if (errorCode) {
          state.providerDiagnostic = {
            remainingRuntimeMs: request.remainingRuntimeMs,
            outputTokenLimit: request.outputTokenLimit ?? 0,
            configuredRequestTimeoutMs: runtimeBudget.providerTimeoutMs,
            configuredMaxOutputTokens: runtimeBudget.providerMaxOutputTokens,
            executorMutationLineBudget,
            providerErrorCode: errorCode
          };
        }
        lifecycle.push("pilot.provider.failed");
        throw error;
      }
    }
  };
}

module.exports = {
  createCountedClient,
  createProviderSource,
  executorModelIdForProvider,
  liveProviderConfiguration,
  pilotProviderClientConfiguration,
  restoreProviderSource
};
