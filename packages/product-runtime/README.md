# Product runtime

Requires Node.js >=22.14.0. The runtime uses Node's built-in SQLite module,
which may emit an experimental-feature warning on Node 22.

```sh
npm install @bounded-dllm-agent-lab/product-runtime
```

```javascript
import { runBoundedTask } from "@bounded-dllm-agent-lab/product-runtime";
```

The package includes compiled JavaScript and TypeScript declarations. No
TypeScript loader is needed to import it from Node.js.

Mutation v1 supports only updates of existing regular UTF-8 text files. Coder
`patch_draft` and remask `repair_draft` claims use the same exact schema:

```typescript
const claim: TextFileUpdateClaimV1 = {
  claimVersion: "text-file-update/v1",
  type: "patch_draft",
  operation: "update",
  file: "src/service.ts",
  expectedContentHash: sourceEvidence.contentHash,
  newContent: "export const value = 2;\n",
  description: "Update the existing implementation."
};
```

`newContent` is the complete replacement content, never a diff. Empty content
truncates an existing file; it does not delete it. BOM and line endings are
preserved. `proposedPatch` is rejected with `MUTATION_LEGACY_PATCH_FIELD`; remove
legacy extra fields such as `addressesIssueCodes` and regenerate all mutation
hashes and authorization evidence. In-memory verifier/dry-run/temp-apply callers
must supply trusted `fileContents` for source checks. Repair issue obligations
remain separate from the text-update schema; a required obligation without
supporting evidence continues to stop verification.

The common validator rejects create/delete/rename, symlinks, non-regular files,
mode-change requests, invalid UTF-8/Unicode and NUL-containing binary content.
Existing normal permission bits are preserved; special permission bits are
unsupported. Files are capped at 1 MiB each; source and replacement totals are
each capped at 4 MiB, with at most 32 files. Callers can impose tighter limits.
`MUTATION_NO_CHANGE` stops a whole mutation containing any unchanged claim;
canonical runtime routes it to replan without invoking apply.

Each `patch_draft` claim that modifies an existing file must include
`expectedContentHash` (`sha256:` followed by 64 lowercase hexadecimal digits).
Use the source file's `contentHash` from the coder's bound context evidence.
The runtime compares this value with the verified context record and hashes
the current file bytes during verification. Missing or mismatched hashes stop
the task with `replan_required`, before apply runs.

Direct users of `verifyPatchDraftMutationV2` must supply `boundContextFiles`
as `{ path, contentHash }` records from trusted context evidence. A claim's
hash alone is insufficient. `runBoundedTask` supplies these records internally.

`runBoundedTask` accepts `timeoutMs` (default 120,000; maximum 600,000), an
optional absolute Unix-millisecond `deadlineAt`, and a caller `signal`.
The earlier of the timeout and absolute deadline applies to all provider calls
together. Planner, coder, and context-expansion callbacks receive a second
argument `{ signal, deadlineAt }`; pass that signal to cancellable I/O.
These controls are separate from the hashed model context.

An unresponsive callback stops the task with `bounded_task_deadline_exceeded`;
caller cancellation uses `bounded_task_cancelled`. Both failures identify the
interrupted stage. Late callback results cannot restart the pipeline. A callback
that ignores cancellation may continue its own work, so providers must not
perform repository mutations themselves.

The runtime checks cancellation again before apply. Once apply starts, it awaits
the executor's completion or recovery outcome even if the deadline expires or
the caller cancels. An in-flight mutation is never abandoned by a Promise timeout;
executors must implement their own transactional recovery contract.

The combined OpenAI-compatible planner/minimality adapter requires
`finish_reason: "stop"` before accepting generated JSON. `length` produces
`planner_minimality_adapter_generation_truncated`; `content_filter` produces
`planner_minimality_adapter_generation_filtered`. Missing or other completion
states produce `planner_minimality_adapter_generation_incomplete`. These
failures do not trigger a corrective JSON retry.

Response bodies are read incrementally under `maxResponseBytes`, including
responses without a Content-Length header. The first chunk exceeding the limit
is rejected before decoding or retaining it, and the transfer is cancelled.
The configured request timeout also covers stalled response-body reads.

Post-apply validation protects the isolated candidate workspace with a content
manifest before and after all test and acceptance commands. Changes to source,
tests, or other candidate files fail validation and trigger the existing rollback
flow. Both manifest hashes are included in the durable validation record.

Generated reports must be written under `.validation-output/` in the isolated
workspace (`CONTROLLED_VALIDATION_OUTPUT_DIRECTORY`). This reserved directory
must not already exist in the repository; validation creates it empty. Its
contents may change, but symbolic links are forbidden and workspace size limits
still apply. Reports are removed with the validation workspace during cleanup.

From the repository root, run `npm run test:product-runtime-package` to build
and pack the package, install the tarball into a temporary consumer project,
and verify both the Node import and TypeScript declaration resolution.
