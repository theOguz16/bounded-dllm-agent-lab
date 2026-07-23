# v0.1 Known Limitations

## Repository intelligence

v0.1 uses bounded repository facts and lightweight heuristics. It does not claim complete AST, import, symbol, interface, call-graph or Git co-change comprehension.

## Integrity

Artifacts and receipts are SHA-256 bound and tamper-evident under the assumed local filesystem trust model. They are not authenticated signatures against a malicious local administrator.

## Durability

The durable registry is local/single-host SQLite. It is not a distributed transaction or multi-host idempotency system.

## Benchmark scope

The observed token benchmark uses two declared TypeScript tasks and 18 real provider calls. The scope observation is one disposable repository case. These are release evidence for those declared cases, not universal model-quality claims.

## Cost interpretation

The operator-configured nano-USD/token values provide a normalized comparison snapshot. They are not infrastructure TCO and do not represent full RunPod compute, storage, idle time, networking or operational cost.

## Correctness boundary

Deterministic verifier approval means the mutation passed declared contract and boundary checks. Behavioral correctness depends on parse/apply, typecheck, tests, acceptance criteria and, where required, human review.

## Product surface

Historical research and mock code remains in the repository for reproducibility but is not exported through the canonical package root. The package has not been claimed as a production-hosted cloud service.

## Delivery

v0.1 does not automatically merge, deploy or override policy. GitHub delivery is controlled and evidence-bound.
