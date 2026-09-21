#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const changed = [];

function replace(file, before, after, count = 1) {
  const absolute = path.join(root, file);
  const source = fs.readFileSync(absolute, "utf8");
  const pieces = source.split(before);
  if (pieces.length !== count + 1) {
    throw new Error(`${file}: expected exactly ${count} matching source anchors, found ${pieces.length - 1}`);
  }
  fs.writeFileSync(absolute, pieces.join(after), "utf8");
  if (!changed.includes(file)) changed.push(file);
}

const adapter = "packages/integrations/src/codex-agent-adapter.ts";
replace(adapter,
  '} from "./codex-event-parser.js";',
  '} from "./codex-event-parser.js";\nimport { normalizeCodexProviderFailure } from "./codex-provider-access.js";');
replace(adapter,
  'export const CODEX_SDK_VERSION = "0.153.4" as const;',
  'export const CODEX_SDK_VERSION = "0.153.4" as const;\n// A single top-level SDK invocation is allowed for the separately approved first-access probe.\nlet firstAccessInvocationCount = 0;');
replace(adapter,
  'case "none":\n      return "minimal";',
  'case "none":\n      // SDK typing is narrower than the installed Codex CLI config; exact runtime\n      // compatibility is separately checked by the offline preflight. No fallback.\n      return "none" as unknown as ModelReasoningEffort;');
replace(adapter,
  '    const threadOptions: ThreadOptions = {',
  '    if (process.env.BOUNDED_CODEX_PROVIDER_INVOCATION_BUDGET === "1") {\n      if (firstAccessInvocationCount >= 1) {\n        processControl.close();\n        return emptyResult(request, "rejected", Math.max(0, this.now() - startedAtMs), [\n          diagnostic("codex_first_live_attempt_budget_exhausted", "error",\n            "The approved first access was limited to one SDK invocation.")\n        ]);\n      }\n      // Reserve before constructing a client or starting a provider stream.\n      firstAccessInvocationCount += 1;\n    }\n\n    const threadOptions: ThreadOptions = {');
replace(adapter,
  '          adapterDiagnostics.push(\n            diagnostic(\n              "codex_sdk_error",\n              "error",\n              message,\n              true\n            )\n          );',
  '          const providerFailure = normalizeCodexProviderFailure(error);\n          const code = providerFailure === "authentication_failed" ? "codex_provider_auth"\n            : providerFailure === "usage_limit_exceeded" ? "codex_provider_quota"\n            : providerFailure === "provider_overloaded" ? "codex_provider_capacity"\n            : "codex_sdk_error";\n          adapterDiagnostics.push(diagnostic(code, "error",\n            "Codex provider invocation failed; raw error details were not persisted.", false));');

replace("apps/cli/src/commands/codex.ts",
  'export const BOUNDED_CODEX_REASONING = "medium" as const;',
  'export const BOUNDED_CODEX_REASONING = "none" as const;');
replace("apps/cli/src/commands/compare.ts",
  '      discoveryFailure = error;\n    } else {\n      throw error;\n    }',
  '      discoveryFailure = error;\n      // A failed discovery may already have consumed a provider invocation.\n      // Never start another arm after a provider failure.\n      if (["codex_provider_auth", "codex_provider_quota", "codex_provider_capacity",\n        "codex_stream_error", "codex_sdk_error", "codex_turn_failed"].includes(error.failureCode)) {\n        throw new CliError(error.failureCode,\n          "Codex scope discovery provider failed; no subsequent arm invocation is allowed.", 4);\n      }\n    } else {\n      throw error;\n    }');

const workflow = ".github/workflows/product-dogfood-v1-live.yml";
replace(workflow,
  '          BOUNDED_COMPARE_PREPARE_DEPENDENCIES: "1"',
  '          BOUNDED_COMPARE_PREPARE_DEPENDENCIES: "1"\n          BOUNDED_CODEX_PROVIDER_INVOCATION_BUDGET: "1"\n          DOGFOOD_APPROVE_FIRST_LIVE_ATTEMPT: "true"', 2);
replace(workflow,
  'name: Run 20 fresh Normal/Bounded dogfood pairs',
  'name: First approved live access probe (one SDK invocation; not 20 pairs)', 2);

console.log(JSON.stringify({ ok: true, changed }));
