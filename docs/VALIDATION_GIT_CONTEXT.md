# Validation Git context

The configured `npm run test` suite reaches `scripts/smoke/explicit-scope-coder-context-fixture.cjs`,
which runs `git status --porcelain` before and after its offline fixture. It requires repository
discovery, a valid work tree and index, and stable status across the fixture. It does not compare
Candidate B with the canonical source commit or use remotes, diff, or HEAD content. A HEAD exists
in the disposable context for normal Git semantics.

The Codex validation specification binds `candidate-baseline/v1` and the digest-pinned
`node:22.23.2-bookworm` image (Node 22.23.2, Git 2.39.5). Each command begins with its exact
authorized input: Candidate B plus only output propagated by the generated-output rules. A
short-lived, network-disabled setup container uses real Git to create a fresh baseline commit
for those bytes. This is a **candidate-bound** baseline; Candidate B edits intentionally appear
clean. Git status can therefore detect changes during that command without treating canonical
Git history as validation input. A test that needs comparison against the original source
commit would require a different, explicitly bound mode.

The setup metadata lives outside Candidate B and the writable execution workspace. The command
container receives it through a read-only bind mount with `GIT_DIR` and `GIT_WORK_TREE` set by
the runner. Canonical `.git`, host Git configuration, credentials, SSH state, and host executables
are never mounted. HOME and Git configuration locations are isolated, hooks/templates are
disabled for setup, and both containers use `--network none` and `--pull never`. Git metadata is
deleted after the command and cannot be carried into the next command or the candidate artifact.
Generated paths containing a `.git` segment are rejected in this mode, even under a declared
generated root.
The existing candidate and generated-output manifests remain authoritative.

`scripts/smoke/validation-git-context-smoke.cjs` covers real Git status, work-tree discovery,
HEAD, absent remotes and global config, metadata write denial, command freshness, generated
output, environment hash binding, and fail-closed image mismatch. The existing container runner
and stale-generated-output suites cover source/config poisoning, symlinks, generated-output
scope, producer binding, compile failure, and runtime network isolation.
