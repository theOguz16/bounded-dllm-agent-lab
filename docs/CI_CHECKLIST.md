# CI Verification Checklist

This checklist explains how to verify that the lab is healthy after a change is pushed.

## Local Checks

Run these before pushing:

```bash
npm install
npm run typecheck
npm run build
npm run test:smoke
npm run eval:demo
```

For the worker boundary:

```bash
python3 apps/dllm-worker/worker.py
npm run worker:smoke
```

## GitHub Actions Checks

After pushing, verify the hosted CI run:

```bash
gh run list --limit 5
gh run view --log
```

Expected workflow:

```text
Lab CI
```

Expected steps:

- install dependencies,
- typecheck,
- build,
- smoke contract tests,
- demo eval,
- Python worker syntax,
- worker smoke.

## What Local Checks Prove

Local checks prove the lab works on your machine.

They do not prove GitHub-hosted reproducibility.

## What GitHub CI Proves

GitHub CI proves the lab can run in a clean hosted environment without local machine state.

This matters because research artifacts should be reproducible by other people.

## If CI Fails

1. Open the failed run:

```bash
gh run view --log
```

2. Identify the first failing step.

3. Reproduce the same command locally.

4. Fix the cause, not only the symptom.

5. Push again and wait for `Lab CI` to pass.

## Research Note

CI does not prove real model quality. It proves that the benchmark lab, report contracts, worker mock, and reproducibility gates are still intact.
