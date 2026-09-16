# Product V1 dogfood reports

`build-dogfood-report.cjs` turns a real `product-dogfood-live-run/v1` evidence artifact into two derived reports:

- `reports/product-v1/dogfood-report.json`
- `reports/product-v1/dogfood-report.md`

Generate them with:

```bash
node scripts/product/build-dogfood-report.cjs \
  --input=/path/to/product-dogfood-v1-live.json
```

Use `--output-dir=<path>` to write somewhere other than the repository report directory.

The report is derived only from observed dogfood evidence. Missing metrics remain `null`/`N/A`; human acceptance is never inferred from task success, and an incomplete pair remains incomplete. The report includes overall success, control, behavior, tokens, context, scope, duration, human acceptance, and the fixed Product V1 failure taxonomy.

The bounded-agent policy allowlists only this Product V1 report documentation and the report builder. Other `reports/product-v1/**` outputs are not allowlisted source mutations, while non-Product-V1 report namespaces remain explicitly forbidden. Report generation therefore does not grant a bounded coding agent authority to rewrite observed report/evidence files.
