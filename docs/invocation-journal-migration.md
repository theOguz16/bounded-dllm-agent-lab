# Migrating a persistent invocation journal out of a source repository

The durable provider-invocation journal (`provider-invocations.sqlite`) is
mutable runtime state. Since
`invocation-journal-location/v1`, the product refuses — with
`invocation_journal_inside_source_repository`, before any provider execution —
to place it inside the source repository, because journal writes there would
make the product's own bookkeeping look like source drift to the
repository-currentness guard.

The default location is `~/.bounded-agent/provider-invocations.sqlite`, which
is outside any source repository. A repository-inside location only arises
from an explicit configuration: the `BOUNDED_CODEX_INVOCATION_JOURNAL_PATH`
environment variable or an `invocationJournalPath` adapter option (for example
a dogfood configuration directory such as `.r06-dogfood/`).

This document is the operator procedure for moving an existing journal to an
external location **without mutating or losing any record**, including
historical ambiguous rows that later retry authorizations must still match.

## 1. Stop product runs

Do not migrate while a product process may be writing the journal. Check that
no bounded CLI run, worker, or smoke is active. The SQLite online-backup API
used below is safe against readers, but pausing writers keeps the copy a clean
point-in-time snapshot.

## 2. Copy with SQLite backup semantics (never a plain `cp` while a WAL exists)

The journal runs in WAL mode, so uncheckpointed frames may live in
`provider-invocations.sqlite-wal`. A plain file copy of the main database
alone can lose those frames. Use the SQLite online-backup API, which produces
a consistent, checkpointed copy and preserves row contents exactly.

Preferred (sqlite3 CLI):

```sh
mkdir -p "$HOME/.bounded-agent"
sqlite3 /path/to/old/provider-invocations.sqlite \
  ".backup '$HOME/.bounded-agent/provider-invocations.sqlite'"
```

Alternative (Node, no sqlite3 CLI required — `VACUUM INTO` writes a
fully checkpointed copy and never touches the source contents):

```sh
node -e '
const { DatabaseSync } = require("node:sqlite");
const src = new DatabaseSync("/path/to/old/provider-invocations.sqlite", { readOnly: true });
src.exec("VACUUM INTO '"'"'$HOME/.bounded-agent/provider-invocations.sqlite'"'"'");
src.close();
'
```

Both commands leave the source journal byte-identical.

## 3. Verify the copy before switching

```sh
sqlite3 "$HOME/.bounded-agent/provider-invocations.sqlite" "PRAGMA integrity_check;"
```

Then confirm the record count and the content hashes of any historical rows
that must be preserved. Row integrity is `sha256(record_json)` — the same
value stored in each row's `record_hash` column:

```sh
node -e '
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
for (const r of db.prepare(
  "SELECT run_id, record_json, record_hash FROM provider_invocations").all()) {
  const h = "sha256:" + createHash("sha256").update(r.record_json).digest("hex");
  console.log(r.run_id, h === r.record_hash ? "intact" : "MISMATCH", h);
}
db.close();
' "$HOME/.bounded-agent/provider-invocations.sqlite"
```

If specific historical hashes were recorded (for example an ambiguous
`outcome_unknown` row), assert they appear in the output unchanged. Retry
authorizations bind to those rows' `taskHash`/`model`/run identity, which the
copy preserves byte-for-byte.

## 4. Switch the configuration

Point the environment or dogfood configuration at the external location:

```sh
export BOUNDED_CODEX_INVOCATION_JOURNAL_PATH="$HOME/.bounded-agent/provider-invocations.sqlite"
```

(Update the dogfood/dot-env configuration file instead of the shell profile if
that is where the old path was set.) The next run reserves, writes, and
recovers against the external journal.

## 5. Archive — do not delete — the old journal

Keep the original files (`provider-invocations.sqlite`, and any `-wal` /
`-shm` siblings) in place as an archive until the external journal has
processed at least one successful invocation. Deletion is irreversible and is
never performed by the product; only the operator removes the archive, and
only after verification. Because the repository-currentness guard rejects
in-repository journal paths up front, the archived file does not affect future
runs even while it still sits in the repository — but removing it (or moving
it out of the repository entirely) is recommended so the repository stays free
of runtime state.
