# Migrating a persistent invocation journal out of a source repository

The durable provider-invocation journal (`provider-invocations.sqlite`) is
mutable runtime state. Since
`invocation-journal-location/v1`, the product refuses — with
`invocation_journal_inside_source_repository`, before any provider execution —
to place it inside the source repository, because journal writes there would
make the product's own bookkeeping look like source drift to the
repository-currentness guard.

The product default is `~/.bounded-agent/provider-invocations.sqlite`, which
is outside any source repository. That default is a **shared, unrelated
journal** on machines that already run the product elsewhere; it must never be
assumed to be an empty migration target. A repository-inside location only
arises from an explicit configuration: the
`BOUNDED_CODEX_INVOCATION_JOURNAL_PATH` environment variable or an
`invocationJournalPath` adapter option (for example a dogfood configuration
directory such as `.r06-dogfood/`).

This document is the operator procedure for moving an existing journal to an
external location **without mutating or losing any record**, including
historical ambiguous rows that later retry authorizations must still match.

## 0. Destination convention (never overwrite an existing journal)

The migration destination is a **project-specific subdirectory** of the
user-level state directory, deterministically named after the source
repository — never the shared product default and never an existing journal:

```sh
DEST_PARENT="$HOME/.bounded-agent/bounded-dllm-agent-lab"
DEST="$DEST_PARENT/provider-invocations.sqlite"
```

Requirements enforced by the procedure below:

* `DEST` is outside the source repository (a subdirectory of `~/.bounded-agent`).
* The migration **stops** if `DEST` already exists; it is never overwritten,
  appended to, or merged with another journal.
* `DEST_PARENT` is created with restrictive mode `0700`.

## 1. Stop product runs

Do not migrate while a product process may be writing the journal. Check that
no bounded CLI run, worker, or smoke is active. The SQLite online-backup API
used below is safe against readers, but pausing writers keeps the copy a clean
point-in-time snapshot.

## 2. Create the destination parent and guard against overwriting

```sh
SRC="/private/tmp/codex-canonical-discovery-integration/.r06-dogfood/provider-invocations.sqlite"
DEST_PARENT="$HOME/.bounded-agent/bounded-dllm-agent-lab"
DEST="$DEST_PARENT/provider-invocations.sqlite"

test ! -e "$DEST" || { echo "ABORT: $DEST already exists; refusing to overwrite." >&2; exit 1; }
mkdir -p "$DEST_PARENT" && chmod 700 "$DEST_PARENT"
test ! -e "$DEST" || { echo "ABORT: $DEST appeared during setup." >&2; exit 1; }
```

The `test ! -e "$DEST"` precondition is mandatory: the migration is
create-exclusive and must fail rather than overwrite or silently replace an
existing journal (in particular the shared
`~/.bounded-agent/provider-invocations.sqlite`, which holds different,
independent historical records).

## 3. Copy with SQLite backup semantics (never a plain `cp` while a WAL exists)

The journal runs in WAL mode, so uncheckpointed frames may live in
`provider-invocations.sqlite-wal`. A plain file copy of the main database
alone can lose those frames. Use the SQLite online-backup API, which produces
a consistent, checkpointed copy and preserves row contents exactly.

Preferred (sqlite3 CLI):

```sh
sqlite3 "$SRC" ".backup '$DEST'"
```

Equivalent (also sqlite3 CLI, writes a fully checkpointed copy):

```sh
sqlite3 "$SRC" "VACUUM INTO '$DEST'"
```

Alternative without the sqlite3 CLI (Node; `VACUUM INTO` never touches the
source contents):

```sh
SRC="$SRC" DEST="$DEST" node <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const src = new DatabaseSync(process.env.SRC, { readOnly: true });
src.exec(`VACUUM INTO '${process.env.DEST.replaceAll("'", "''")}'`);
src.close();
EOF
```

Both commands leave the source journal byte-identical.

## 4. Verify the copy before switching

```sh
sqlite3 "$DEST" "PRAGMA integrity_check;"
```

This must print `ok`. Then confirm the record count and the content hashes of
every row. Row integrity is `sha256(record_json)` — the same value stored in
each row's `record_hash` column:

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
' "$DEST"
```

For this repository's current journal, the output must contain **both**
protected historical records, unchanged:

* `sha256:82c707b314ca8807713ce9ed9e2b9372508c328469d9b46cd2eed976e62cb9d5`
  (`scope-discovery-a3c3e6c4624cdd997aa1f04e`, historical ambiguous row);
* `sha256:8b6ceb135ad00345c7bf7bfd5781a17d535d9f2b273d51e4c8ce8580addcf801`
  (`scope-discovery-2db208f48e7ee7ef763cf6dc`, successful discovery run).

Retry authorizations bind to those rows' `taskHash`/`model`/run identity,
which the copy preserves byte-for-byte. If either hash is missing or a row
reports `MISMATCH`, stop and do not switch.

## 5. Switch the configuration for this project

Point the environment at the **new per-project journal** — do not fall back to
the shared home default, which is a different, unrelated journal:

```sh
export BOUNDED_CODEX_INVOCATION_JOURNAL_PATH="$HOME/.bounded-agent/bounded-dllm-agent-lab/provider-invocations.sqlite"
```

(Update the dogfood/dot-env configuration file instead of the shell profile if
that is where the old path was set.) The next run reserves, writes, and
recovers against this external journal.

Journal consolidation is out of scope and deliberately not automated: merging
records from two existing journals (for example this one and the shared home
journal) would rewrite identities and must never happen implicitly. If it is
ever genuinely needed, it requires a separate, deliberate import/merge
operation with its own review and verification.

## 6. Keep the old repository-local journal as read-only archive

Do not delete or rewrite the source journal. Leave
`.r06-dogfood/provider-invocations.sqlite` (and any `-wal` / `-shm` siblings)
in place until **both** of the following hold:

1. the external copy has passed the verification in step 4; and
2. at least one successful product run has used the external journal.

Only then, optionally make the archived files read-only
(`chmod 400 .r06-dogfood/provider-invocations.sqlite*`) and/or move them out
of the repository entirely. Deletion is never performed by the product and
only ever by the operator, deliberately, after verification. Until removal,
the archived file does not affect future runs — the repository-currentness
guard rejects in-repository journal paths up front — but moving it out of the
repository is recommended so the repository stays free of runtime state.
