# Codex doctor preflight contract

The r5 preflight invoked:

```text
codex doctor --json --strict-config -c 'model="gpt-5.6-luna"' -c 'model_reasoning_effort="medium"'
```

Its working directory was the benchmark worktree. The executable resolved to `/Users/oguzhanuyar/.npm-global/bin/codex` (`@openai/codex` CLI 0.154.0). A disposable reproduction of that exact invocation exited 2, with 0 stdout bytes and 116 stderr bytes. Stdout was empty; stderr ended in a newline. Neither process timeout nor signal occurred. Stderr matched an unsupported-argument diagnostic. The full stderr was not retained. The bounded reproduction hashes were SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` for stdout and `251c6e72ea2829169cd73b41aa715063a74b0da48393023fa514ff4792f68782` for stderr. The r5 artifact itself retained only the raw JSON parse error, so the exact historical process metadata is unavailable; the same-command reproduction identifies the failure mechanism.

The installed `codex doctor --help` lists `--json` and does not list `--strict-config`; the latter is a global CLI option and must precede `doctor`. With that order, `doctor --json` emits one JSON document on stdout with `schemaVersion`, `overallStatus`, and a `checks` object. The exit status is 0 when the report is healthy and 1 when a diagnostic check fails. The corrected command returned exit 1 with the inherited `TERM=dumb` environment because `terminal.env` failed. With `TERM=xterm-256color`, it returned exit 0 and a healthy report. Neither invocation made a model call.

The corrected invocation is `codex --strict-config doctor --json -c 'model="gpt-5.6-luna"' -c 'model_reasoning_effort="medium"'`. Exit 0 accompanies a report without failed checks; exit 1 accompanies a valid report with `overallStatus: "fail"`. The parser now validates and classifies a bounded JSON report from stdout before deciding benchmark readiness. Timeout, process failure, absent or malformed output, unsupported schema, and inconsistent exit/report combinations remain typed protocol failures. Persisted diagnostics contain only the reviewed allowlist: invocation status, exit code, parse status and schema, overall health, counts, exact bounded check IDs, readiness classification, typed issue and reason codes, and an evidence hash. Unknown check IDs remain blocking. Raw doctor output and free-form check details are never written to preflight artifacts.

## Reviewed headless benchmark policy

The r7-equivalent offline reproduction under `TERM=dumb` produced a structurally valid schema 1 report from Codex 0.154.0: exit 1, overall `fail`, 22 `ok`, no warnings, and only `terminal.env` failed. Its structured fields showed `TERM=dumb`, terminal `dumb`, and stdin/stdout/stderr each not a terminal. The sole structured issue had severity `fail` and field `TERM`. `codex exec --json`, the Normal benchmark arm, runs noninteractively. Only that exact combination is reviewed as nonblocking for its structured execution, telemetry, and source isolation. A different terminal failure or warning remains blocking; the policy does not alter `TERM`.

All other failed or warning checks block readiness, including auth, config, provider reachability, runtime, Git, filesystem/state, and any novel check ID. A reported model other than `gpt-5.6-luna` also blocks readiness even if `config.load` says `ok`. Exit 1 is accepted as an invocation result only when paired with a structurally valid failing report; it never makes an unrelated health failure pass. This policy changes only the zero-call preflight gate and no benchmark definition, task, or scientific variable.

This correction is offline only. r5 remains stopped and is not resumed.
