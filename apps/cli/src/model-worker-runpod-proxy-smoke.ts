import {
  buildOpenAIChatPayload,
  extractDecisionFromText,
  normalizeModelWorkerResponse
} from "./model-worker-runpod-proxy.js";

type SmokeResult = {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

const results: SmokeResult[] = [];

results.push(
  check("direct_contract_approve", "approve", () =>
    normalizeModelWorkerResponse({
      kind: "llm",
      modelId: "mock-llm",
      upstreamResponse: {
        ok: true,
        modelId: "mock-llm",
        decision: "approve",
        reasoning: "Scoped and safe.",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      }
    }).decision
  )
);

results.push(
  check("openai_json_content_needs_review", "needs_review", () =>
    normalizeModelWorkerResponse({
      kind: "llm",
      modelId: "mock-llm",
      upstreamResponse: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                ok: true,
                decision: "needs_review",
                reasoning: "Needs remask before approval."
              })
            }
          }
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          total_tokens: 27
        }
      }
    }).decision
  )
);

results.push(
  check("plain_text_reject", "reject", () =>
    normalizeModelWorkerResponse({
      kind: "llm",
      modelId: "mock-llm",
      upstreamResponse: {
        choices: [
          {
            message: {
              content: "Reject because the patch touches forbidden files."
            }
          }
        ]
      }
    }).decision
  )
);

results.push(
  check("dllm_remask_metadata", "remask_required", () =>
    normalizeModelWorkerResponse({
      kind: "dllm",
      modelId: "mock-dllm",
      upstreamResponse: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                ok: true,
                decision: "needs_review",
                reasoning: "Unresolved remask region.",
                dllmVerifier: {
                  recommendedAction: "remask_required",
                  signalCount: 1,
                  maskRegionCount: 1
                }
              })
            }
          }
        ]
      }
    }).dllmVerifier?.recommendedAction
  )
);

results.push(
  check("extract_text_decision", "needs_review", () =>
    extractDecisionFromText("This needs review because remask is unresolved.")
  )
);

results.push(
  check("openai_payload_has_messages", true, () => {
    const payload = buildOpenAIChatPayload({
      kind: "llm",
      modelId: "mock-llm",
      acceptanceRequest: {
        changedFiles: ["src/a.ts"]
      }
    });

    return Array.isArray(payload.messages);
  })
);

const passedCount = results.filter((result) => result.passed).length;
const failedCount = results.length - passedCount;
const ok = failedCount === 0;

const report = {
  ok,
  smokeName: "model-worker-runpod-proxy-smoke-v1",
  caseCount: results.length,
  passedCount,
  failedCount,
  results
};

if (!ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));

function check(
  id: string,
  expected: unknown,
  run: () => unknown
): SmokeResult {
  const actual = run();

  return {
    id,
    expected,
    actual,
    passed: JSON.stringify(actual) === JSON.stringify(expected)
  };
}
