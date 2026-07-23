# v0.1 Threat Model

## Protected assets

- Repository source and Git metadata.
- Allowed and forbidden path policy.
- Context authorization and mutation hashes.
- Apply, validation, rollback and recovery receipts.
- Durable consumption keys.
- Evidence-bound branch, commit and draft-PR delivery contracts.
- Provider usage and release artifact integrity.

## Trust boundaries

```text
User task and policy
→ context selection and authorization
→ model/provider boundary
→ deterministic mutation and governance gates
→ disposable repository apply
→ isolated validation
→ durable local registry
→ controlled Git/GitHub delivery
```

## In-scope attacker or failure capabilities

| Capability | v0.1 treatment |
| --- | --- |
| Malformed or adversarial model output | Schema and mutation validation; fail closed |
| Forbidden or unexpected file mutation | Hard scope gate and soft-scope reporting |
| Provider timeout, invalid response or missing usage | No approval; observed claims withheld |
| Stale handoff or replay | Hash binding and durable consumption key |
| Apply or validation crash | Sealed rollback and cross-process recovery |
| Evidence file tampering | Repository-bound SHA-256 mismatch blocks release |
| Legacy mock surface exposed as product API | Package export boundary blocks release |
| Acceptance evidence missing or mismatched | Task is not accepted |

## Assumptions

- The local operating system, Node runtime and Git executable are trusted.
- The repository owner controls provider and GitHub credentials.
- The single-host filesystem and SQLite volume are available and not maliciously rewritten during one verification.
- Required validation commands are explicitly allowlisted by the task contract.

## Out of scope for v0.1

- Protection against a malicious local administrator who can rewrite files and hashes together.
- Distributed multi-host reservation and transaction guarantees.
- Automatic merge, deployment or production rollout.
- Full repository semantic comprehension or a complete call graph.
- Universal behavioral correctness proof.
- Authenticated signatures, KMS-backed attestations or append-only remote audit.

## Security claim

v0.1 is fail-closed under its documented local/self-hosted trust model. It is tamper-evident, not cryptographically authenticated against an actor with unrestricted local write access.
