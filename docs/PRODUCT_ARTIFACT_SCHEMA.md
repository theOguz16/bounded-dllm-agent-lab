# Product Artifact Schema

Stable artifact names for the product runtime:

| Artifact | Schema | Purpose |
| --- | --- | --- |
| `*-product-review.json` | `ReviewOutput` | Full machine-readable runtime result. |
| `*-product-review.md` | Markdown | Human-readable runtime review. |
| `pr-comment.md` | Markdown | PR-comment-ready summary. |
| `product-report-index.json` | report index v1 | List of review artifacts in a run directory. |
| `product-report-index.md` | Markdown | Human-readable artifact index. |
| `team-metrics.json` | `team-metrics/v1` | Team-level risk, cost and flow metrics. |
| `team-metrics.md` | Markdown | Dashboard-friendly team metrics report. |

`ReviewOutput` is intentionally verbose. Consumers that need a smaller stable
summary can derive `product-runtime-artifact/v1` with:

```ts
createProductRuntimeArtifactV1(review)
```

The stable summary includes:

- decision,
- risk level,
- summary metrics,
- finding count,
- remask region count,
- repair proposal count,
- workspace id,
- trace event count.
