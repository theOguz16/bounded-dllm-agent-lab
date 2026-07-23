# AG.1b — Repository Intelligence Context Binding

## Status

AG.1b integrates the canonical repository intelligence primitive with the
adaptive Context Sufficiency Gate before coder execution.

The active development entrypoint is:

```text
canonical-product-runtime/v0.2-dev
```

The published `v0.1.0` release remains immutable on its annotated Git tag.
Post-v0.1 evidence is tracked separately and does not rewrite the v0.1 release
artifact hashes.

## Canonical flow

```text
seed files
→ canonical repository intelligence
→ AST import/export/symbol graph
→ bounded dependency closure
→ content-hash evidence validation
→ context binding receipt
→ adaptive context sufficiency
→ coder provider
```

The dependency closure becomes the required source context and the hard
context allowlist. Required test files may be added only when they exist in the
same intelligence snapshot.

## Fail-closed boundaries

Coder execution is not reached when:

- repository intelligence is blocked or invalid;
- the intelligence hash is invalid;
- initial evidence is outside the intelligence-derived boundary;
- evidence bytes or hashes are stale;
- a required test is absent;
- an allowed file is also forbidden;
- the required context-request provider fails.

The binding receipt and the graph summary delivered to the coder are
canonical-JSON hashed.

## Determinism correction

AG.1a originally derived `repositoryIdentityHash` from the absolute checkout
path. AG.1b changes this to a sorted path/content-hash snapshot. Identical
repository bytes now produce identical repository identity, intelligence and
binding hashes across different checkout directories.

## Evidence

Generate and verify:

```bash
npm run generate:ag1b-evidence
npm run verify:ag1b
```

Artifact:

```text
reports/ag/AG1B_REPO_INTELLIGENCE_CONTEXT_BINDING.json
```

Its evidence class is `deterministic_fixture`. It verifies integration,
integrity and negative fixtures. It is not live-model task-quality, latency,
token-savings or infrastructure-cost evidence.
