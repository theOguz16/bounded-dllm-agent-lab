#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const LIVE_ATTESTATION =
  "I_CONFIRM_REAL_PROVIDER_CALLS";
const STRATEGIES = [
  "direct_large_context",
  "fixed_bounded_context",
  "adaptive_bounded_context"
];

const TASKS = [
  {
    taskId: "clamp-helper",
    goal:
      "Add a pure clamp(value, min, max) function that returns min when value is below min and max when value is above max.",
    expectedFile: "src/math.ts",
    requiredFragments: [
      "export function clamp",
      "Math.min",
      "Math.max"
    ],
    repository: {
      "src/math.ts": [
        "export function add(left: number, right: number): number {",
        "  return left + right;",
        "}",
        ""
      ].join("\n"),
      "test/math.test.ts": [
        'import { add } from "../src/math.js";',
        "void add;",
        ""
      ].join("\n"),
      "src/http.ts":
        "export const requestTimeoutMs = 5000;\n",
      "src/database.ts":
        "export const connectionPoolSize = 10;\n",
      "src/legacy-report.ts":
        "export const legacyReportEnabled = false;\n",
      "docs/architecture.md":
        "The service uses bounded modules and explicit interfaces.\n",
      "package.json":
        '{"name":"fixture","type":"module"}\n'
    }
  },
  {
    taskId: "normalize-title",
    goal:
      "Add a pure normalizeTitle(value) function that trims surrounding whitespace and returns lowercase text.",
    expectedFile: "src/text.ts",
    requiredFragments: [
      "export function normalizeTitle",
      ".trim()",
      ".toLowerCase()"
    ],
    repository: {
      "src/text.ts": [
        "export function identity(value: string): string {",
        "  return value;",
        "}",
        ""
      ].join("\n"),
      "test/text.test.ts": [
        'import { identity } from "../src/text.js";',
        "void identity;",
        ""
      ].join("\n"),
      "src/email.ts":
        "export const defaultSender = 'noreply@example.invalid';\n",
      "src/cache.ts":
        "export const cacheTtlSeconds = 300;\n",
      "src/legacy-format.ts":
        "export const legacyFormatting = false;\n",
      "docs/style-guide.md":
        "Text helpers should be pure and deterministic.\n",
      "package.json":
        '{"name":"fixture","type":"module"}\n'
    }
  }
];

function sha256Bytes(value) {
  return `sha256:${
    createHash("sha256")
      .update(value)
      .digest("hex")
  }`;
}

