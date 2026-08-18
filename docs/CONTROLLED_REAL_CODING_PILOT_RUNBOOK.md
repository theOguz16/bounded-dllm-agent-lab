# Controlled Real Coding Pilot V1

## What this pilot validates

The pilot constructs one bounded coding-executor request and runs `ProductionCodingExecutorAdapter` directly with the existing Runpod OpenAI-compatible client. A counted model-client wrapper deterministically materializes the bounded help copy, after which task-specific verification and governed artifact generation run against an exact disposable checkout.

It never applies changes to the operator worktree and never creates a branch, commit, push, pull request, or publication.

## Why this task

The target is a small CLI correctness change: early `--help` and `-h` handling in `apps/cli/src/model-worker-runpod-live-smoke.ts`. It has a narrow one-file authority boundary and objective side-effect assertions.

Pilot preparation intentionally does not implement that production change. Model-generated content exists only inside a disposable detached clone and is deleted after verification.

## Definition and authority

The versioned definition is:

```text
pilots/controlled-real-coding-v1/runpod-live-help/task.json
```

Primary mutation authority is limited to the target TypeScript file. The direct executor request requires exactly one replacement mutation for that file and permits at most 120 added/removed patch lines. Dependency files, build output, reports, documentation, credentials, Git configuration, publishing code, and CI files are forbidden.

## Offline dry run

```bash
npm run run:controlled-coding-pilot-live -- \
  --output /tmp/controlled-coding-pilot-dry-run
```

Dry run validates the definition, source revision, authority, and intended checks. It makes zero provider calls.

## Offline fake-provider acceptance

```bash
npm run smoke:controlled-coding-pilot
```

The suite uses an injected fake model and local upstream sentinels; it never contacts Runpod. It covers confirmation guards, authority, patch limits, strict output, verifier rejection, cleanup, redaction, source immutability, artifact validation, and deterministic report identity.

The help checker binds loopback sentinel ports and port `8790`. Environments that prohibit local port binding must grant the test local-loopback permission.

## Runpod Qwen configuration

Set credentials only in the process environment:

```bash
export LLM_UPSTREAM_URL="https://<POD_ID>-8000.proxy.runpod.net/v1/chat/completions"
export DLLM_UPSTREAM_URL="$LLM_UPSTREAM_URL"
export LLM_UPSTREAM_API_KEY="<runtime-secret>"
export DLLM_UPSTREAM_API_KEY="$LLM_UPSTREAM_API_KEY"
export LLM_MODEL_ID="qwen2.5-coder-7b"
export DLLM_MODEL_ID="qwen2.5-coder-7b"
export RUNPOD_LIVE_REQUIRED=1
```

Do not put keys in task JSON, CLI arguments, reports, or checked-in files.

The upstream URL must include `/v1/chat/completions` because the existing vLLM worker exposes the OpenAI-compatible Chat Completions operation there. The pilot validates and converts that operation URL to the base URL expected by the existing client; no additional provider implementation is introduced.

## Live execution

For a Runpod Pod, the preferred invocation is:

```bash
EXPECTED_SOURCE_COMMIT=<sha> bash scripts/runpod-controlled-pilot-bootstrap.sh
```

Expose port `8000` as an HTTP port in Runpod before running the command. The known-good
llama.cpp baseline is `b9754`. The bootstrap does not print secrets and stops only the
llama-server process it starts; set `KEEP_LLAMA_SERVER=1` to leave that process running
intentionally.

For an already configured compatible provider, the lower-level invocation remains:

```bash
npm run run:controlled-coding-pilot-live -- \
  --execute-provider \
  --confirm-live \
  --output reports/controlled-coding-pilot
```

Both flags are mandatory. The provider-call budget is exactly one and the production executor is configured with zero transport retries.

## Reports

The output directory contains:

```text
pilot-report.json
pilot-report.md
workspace-receipt.json
runtime-events.jsonl
verifier-report.json
governed-change-artifact.json
generated.patch
```

Completion requires authority and patch limits, both help variants, zero help-side upstream requests, normal missing-environment behavior, a valid artifact, unchanged source worktree, no GitHub mutation, and successful cleanup.

`failed` and `cancelled` results are not approved artifacts.

## Safely stopping Runpod

After saving the live report, stop or terminate the Pod from the Runpod console according to operational retention needs. Confirm no other workload uses it first. The pilot never provisions, stops, or deletes Runpod infrastructure.

## Known limitations

- This is one repository revision, task, and Qwen configuration.
- Fake-provider success is not evidence of live model quality.
- The artifact is for operator review and is never published.
- The checker is task-specific, not a general CLI framework.
- Only a completed real-provider report constitutes live acceptance.
