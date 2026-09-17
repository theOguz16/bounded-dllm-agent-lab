# Product V1 dogfood v2 scope audit

The original `product-v1-first-20-real-dogfood` files are retained unchanged for historical reproducibility. The v2 suite is a new selection constrained to Product V1's existing-file update boundary.

Selection rules:

- source and reference are immutable 40-character commits;
- every reference diff contains only `M` operations against paths already present at source;
- dependency additions, file creation/deletion/rename and broad feature scaffolding are excluded;
- each public criterion has exactly one separately stored hidden evidence check;
- hidden checks are not included in provider input or mutable candidate scope;
- each check records the audited triad: source fails for the expected missing behavior, reference passes, and incomplete/wrong behavior fails;
- validation uses Node 22, `npm ci`, and disabled network.

Fifteen original tasks require at least one added file and are listed in `unsupported-v1.json`. They remain valid historical research tasks, but are not Product V1 success candidates.

The v2 main set contains exactly five small bug fixes, five existing-file behavior changes, five changes to existing regression files, and five small multi-file existing-file changes.
