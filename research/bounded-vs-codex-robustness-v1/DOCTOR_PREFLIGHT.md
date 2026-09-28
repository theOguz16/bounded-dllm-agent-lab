# Codex doctor preflight contract

The r5 preflight invoked:

```text
codex doctor --json --strict-config -c 'model="gpt-5.6-luna"' -c 'model_reasoning_effort="medium"'
```

Its working directory was the benchmark worktree. The executable resolved to `/Users/oguzhanuyar/.npm-global/bin/codex` (`@openai/codex` CLI 0.154.0). A disposable reproduction of that exact invocation exited 2, with 0 stdout bytes and 116 stderr bytes. Stdout was empty; stderr ended in a newline. Neither process timeout nor signal occurred. Stderr matched an unsupported-argument diagnostic. The full stderr was not retained. The bounded reproduction hashes were SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` for stdout and `251c6e72ea2829169cd73b41aa715063a74b0da48393023fa514ff4792f68782` for stderr. The r5 artifact itself retained only the raw JSON parse error, so the exact historical process metadata is unavailable; the same-command reproduction identifies the failure mechanism.

The installed `codex doctor --help` lists `--json` and does not list `--strict-config`; the latter is a global CLI option and must precede `doctor`. With that order, `doctor --json` emits one JSON document on stdout with `schemaVersion`, `overallStatus`, and a `checks` object. The exit status is 0 when the report is healthy and 1 when a diagnostic check fails. The corrected command returned exit 1 with the inherited `TERM=dumb` environment because `terminal.env` failed. With `TERM=xterm-256color`, it returned exit 0 and a healthy report. Neither invocation made a model call.

The corrected invocation is `codex --strict-config doctor --json -c 'model="gpt-5.6-luna"' -c 'model_reasoning_effort="medium"'`. The preflight requires doctor exit 0 and `overallStatus: "ok"`, then checks the exact model and provider reachability. The parser accepts only bounded, complete JSON on stdout. It rejects nonzero exit, absent output, oversized or malformed output, wrong formats, and schema mismatches with typed issue and reason codes. Diagnostics record exit status, signal, timeout, byte counts, selected stream, format, parse status, and a SHA-256 hash of at most the first 4096 bytes of each stream. Raw doctor output is never written to preflight artifacts.

This correction is offline only. r5 remains stopped and is not resumed.
