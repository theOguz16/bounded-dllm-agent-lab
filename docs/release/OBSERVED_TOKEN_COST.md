# Observed Token and Cost Evidence

This release artifact was generated from explicit live provider calls.

- Provider: `runpod-llama-cpp`
- Model: `qwen2.5-coder-7b`
- Captured at: `2026-07-23T13:33:09.691Z`
- Task set hash: `sha256:21e6ebd9d26a9a89a786ceed08c228529499bf5ce6d2b810851abebfde257df5`
- Release-claim eligible: `true`
- Price source: `operator_configured`
- Input nano-USD/token: 1
- Output nano-USD/token: 1

## Strategy totals

| Strategy | Observed tokens | Observed cost nano-USD | Accepted patches |
|---|---:|---:|---:|
| Direct large context | 2474 | 2474 | 2 |
| Fixed bounded context | 1650 | 1650 | 2 |
| Adaptive bounded context | 1626 | 1626 | 2 |

## Direct baseline comparisons

- Fixed token savings rate: `0.333064`
- Adaptive token savings rate: `0.342765`
- Fixed cost savings rate: `0.333064`
- Adaptive cost savings rate: `0.342765`

The price snapshot is an explicit operator or provider-published configuration.
For self-hosted inference it is not a complete infrastructure TCO calculation unless the operator-configured rate incorporates that cost.
