# P7.8 relative-import evidence

The three R06 bounded-discovery records are reproducible as one narrow resolver defect: repository scripts import build output below `../dist/...`, while canonical intelligence deliberately excludes generated directories. The old candidate set stayed below `dist/` and therefore returned `target_not_found` even when the corresponding checked-in TypeScript module existed.

The fix maps only a normalized repository-root `dist/<path>.js` specifier to checked-in `<path>.ts`, `<path>.tsx`, `<path>.js`, or `<path>.jsx` candidates. It does not read or trust `dist`, accept traversal, follow symlinks, or turn a genuinely missing import into success.

The machine-readable inventory is `docs/results/P7_8_RELATIVE_IMPORT_EVIDENCE.json`. R06 itself stored only the aggregate failure code, not its triggering file/specifier; the inventory labels that limitation and records offline reproductions rather than presenting reconstructed fields as original observations.

The executable case fixtures are in `tests/fixtures/p7-8-relative-imports/cases.json`. The fixture smoke materializes each full frozen commit directly from Git, verifies the original source-file byte hash, emits the legacy candidate list and `target_not_found` diagnosis, then proves the new resolver selects the checked-in target. It also sends that read-only target through the mutation validator with an unchanged caller allowlist and requires `scope_violation`, proving read access does not become write authority.

| Task | Frozen source | Reproduced source import | Old reason | New target |
| --- | --- | --- | --- | --- |
| gate5 live ablation | `92d49b4` | `scripts/gate5-ablation-evidence-schema-smoke.cjs` → `../dist/.../canonical-runtime.js` | `target_not_found` | `packages/product-runtime/src/canonical-runtime.ts` |
| external repository runner | `8c9404e` | `scripts/gate5-external-repository-contract-smoke.cjs` → `../dist/.../canonical-runtime.js` | `target_not_found` | `packages/product-runtime/src/canonical-runtime.ts` |
| gate6 task schema | `44ec4f2` | `scripts/ag1c-task-to-seed-implementation-contract-smoke.cjs` → `../dist/.../task-to-seed-implementation-contract.js` | `target_not_found` | `packages/product-runtime/src/task-to-seed-implementation-contract.ts` |

Safety coverage retains fail-closed traversal, symlink, missing target, byte/file/edge/depth limits, and adds proof that a generated-only `dist` file cannot satisfy the import. Tree digests before and after analysis prove readable fixture files remain unchanged.
