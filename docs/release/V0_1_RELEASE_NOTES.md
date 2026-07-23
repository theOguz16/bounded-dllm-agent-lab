# Bounded Agent Runtime v0.1.0 Release Notes

## Release candidate status

The repository evidence chain is prepared for the `v0.1.0` tag. Publication and tag creation are a separate explicit step after `npm run verify:release` succeeds on the committed repository state.

## Included in v0.1

- Bounded repository context with hard budget enforcement.
- Adaptive, limited context expansion and provider fail-closed behavior.
- Mutation validation, deterministic verification, repair and remask gates.
- Controlled disposable repository apply.
- Isolated validation and structured acceptance evidence.
- Rollback and cross-process crash recovery.
- Durable single-host replay protection.
- Evidence-bound local branch, commit, remote push and draft-PR contracts.
- Observed scope-drift and token/cost release evidence.
- Canonical product runtime separated from historical research surfaces.

## Observed benchmark evidence

| Strategy | Accepted patches | Observed total tokens | Normalized cost per accepted patch |
| --- | ---: | ---: | ---: |
| Direct large context | 2 | 2474 | 1237 nano-USD |
| Fixed bounded context | 2 | 1650 | 825 nano-USD |
| Adaptive bounded context | 2 | 1626 | 813 nano-USD |

- Fixed bounded observed token savings versus direct: **33.3064%**
- Adaptive bounded observed token savings versus direct: **34.2765%**
- Observed scope case: **scope_clean**, with 0 hard violations and 0 unnecessary LOC.

## Verification

```bash
npm run verify:release
```

The release evidence is ready only when the command returns exit code `0`, all repository evidence hashes match and all 12 required artifacts are present.

## Limitations

See `docs/release/KNOWN_LIMITATIONS.md`. In particular, normalized token pricing is not infrastructure TCO, local durability is not distributed durability and the declared benchmark set is intentionally limited.