function parseInteger(
  value,
  name,
  {
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
    required = true,
    fallback = null
  } = {}
) {
  if (
    (value === undefined || value === "") &&
    !required
  ) {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${name} must be a safe integer between ${minimum} and ${maximum}`
    );
  }
  return parsed;
}

function parseBoolean(value) {
  return value === true || value === "1";
}

function safeRequestId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(
      value
    )
  ) {
    return null;
  }
  return value;
}

function firstBalancedJsonObject(text) {
  const source = String(text ?? "");
  for (
    let start = source.indexOf("{");
    start >= 0;
    start = source.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (
      let index = start;
      index < source.length;
      index += 1
    ) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate =
            source.slice(start, index + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function sortedRepositoryEntries(repository) {
  return Object.entries(repository).sort(
    ([left], [right]) =>
      left.localeCompare(right)
  );
}

function renderFullRepository(task) {
  return sortedRepositoryEntries(task.repository)
    .map(
      ([filePath, content]) =>
        [
          `--- FILE: ${filePath} ---`,
          content,
          `--- END FILE: ${filePath} ---`
        ].join("\n")
    )
    .join("\n\n");
}

function renderFiles(task, files) {
  return [...new Set(files)]
    .sort()
    .map((filePath) => {
      const content = task.repository[filePath];
      if (typeof content !== "string") {
        return null;
      }
      return [
        `--- FILE: ${filePath} ---`,
        content,
        `--- END FILE: ${filePath} ---`
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function relevantFiles(task) {
  return [
    task.expectedFile,
    ...Object.keys(task.repository)
      .filter(
        (filePath) =>
          filePath.startsWith("test/") &&
          filePath.includes(
            path.basename(
              task.expectedFile,
              path.extname(task.expectedFile)
            )
          )
      )
  ];
}

function inventory(task) {
  return sortedRepositoryEntries(task.repository)
    .map(
      ([filePath, content]) =>
        `${filePath} (${Buffer.byteLength(
          content,
          "utf8"
        )} bytes)`
    )
    .join("\n");
}

function systemMessage(role) {
  const shared = [
    "You are participating in a controlled coding benchmark.",
    "Return exactly one JSON object.",
    "Do not use markdown fences.",
    "Do not include prose before or after JSON.",
    "Do not reveal chain-of-thought.",
    "Keep textual fields concise."
  ];

  if (role === "planner") {
    return [
      ...shared,
      'Required shape: {"selectedFiles":["path"],"reason":"short reason"}',
      "Select only files needed to complete the task."
    ].join("\n");
  }
  if (role === "coder") {
    return [
      ...shared,
      'Required shape: {"filePath":"path","replacement":"complete file content"}',
      "Return the complete replacement content for one requested file.",
      "Do not edit package metadata, generated files, or unrelated modules."
    ].join("\n");
  }
  return [
    ...shared,
    'Required shape: {"decision":"approve|needs_review|reject","reason":"short reason"}',
    "Approve only when the candidate satisfies the task and stays in the expected file."
  ].join("\n");
}

function plannerUserMessage(
  strategy,
  task
) {
  let context;
  if (strategy === "direct_large_context") {
    context = renderFullRepository(task);
  } else if (
    strategy === "fixed_bounded_context"
  ) {
    context = renderFiles(
      task,
      relevantFiles(task)
    );
  } else {
    context = [
      "Repository inventory:",
      inventory(task),
      "",
      `Expected target hint: ${task.expectedFile}`
    ].join("\n");
  }

  return [
    "ROLE: planner",
    `STRATEGY: ${strategy}`,
    `TASK_ID: ${task.taskId}`,
    `GOAL: ${task.goal}`,
    "",
    "CONTEXT:",
    context,
    "",
    "Select the smallest sufficient file set."
  ].join("\n");
}

function coderUserMessage(
  strategy,
  task,
  selectedFiles
) {
  let context;
  if (strategy === "direct_large_context") {
    context = renderFullRepository(task);
  } else if (
    strategy === "fixed_bounded_context"
  ) {
    context = renderFiles(
      task,
      relevantFiles(task)
    );
  } else {
    const safeSelection = selectedFiles.filter(
      (filePath) =>
        Object.hasOwn(
          task.repository,
          filePath
        )
    );
    context = renderFiles(
      task,
      safeSelection.length > 0
        ? safeSelection
        : [task.expectedFile]
    );
  }

  return [
    "ROLE: coder",
    `STRATEGY: ${strategy}`,
    `TASK_ID: ${task.taskId}`,
    `GOAL: ${task.goal}`,
    `EXPECTED_FILE: ${task.expectedFile}`,
    "",
    "CONTEXT:",
    context,
    "",
    "Return the complete replacement file."
  ].join("\n");
}

function verifierUserMessage(
  strategy,
  task,
  candidate
) {
  let context;
  if (strategy === "direct_large_context") {
    context = renderFullRepository(task);
  } else {
    context = renderFiles(
      task,
      [task.expectedFile]
    );
  }

  return [
    "ROLE: verifier",
    `STRATEGY: ${strategy}`,
    `TASK_ID: ${task.taskId}`,
    `GOAL: ${task.goal}`,
    `EXPECTED_FILE: ${task.expectedFile}`,
    `REQUIRED_FRAGMENTS: ${JSON.stringify(
      task.requiredFragments
    )}`,
    "",
    "AUTHORITATIVE CONTEXT:",
    context,
    "",
    "CANDIDATE:",
    JSON.stringify(candidate)
  ].join("\n");
}

function validatePlanner(task, parsed) {
  if (
    parsed === null ||
    !Array.isArray(parsed.selectedFiles) ||
    !parsed.selectedFiles.every(
      (entry) => typeof entry === "string"
    )
  ) {
    return {
      valid: false,
      selectedFiles: [task.expectedFile]
    };
  }
  const selectedFiles = [
    ...new Set(parsed.selectedFiles)
  ].filter(
    (filePath) =>
      Object.hasOwn(task.repository, filePath)
  );
  return {
    valid:
      selectedFiles.includes(
        task.expectedFile
      ),
    selectedFiles:
      selectedFiles.length > 0
        ? selectedFiles
        : [task.expectedFile]
  };
}

function validateCandidate(task, parsed) {
  if (
    parsed === null ||
    parsed.filePath !== task.expectedFile ||
    typeof parsed.replacement !== "string"
  ) {
    return false;
  }
  return task.requiredFragments.every(
    (fragment) =>
      parsed.replacement.includes(fragment)
  );
}

function validateVerifier(parsed) {
  return (
    parsed !== null &&
    parsed.decision === "approve"
  );
}

async function callProvider(
  runtime,
  config,
  messages,
  metadata
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs
  );
  const startedAt = new Date().toISOString();

  try {
    const headers = {
      "content-type": "application/json"
    };
    if (config.apiKey) {
      headers.authorization =
        `Bearer ${config.apiKey}`;
    }

    const requestBody = {
      model: config.modelId,
      temperature: config.temperature,
      top_p: config.topP,
      max_tokens: config.maxTokens,
      messages
    };

    const response = await fetch(
      config.providerUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      }
    );
    const raw = await response.text();
    const finishedAt =
      new Date().toISOString();
    const responseHash =
      sha256Bytes(raw);

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    const requestId = safeRequestId(
      response.headers.get("x-request-id") ??
        data?.id ??
        null
    );

    if (!response.ok || data === null) {
      return {
        ok: false,
        startedAt,
        finishedAt,
        responseHash,
        requestId,
        content: "",
        parsed: null,
        usage: {
          status: "unavailable",
          reason: "provider_call_failed",
          providerResponseHash: responseHash
        },
        error:
          !response.ok
            ? `HTTP ${response.status}`
            : "provider_json_invalid",
        metadata
      };
    }

    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      "";
    const usageResult =
      runtime.normalizeOpenAiCompatibleUsage({
        response: data,
        providerResponseHash:
          responseHash,
        providerRequestId: requestId
      });

    if (usageResult.usage === null) {
      return {
        ok: false,
        startedAt,
        finishedAt,
        responseHash,
        requestId,
        content: String(content),
        parsed:
          firstBalancedJsonObject(content),
        usage: {
          status: "unavailable",
          reason:
            "provider_usage_unsupported",
          providerResponseHash:
            responseHash
        },
        error:
          usageResult.errors[0] ??
          "provider_usage_invalid",
        metadata
      };
    }

    return {
      ok: true,
      startedAt,
      finishedAt,
      responseHash,
      requestId,
      content: String(content),
      parsed:
        firstBalancedJsonObject(content),
      usage: usageResult.usage,
      error: null,
      metadata
    };
  } catch (error) {
    const finishedAt =
      new Date().toISOString();
    return {
      ok: false,
      startedAt,
      finishedAt,
      responseHash: null,
      requestId: null,
      content: "",
      parsed: null,
      usage: {
        status: "unavailable",
        reason: "provider_call_failed",
        providerResponseHash: null
      },
      error:
        error instanceof Error
          ? error.message
          : String(error),
      metadata
    };
  } finally {
    clearTimeout(timeout);
  }
}

function eventTokenUsage(usage) {
  if (usage.status !== "observed") {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}

function appendCallEvent(
  runtime,
  ledger,
  call,
  {
    actor,
    action,
    filesRead,
    filesProposed,
    decision,
    reasonCodes
  }
) {
  const draft = {
    actor,
    action,
    startedAt: call.startedAt,
    finishedAt: call.finishedAt,
    inputArtifactHashes: [
      runtime.hashCanonicalJson({
        messages: call.metadata.messages
      })
    ],
    outputArtifactHashes:
      call.responseHash === null
        ? []
        : [call.responseHash],
    filesRead,
    filesProposed,
    decision,
    reasonCodes,
    ...(eventTokenUsage(call.usage) ===
    undefined
      ? {}
      : {
          tokenUsage:
            eventTokenUsage(call.usage)
        })
  };
  return runtime.appendAgentEvent(
    ledger,
    draft
  );
}

function invocationInputFromLedger(
  ledger
) {
  return {
    ledgerVersion: ledger.ledgerVersion,
    evidenceClass: ledger.evidenceClass,
    observationSource:
      ledger.observationSource,
    observationReceiptHash:
      ledger.observationReceiptHash,
    runId: ledger.runId,
    taskSetHash: ledger.taskSetHash,
    sourceLedgerRootHash:
      ledger.sourceLedgerRootHash,
    strategy: ledger.strategy,
    outcome: ledger.outcome,
    acceptedPatchCount:
      ledger.acceptedPatchCount,
    pricingSnapshots:
      ledger.pricingSnapshots,
    invocations:
      ledger.invocations.map(
        (entry) => ({
          invocationId:
            entry.invocationId,
          eventId: entry.eventId,
          eventHash: entry.eventHash,
          operation: entry.operation,
          strategy: entry.strategy,
          providerId: entry.providerId,
          modelId: entry.modelId,
          attempt: entry.attempt,
          usage: entry.usage,
          priceSnapshotId:
            entry.priceSnapshotId
        })
      )
  };
}

async function executeStrategy(
  runtime,
  config,
  strategy,
  taskSetHash,
  priceSnapshot
) {
  const runId = [
    "af3b",
    strategy,
    config.captureId
  ].join(":");
  let agentLedger =
    runtime.createAgentEventLedger({
      runId,
      objectiveHash: taskSetHash
    });
  const observations = [];
  const responseHashes = [];
  const taskResults = [];

  for (const task of TASKS) {
    const plannerMessages = [
      {
        role: "system",
        content:
          systemMessage("planner")
      },
      {
        role: "user",
        content:
          plannerUserMessage(
            strategy,
            task
          )
      }
    ];
    const plannerCall =
      await callProvider(
        runtime,
        config,
        plannerMessages,
        {
          role: "planner",
          strategy,
          taskId: task.taskId,
          messages: plannerMessages
        }
      );
    const plannerValidation =
      validatePlanner(
        task,
        plannerCall.parsed
      );
    agentLedger = appendCallEvent(
      runtime,
      agentLedger,
      plannerCall,
      {
        actor: "planner",
        action: "af3b.plan",
        filesRead:
          strategy ===
            "direct_large_context"
            ? Object.keys(
                task.repository
              )
            : plannerValidation
                .selectedFiles,
        filesProposed:
          plannerValidation
            .selectedFiles,
        decision:
          plannerValidation.valid
            ? "continue"
            : "needs_review",
        reasonCodes:
          plannerValidation.valid
            ? ["AF3B.PLAN.VALID"]
            : ["AF3B.PLAN.INVALID"]
      }
    );
    const plannerEvent =
      agentLedger.events.at(-1);
    observations.push({
      observationVersion: "1",
      eventId: plannerEvent.eventId,
      operation: "planner",
      providerId: config.providerId,
      modelId: config.modelId,
      attempt: 1,
      usage: plannerCall.usage,
      priceSnapshotId:
        priceSnapshot.snapshotId
    });
    if (plannerCall.responseHash) {
      responseHashes.push(
        plannerCall.responseHash
      );
    }

    const coderMessages = [
      {
        role: "system",
        content:
          systemMessage("coder")
      },
      {
        role: "user",
        content:
          coderUserMessage(
            strategy,
            task,
            plannerValidation
              .selectedFiles
          )
      }
    ];
    const coderCall =
      await callProvider(
        runtime,
        config,
        coderMessages,
        {
          role: "coder",
          strategy,
          taskId: task.taskId,
          messages: coderMessages
        }
      );
    const candidateValid =
      validateCandidate(
        task,
        coderCall.parsed
      );
    agentLedger = appendCallEvent(
      runtime,
      agentLedger,
      coderCall,
      {
        actor: "coder",
        action: "af3b.patch",
        filesRead:
          plannerValidation
            .selectedFiles,
        filesProposed:
          coderCall.parsed?.filePath
            ? [
                String(
                  coderCall.parsed
                    .filePath
                )
              ]
            : [],
        decision:
          candidateValid
            ? "candidate_ready"
            : "needs_review",
        reasonCodes:
          candidateValid
            ? [
                "AF3B.CANDIDATE.VALID"
              ]
            : [
                "AF3B.CANDIDATE.INVALID"
              ]
      }
    );
    const coderEvent =
      agentLedger.events.at(-1);
    observations.push({
      observationVersion: "1",
      eventId: coderEvent.eventId,
      operation: "coder",
      providerId: config.providerId,
      modelId: config.modelId,
      attempt: 1,
      usage: coderCall.usage,
      priceSnapshotId:
        priceSnapshot.snapshotId
    });
    if (coderCall.responseHash) {
      responseHashes.push(
        coderCall.responseHash
      );
    }

    const verifierMessages = [
      {
        role: "system",
        content:
          systemMessage("verifier")
      },
      {
        role: "user",
        content:
          verifierUserMessage(
            strategy,
            task,
            coderCall.parsed
          )
      }
    ];
    const verifierCall =
      await callProvider(
        runtime,
        config,
        verifierMessages,
        {
          role: "verifier",
          strategy,
          taskId: task.taskId,
          messages: verifierMessages
        }
      );
    const verifierApproved =
      validateVerifier(
        verifierCall.parsed
      );
    const accepted =
      plannerValidation.valid &&
      candidateValid &&
      verifierApproved &&
      plannerCall.usage.status ===
        "observed" &&
      coderCall.usage.status ===
        "observed" &&
      verifierCall.usage.status ===
        "observed";

    agentLedger = appendCallEvent(
      runtime,
      agentLedger,
      verifierCall,
      {
        actor: "repair_verifier",
        action: "af3b.verify",
        filesRead: [
          task.expectedFile
        ],
        filesProposed: [],
        decision:
          verifierApproved
            ? "approve"
            : "needs_review",
        reasonCodes:
          verifierApproved
            ? [
                "AF3B.VERIFIER.APPROVE"
              ]
            : [
                "AF3B.VERIFIER.NOT_APPROVED"
              ]
      }
    );
    const verifierEvent =
      agentLedger.events.at(-1);
    observations.push({
      observationVersion: "1",
      eventId: verifierEvent.eventId,
      operation: "verifier",
      providerId: config.providerId,
      modelId: config.modelId,
      attempt: 1,
      usage: verifierCall.usage,
      priceSnapshotId:
        priceSnapshot.snapshotId
    });
    if (verifierCall.responseHash) {
      responseHashes.push(
        verifierCall.responseHash
      );
    }

    taskResults.push({
      taskId: task.taskId,
      plannerValid:
        plannerValidation.valid,
      candidateValid,
      verifierApproved,
      accepted,
      callsObserved:
        [
          plannerCall,
          coderCall,
          verifierCall
        ].every(
          (call) =>
            call.usage.status ===
              "observed"
        ),
      errors: [
        plannerCall.error,
        coderCall.error,
        verifierCall.error
      ].filter(Boolean)
    });
  }

  const acceptedPatchCount =
    taskResults.filter(
      (entry) => entry.accepted
    ).length;
  const observationReceiptHash =
    runtime.hashCanonicalJson({
      artifactType:
        "af3b_live_observation_receipt",
      runId,
      strategy,
      taskSetHash,
      sourceLedgerRootHash:
        agentLedger.rootHash,
      responseHashes:
        [...responseHashes].sort()
    });

  const binding =
    runtime
      .buildRunCostLedgerFromAgentEvents({
        bindingVersion: "1",
        evidenceClass:
          config.evidenceClass,
        observationSource:
          config.observationSource,
        observationReceiptHash,
        taskSetHash,
        strategy,
        outcome:
          acceptedPatchCount > 0
            ? "accepted_patch"
            : "human_review",
        acceptedPatchCount,
        agentLedger,
        pricingSnapshots: [
          priceSnapshot
        ],
        observations
      });

  if (
    binding.decision !==
      "agent_event_cost_binding_ready" ||
    binding.ledger === null
  ) {
    throw new Error(
      `cost binding failed for ${strategy}: ${
        binding.errors.join(",")
      }`
    );
  }

  return {
    strategy,
    taskResults,
    agentLedgerRootHash:
      agentLedger.rootHash,
    ledger: binding.ledger,
    runInput:
      invocationInputFromLedger(
        binding.ledger
      )
  };
}

function buildPriceSnapshot(
  runtime,
  config
) {
  const sourceMaterial = {
    providerId: config.providerId,
    modelId: config.modelId,
    inputNanoUsdPerToken:
      config.inputNanoUsdPerToken,
    outputNanoUsdPerToken:
      config.outputNanoUsdPerToken,
    sourceKind:
      config.priceSourceKind,
    operatorLabel:
      config.priceOperatorLabel
  };
  return {
    snapshotVersion: "1",
    snapshotId:
      `af3b-price:${config.captureId}`,
    providerId: config.providerId,
    modelId: config.modelId,
    currency: "USD",
    inputNanoUsdPerToken:
      config.inputNanoUsdPerToken,
    outputNanoUsdPerToken:
      config.outputNanoUsdPerToken,
    capturedAt: config.capturedAt,
    sourceKind:
      config.priceSourceKind,
    sourceHash:
      runtime.hashCanonicalJson(
        sourceMaterial
      )
  };
}

function validateLiveEligibility(
  config,
  strategyResults,
  benchmarkResult
) {
  if (
    config.evidenceClass !==
      "observed_run"
  ) {
    return;
  }
  if (
    config.liveAttestation !==
      LIVE_ATTESTATION
  ) {
    throw new Error(
      "live attestation is missing"
    );
  }
  if (
    config.inputNanoUsdPerToken === 0 &&
    config.outputNanoUsdPerToken === 0
  ) {
    throw new Error(
      "live release requires a non-zero operator-configured price snapshot"
    );
  }
  const everyTaskAccepted =
    strategyResults.every(
      (result) =>
        result.taskResults.every(
          (task) => task.accepted
        )
    );
  if (!everyTaskAccepted) {
    throw new Error(
      "live release requires every task to be accepted in every strategy"
    );
  }
  if (
    benchmarkResult.report === null ||
    benchmarkResult.report
      .releaseClaimEligible !== true
  ) {
    throw new Error(
      "live benchmark is not release-claim eligible"
    );
  }
}

function replaceOnce(
  source,
  oldValue,
  newValue,
  label
) {
  const index = source.indexOf(oldValue);
  if (index < 0) {
    throw new Error(
      `${label} replacement target not found`
    );
  }
  return (
    source.slice(0, index) +
    newValue +
    source.slice(
      index + oldValue.length
    )
  );
}

function updateReleaseRepository(
  runtime,
  config,
  benchmarkReport,
  strategyResults
) {
  const root = config.repositoryRoot;
  const reportPath = path.join(
    root,
    "reports/release/OBSERVED_TOKEN_COST.json"
  );
  const documentPath = path.join(
    root,
    "docs/release/OBSERVED_TOKEN_COST.md"
  );
  const matrixPath = path.join(
    root,
    "docs/release/V0_1_GAP_CLOSURE_MATRIX.json"
  );
  const gapSmokePath = path.join(
    root,
    "scripts/release-gap-closure-audit-smoke.cjs"
  );
  const repoSmokePath = path.join(
    root,
    "scripts/repository-release-evidence-runner-smoke.cjs"
  );
  const roadmapPath = path.join(
    root,
    "docs/ROADMAP.md"
  );

  for (const required of [
    matrixPath,
    gapSmokePath,
    repoSmokePath,
    roadmapPath
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(
        `required release file missing: ${required}`
      );
    }
  }

  const reportPayload = {
    artifactVersion: "1",
    evidenceClass: "observed_run",
    observationSource:
      "live_provider_call",
    providerAttestation:
      LIVE_ATTESTATION,
    capturedAt: config.capturedAt,
    providerId: config.providerId,
    modelId: config.modelId,
    taskSetHash:
      benchmarkReport.taskSetHash,
    benchmarkReport,
    taskResults:
      strategyResults.map(
        (entry) => ({
          strategy: entry.strategy,
          taskResults:
            entry.taskResults
        })
      ),
    artifactHash: null
  };
  reportPayload.artifactHash =
    runtime.hashCanonicalJson(
      reportPayload
    );

  const reportBytes =
    `${JSON.stringify(
      reportPayload,
      null,
      2
    )}\n`;

  const direct =
    benchmarkReport.strategyAggregates
      .find(
        (entry) =>
          entry.strategy ===
            "direct_large_context"
      );
  const fixed =
    benchmarkReport.strategyAggregates
      .find(
        (entry) =>
          entry.strategy ===
            "fixed_bounded_context"
      );
  const adaptive =
    benchmarkReport.strategyAggregates
      .find(
        (entry) =>
          entry.strategy ===
            "adaptive_bounded_context"
      );

  const documentation = [
    "# Observed Token and Cost Evidence",
    "",
    "This release artifact was generated from explicit live provider calls.",
    "",
    `- Provider: \`${config.providerId}\``,
    `- Model: \`${config.modelId}\``,
    `- Captured at: \`${config.capturedAt}\``,
    `- Task set hash: \`${benchmarkReport.taskSetHash}\``,
    `- Release-claim eligible: \`${benchmarkReport.releaseClaimEligible}\``,
    `- Price source: \`${config.priceSourceKind}\``,
    `- Input nano-USD/token: ${config.inputNanoUsdPerToken}`,
    `- Output nano-USD/token: ${config.outputNanoUsdPerToken}`,
    "",
    "## Strategy totals",
    "",
    "| Strategy | Observed tokens | Observed cost nano-USD | Accepted patches |",
    "|---|---:|---:|---:|",
    `| Direct large context | ${direct?.observed.totalTokens ?? 0} | ${direct?.observed.costNanoUsd ?? 0} | ${direct?.acceptedPatchCount ?? 0} |`,
    `| Fixed bounded context | ${fixed?.observed.totalTokens ?? 0} | ${fixed?.observed.costNanoUsd ?? 0} | ${fixed?.acceptedPatchCount ?? 0} |`,
    `| Adaptive bounded context | ${adaptive?.observed.totalTokens ?? 0} | ${adaptive?.observed.costNanoUsd ?? 0} | ${adaptive?.acceptedPatchCount ?? 0} |`,
    "",
    "## Direct baseline comparisons",
    "",
    `- Fixed token savings rate: \`${benchmarkReport.comparisons.fixedVsDirectObservedTokenSavingsRate}\``,
    `- Adaptive token savings rate: \`${benchmarkReport.comparisons.adaptiveVsDirectObservedTokenSavingsRate}\``,
    `- Fixed cost savings rate: \`${benchmarkReport.comparisons.fixedVsDirectObservedCostSavingsRate}\``,
    `- Adaptive cost savings rate: \`${benchmarkReport.comparisons.adaptiveVsDirectObservedCostSavingsRate}\``,
    "",
    "The price snapshot is an explicit operator or provider-published configuration.",
    "For self-hosted inference it is not a complete infrastructure TCO calculation unless the operator-configured rate incorporates that cost.",
    ""
  ].join("\n");

  fs.mkdirSync(
    path.dirname(reportPath),
    { recursive: true }
  );
  fs.mkdirSync(
    path.dirname(documentPath),
    { recursive: true }
  );

  const temporaryReport =
    `${reportPath}.tmp`;
  const temporaryDocument =
    `${documentPath}.tmp`;
  fs.writeFileSync(
    temporaryReport,
    reportBytes
  );
  fs.writeFileSync(
    temporaryDocument,
    documentation
  );
  fs.renameSync(
    temporaryReport,
    reportPath
  );
  fs.renameSync(
    temporaryDocument,
    documentPath
  );

  const matrix =
    JSON.parse(
      fs.readFileSync(
        matrixPath,
        "utf8"
      )
    );
  const shaFile = (relativePath) =>
    sha256Bytes(
      fs.readFileSync(
        path.join(root, relativePath)
      )
    );

  const g8 = matrix.gaps.find(
    (gap) => gap.id === "G8"
  );
  if (!g8) {
    throw new Error(
      "G8 is missing from release matrix"
    );
  }
  g8.disposition = "closed";
  g8.evidence = [
    {
      stage: "primitive",
      evidenceId: "g8.primitive",
      artifactKind: "module",
      locator:
        "packages/product-runtime/src/run-cost-ledger.ts",
      evidenceHash:
        shaFile(
          "packages/product-runtime/src/run-cost-ledger.ts"
        )
    },
    {
      stage: "contract_tests",
      evidenceId: "g8.contract_tests",
      artifactKind: "test",
      locator:
        "scripts/run-cost-ledger-smoke.cjs",
      evidenceHash:
        shaFile(
          "scripts/run-cost-ledger-smoke.cjs"
        )
    },
    {
      stage: "canonical_integration",
      evidenceId:
        "g8.canonical_integration",
      artifactKind: "integration",
      locator:
        "packages/product-runtime/src/agent-event-cost-binding.ts",
      evidenceHash:
        shaFile(
          "packages/product-runtime/src/agent-event-cost-binding.ts"
        )
    },
    {
      stage: "live_or_real_evidence",
      evidenceId:
        "g8.live_or_real_evidence",
      artifactKind: "report",
      locator:
        "reports/release/OBSERVED_TOKEN_COST.json",
      evidenceHash:
        shaFile(
          "reports/release/OBSERVED_TOKEN_COST.json"
        )
    },
    {
      stage: "release_artifact",
      evidenceId:
        "g8.release_artifact",
      artifactKind: "document",
      locator:
        "docs/release/OBSERVED_TOKEN_COST.md",
      evidenceHash:
        shaFile(
          "docs/release/OBSERVED_TOKEN_COST.md"
        )
    }
  ];
  delete g8.exclusion;

  const artifact =
    matrix.requiredArtifacts.find(
      (entry) =>
        entry.artifactId ===
          "observed_token_cost_report"
    );
  if (!artifact) {
    throw new Error(
      "observed_token_cost_report declaration missing"
    );
  }
  artifact.status = "present";
  artifact.artifactHash =
    shaFile(
      "reports/release/OBSERVED_TOKEN_COST.json"
    );

  fs.writeFileSync(
    matrixPath,
    `${JSON.stringify(
      matrix,
      null,
      2
    )}\n`
  );

  let gapSmoke =
    fs.readFileSync(
      gapSmokePath,
      "utf8"
    );
  gapSmoke = replaceOnce(
    gapSmoke,
    '        ["G8", "G13"]',
    '        ["G13"]',
    "gap audit blockers"
  );
  gapSmoke = replaceOnce(
    gapSmoke,
    [
      "        result.audit.missingArtifactIds.length,",
      "        11"
    ].join("\n"),
    [
      "        result.audit.missingArtifactIds.length,",
      "        10"
    ].join("\n"),
    "gap audit artifact count"
  );
  fs.writeFileSync(
    gapSmokePath,
    gapSmoke
  );

  let repoSmoke =
    fs.readFileSync(
      repoSmokePath,
      "utf8"
    );
  repoSmoke = replaceOnce(
    repoSmoke,
    '        ["G8", "G13"]',
    '        ["G13"]',
    "repository runner blockers"
  );
  fs.writeFileSync(
    repoSmokePath,
    repoSmoke
  );

  let roadmap =
    fs.readFileSync(
      roadmapPath,
      "utf8"
    );
  roadmap = roadmap.replace(
    "| **AF** | Birleşik benchmark, gap closure audit ve v0.1 release | Aktif — AF.3b live A/B/C token-cost capture |",
    "| **AF** | Birleşik benchmark, gap closure audit ve v0.1 release | Aktif — AF.4 unified release artifacts and G13 closure |"
  );
  roadmap = roadmap.replace(
    "**Durum: Uygulama hazır; live validation bekleniyor.**",
    "**Durum: Tamamlandı.**"
  );
  fs.writeFileSync(
    roadmapPath,
    roadmap
  );

  return {
    reportPath,
    documentPath,
    matrixPath
  };
}

