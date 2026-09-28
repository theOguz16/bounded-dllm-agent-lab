# Live session interface

`benchmark-manifest.json` contains the frozen benchmark definition. The live session ID is supplied on every invocation and is not part of the task hashes or experimental variables. The historical session field in the freeze commit is excluded from the current manifest; all other fields and all five task objects match that commit.

Use one unique ID of the form `robustness-v1-YYYY-MM-DD-rN` for both preflight stages and every observation. The commands below show the interface; they are not a request to start a live session.

```sh
node preflight.cjs --session-id <id> --expected-head=<benchmark-commit-sha>
node preflight.cjs --session-id <id> --post-push --expected-head=<benchmark-commit-sha> --expected-remote=<benchmark-commit-sha>
node run-observation.cjs --inspect-session --session-id <id>
node run-observation.cjs R1 normal --session-id <id>
```

The initial preflight refuses any existing persistent session directory. A failed or stopped session is not resumable. Post-push preflight verifies the initial session ID and writes to the same directory. The runner requires both passing preflight records with that exact ID. Inspection is read only and shows remaining observation identities without invoking a provider.

Each observation identity includes the session ID, protocol version, frozen task hash, arm, and execution position. The ledger reserves an identity before generation and requires the previous identities to be completed in frozen order. The normalized observation and final session summary record the supplied session ID.

The frozen `PROTOCOL.md` retains its original example commands as historical protocol evidence. Add `--session-id <id>` as shown above when invoking the corrected harness.
