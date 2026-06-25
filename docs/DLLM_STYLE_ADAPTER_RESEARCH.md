# dLLM-Style Adapter Research Track

Sprint 6 adds the first product-runtime contract for testing dLLM-style adapters
without making dLLM a required runtime dependency.

## Roles

The experiment separates three roles:

- `direct_patch`: tests whether a model can propose a patch directly.
- `verifier`: tests whether a model helps identify boundary or authority risk.
- `remask`: tests whether a model helps repair verifier-marked failed regions.

## Context Width

Each role can be measured with:

- `narrow`: role-specific bounded workspace fields.
- `broad`: the same packet plus wider diff, claims, events and role-view context.

## Metrics

The v1 report tracks:

- token estimate,
- scope drift,
- remask repair success,
- cost delta against the broad packet.

## Product Rule

Adapter outputs are proposals. They do not replace runtime authority, verifier,
merge safety or final decision control. The runtime writes validated adapter
claims back to the shared workspace and keeps deterministic merge control.