function configFromEnvironment() {
  const liveRequired =
    parseBoolean(
      process.env.AF3B_LIVE_REQUIRED
    );
  const evidenceClass =
    liveRequired
      ? "observed_run"
      : "deterministic_fixture";
  const observationSource =
    liveRequired
      ? "live_provider_call"
      : "fixture";

  const providerUrl =
    process.env.AF3B_PROVIDER_URL;
  const providerId =
    process.env.AF3B_PROVIDER_ID;
  const modelId =
    process.env.AF3B_MODEL_ID;

  for (const [name, value] of [
    ["AF3B_PROVIDER_URL", providerUrl],
    ["AF3B_PROVIDER_ID", providerId],
    ["AF3B_MODEL_ID", modelId]
  ]) {
    if (
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new Error(
        `${name} is required`
      );
    }
  }

  const inputNanoUsdPerToken =
    parseInteger(
      process.env
        .AF3B_INPUT_NANO_USD_PER_TOKEN,
      "AF3B_INPUT_NANO_USD_PER_TOKEN",
      {
        minimum: 0,
        maximum: 1_000_000_000
      }
    );
  const outputNanoUsdPerToken =
    parseInteger(
      process.env
        .AF3B_OUTPUT_NANO_USD_PER_TOKEN,
      "AF3B_OUTPUT_NANO_USD_PER_TOKEN",
      {
        minimum: 0,
        maximum: 1_000_000_000
      }
    );

  return {
    providerUrl,
    providerId,
    modelId,
    apiKey:
      process.env.AF3B_API_KEY ?? "",
    temperature:
      Number(
        process.env
          .AF3B_TEMPERATURE ?? "0"
      ),
    topP:
      Number(
        process.env.AF3B_TOP_P ??
          "0.95"
      ),
    maxTokens:
      parseInteger(
        process.env.AF3B_MAX_TOKENS ??
          "512",
        "AF3B_MAX_TOKENS",
        {
          minimum: 64,
          maximum: 8192
        }
      ),
    timeoutMs:
      parseInteger(
        process.env.AF3B_TIMEOUT_MS ??
          "300000",
        "AF3B_TIMEOUT_MS",
        {
          minimum: 1000,
          maximum: 1_800_000
        }
      ),
    inputNanoUsdPerToken,
    outputNanoUsdPerToken,
    priceSourceKind:
      process.env
        .AF3B_PRICE_SOURCE_KIND ===
          "provider_published"
        ? "provider_published"
        : "operator_configured",
    priceOperatorLabel:
      process.env
        .AF3B_PRICE_OPERATOR_LABEL ??
      "af3b-operator-configured",
    evidenceClass,
    observationSource,
    liveRequired,
    liveAttestation:
      process.env
        .AF3B_LIVE_ATTESTATION ??
      "",
    allowReleaseWrite:
      liveRequired &&
      parseBoolean(
        process.env
          .AF3B_WRITE_RELEASE_ARTIFACTS
      ),
    capturedAt:
      new Date().toISOString(),
    captureId:
      process.env.AF3B_CAPTURE_ID ??
      new Date()
        .toISOString()
        .replace(/[:.]/g, "-"),
    repositoryRoot:
      fs.realpathSync(
        process.cwd()
      )
  };
}

async function runCapture(
  suppliedConfig = null
) {
  const config =
    suppliedConfig ??
    configFromEnvironment();

  const runtime = await import(
    "../dist/packages/product-runtime/src/index.js"
  );

  const taskSetHash =
    runtime.hashCanonicalJson({
      taskSetVersion: "1",
      tasks: TASKS.map(
        (task) => ({
          taskId: task.taskId,
          goal: task.goal,
          expectedFile:
            task.expectedFile,
          requiredFragments:
            task.requiredFragments,
          repository:
            task.repository
        })
      )
    });
  const priceSnapshot =
    buildPriceSnapshot(
      runtime,
      config
    );

  const strategyResults = [];
  for (const strategy of STRATEGIES) {
    console.error(
      `[af3b] running ${strategy}`
    );
    strategyResults.push(
      await executeStrategy(
        runtime,
        config,
        strategy,
        taskSetHash,
        priceSnapshot
      )
    );
  }

  const benchmarkResult =
    runtime.buildRunCostBenchmark({
      benchmarkVersion: "1",
      benchmarkId:
        `af3b:${config.captureId}`,
      evidenceClass:
        config.evidenceClass,
      taskSetHash,
      runs:
        strategyResults.map(
          (entry) =>
            entry.runInput
        )
    });

  if (
    benchmarkResult.decision !==
      "run_cost_benchmark_ready" ||
    benchmarkResult.report === null
  ) {
    throw new Error(
      `run cost benchmark failed: ${
        benchmarkResult.errors.join(",")
      }`
    );
  }

  validateLiveEligibility(
    config,
    strategyResults,
    benchmarkResult
  );

  let releaseFiles = null;
  if (config.allowReleaseWrite) {
    releaseFiles =
      updateReleaseRepository(
        runtime,
        config,
        benchmarkResult.report,
        strategyResults
      );
  }

  return {
    decision:
      "live_run_cost_capture_ready",
    evidenceClass:
      config.evidenceClass,
    releaseClaimEligible:
      benchmarkResult.report
        .releaseClaimEligible,
    releaseFiles,
    report:
      benchmarkResult.report,
    taskResults:
      strategyResults.map(
        (entry) => ({
          strategy:
            entry.strategy,
          taskResults:
            entry.taskResults
        })
      ),
    summary: {
      strategyCount:
        strategyResults.length,
      taskCount: TASKS.length,
      invocationCount:
        benchmarkResult.report
          .ledgers.reduce(
            (sum, ledger) =>
              sum +
              ledger.invocations.length,
            0
          ),
      everyTaskAccepted:
        strategyResults.every(
          (entry) =>
            entry.taskResults.every(
              (task) =>
                task.accepted
            )
        ),
      sameProviderModelSet:
        benchmarkResult.report
          .sameProviderModelSet,
      samePricingSnapshotSet:
        benchmarkResult.report
          .samePricingSnapshotSet,
      allStrategiesPresent:
        benchmarkResult.report
          .allStrategiesPresent
    }
  };
}

async function main() {
  const result = await runCapture();
  console.log(
    JSON.stringify(result, null, 2)
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      error?.stack ?? String(error)
    );
    process.exitCode = 1;
  });
}

module.exports = {
  LIVE_ATTESTATION,
  STRATEGIES,
  TASKS,
  runCapture
};
