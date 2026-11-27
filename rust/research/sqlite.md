# SQLite: bun:sqlite against rusqlite

Checked 2026-11-27 against Bun 1.4.5, Bun 1.4.3, and rusqlite 0.43.0 with libsqlite3-sys 0.40.0
(`bundled`), built with Rust 1.99.1 and gcc 13.3. Every "original" result is the output of a Bun
script on that input. CI pins Bun 1.4.3 (`.github/workflows/code-health.yml:21`) and `build-exe.yml:57`
downloads it, so the shipped original runs 1.4.3. The tables give 1.4.5; where 1.4.3 differs it has
its own table.

## Where the original uses it

Twenty-eight files outside tests import `bun:sqlite`: 147 `db.query` calls (cached statements),
9 `prepare`, 6 `transaction`, 5 `iterate`, and no custom SQL function, hook, collation,
`loadExtension`, blob API, backup, serialize, or in-memory database. Every parameter is positional.

- Ledger: `server/controller/ledger/connection-setup.ts:26` opens `new Database(path)`;
  `:47` to `:50` set `journal_mode = WAL`, `synchronous = NORMAL` or `FULL`,
  `foreign_keys = ON`, `busy_timeout = 5000`; `:84` sets `user_version = 3`; `:174`
  runs `wal_checkpoint(PASSIVE)` before `close()`. `sqlite-operations.ts:16` runs
  `BEGIN IMMEDIATE`, then `COMMIT`, and `ROLLBACK` only when `db.inTransaction`.
  `failure-fences.ts:87` and `store.ts:643` check `error.code` for `SQLITE_CORRUPT`,
  the `SQLITE_CORRUPT_` prefix, and `SQLITE_NOTADB`. `activity-query.ts:10` opens a
  second read-only connection.
- Tickets and pull-request reviews: `server/controller/lib/private-sqlite.ts:41` opens
  with `{ strict: true, readwrite: true, create: false }`; `:64` sets `foreign_keys=ON`
  and `synchronous=FULL` and reads both back. Tickets: `server/controller/tickets/store.ts:27`
  to `:46`, `:42` (`transaction(...).immediate()`), `:93` (schema compared), `:98` (`quick_check`).
  Reviews: `pull-request-reviews/store.ts:113`; `schema.ts:37`: generated columns over `json_extract`.
- Search: `server-agents/common/src/search/schema.ts:141` to `:146` (pragmas), `:149` to
  `:164` (schema, FTS5 configuration, `user_version = 11`), `:166` to `:211` (validation on
  open), `:233` (`VACUUM` on a fresh database), `:264` to `:277` (read-only reader with
  `busy_timeout = 2000` and `temp_store = MEMORY`), `query.ts:479` (`MATCH ?` and `rank`).
- Shell native store: `server-agents/shell/src/native-store.ts:88` and `:106`
  (`journal_mode = DELETE`, `synchronous = EXTRA`). Cursor history:
  `server-agents/cursor/src/agents/cursor/history-loader.ts:275` opens a file Cursor wrote.

## Behavior the port must keep

- Pragmas in the original's order, per store; `user_version`; schema text byte for byte.
  The ledger writes through `BEGIN IMMEDIATE` on the connection, not a transaction object.
- A stored integer and a stored real both arrive as a JavaScript `number`.
- `error.code` is the name of SQLite's extended result code and `error.errno` its number.
- SQLite creates files with mode 0644; the stores change them to 0600 and use 0700 directories.

## Rust crate, built with Rust 1.99.1

`rusqlite = "0.43.0"` with feature `bundled` only. It carries SQLite 3.54.1, source id
`2026-10-16 555e07ef...`, as Bun 1.4.5 does; Bun 1.4.3 carries 3.53.4, source id
`2026-07-24 19:02:57 bf7c7f30...`. FTS5 with the `unicode61`, `porter`, `ascii`, and `trigram`
tokenizers, `fts5vocab`, and the JSON functions are in all three. Differences in
`PRAGMA compile_options` (51 entries in Bun 1.4.5 and in rusqlite, 50 in Bun 1.4.3):

- Only in Bun: `ENABLE_MATH_FUNCTIONS`, `ENABLE_PERCENTILE`, `ENABLE_GEOPOLY`,
  `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_RBU`, `ENABLE_UPDATE_DELETE_LIMIT`.
- Only in rusqlite: `DEFAULT_FOREIGN_KEYS`, `ENABLE_STAT4`, `ENABLE_API_ARMOR`,
  `ENABLE_LOAD_EXTENSION`, `SOUNDEX`, `USE_URI`, `HAVE_ISNAN`.
- Different value: `MAX_VARIABLE_NUMBER`, 250000 in Bun and 32766 in rusqlite. Bun 1.4.3
  against 1.4.5: another `COMPILER` string and no `MAX_SCHEMA=10000000`.

The original's SQL uses nothing from the first group: a scan under `server/` and
`server-agents/` finds JavaScript calls and the core `json_valid`, `json_type`, `json_set`.

## Traps

Connections, statements, and parameters. Bun 1.4.3 is equal unless the last table says otherwise.

| Input | Original | rusqlite 0.43.0 with `bundled` |
| --- | --- | --- |
| fresh connection, `PRAGMA foreign_keys`, then `PRAGMA busy_timeout` | `0`, then `0` | `1`, from `DEFAULT_FOREIGN_KEYS`; `5000`, set at open (`src/inner_connection.rs:90`) |
| `BEGIN IMMEDIATE` while another connection holds the write lock | `SQLITE_BUSY`, `database is locked`, at once | the same error after 5.0 s, the default timeout |
| `db.query("SELECT ? AS a").get()`, and one extra parameter | `null`; the extra parameter is ignored | `InvalidParameterCount(0, 1)`: `Wrong number of parameters passed to query. Got 0, needed 1` |
| `db.query("SELECT ?1, ?2").get(1)`, and `[1, 2]` for one `?` | `Error`: `SQLite query expected 2 values, received 1`, and `...1 values, received 2` | `InvalidParameterCount(1, 2)`: `Wrong number of parameters passed to query. Got 1, needed 2`; and `InvalidParameterCount(2, 1)`: `Got 2, needed 1` |
| `new Database(missing, { strict: true, readwrite: true, create: false })` | `SQLITE_CANTOPEN`, `unable to open database file` | the same text followed by `: <path>` |
| `SELECT rowid FROM wo`, a table `WITHOUT ROWID`; `SELECT nope(1)` | `SQLITE_ERROR`, `no such column: rowid`; `no such function: nope` | `no such column: rowid in SELECT rowid FROM wo at offset 7`; rusqlite's `SqlInputError` appends the statement and holds the message alone in `msg` |
| `db.query(sql)` twice | the same statement object, cached by SQL text (cache size not verified) | `prepare_cached` keeps an LRU of 16 (`src/lib.rs:173`); `prepare` caches nothing |
| `db.query("SELECT 1; SELECT 2")`; `exec` of three inserts; a query after `close()` | the first statement's rows; `changes` 3; `RangeError`: `Cannot use a closed database` | `prepare` and `execute` answer `MultipleStatement`; `execute_batch` gives no count; no counterpart |
| `db.transaction(fn)`, `.immediate()`, a nested call | `BEGIN DEFERRED`, then `BEGIN IMMEDIATE`, then a savepoint | `transaction()` is deferred too; `transaction_with_behavior(Immediate)`; nesting is `savepoint()` |
| `db.transaction(async () => ...)` | returns a Promise and commits before the body runs | not expressible |

Values.

| Input | Original | rusqlite |
| --- | --- | --- |
| `SELECT 1.0`, then `SELECT 9223372036854775807` | `number` 1, then `number` 9223372036854776000 | `ValueRef::Real(1.0)`, then `Integer(9223372036854775807)`; `get::<i64>` fails on the first with `Invalid column type Real` |
| bind `1.0`, `1e15`, `true`, `-0`, `1e18` | `typeof` is `integer`, `integer`, `integer`, `real`, `real` | `real` for every `f64`, so for the first two too; `true` is `integer` 1 |
| bind `NaN`, `Infinity`, `undefined`, `{}` | `NULL`, REAL `Inf`, `NULL`, `NULL` | `NULL` and REAL `Inf`; the last two are not expressible, `Option::None` is `NULL` |
| bind a `Uint8Array`, `Buffer`, or `DataView`; bind `9007199254740993n`, `2n ** 63n` | BLOB of those bytes; INTEGER 9007199254740993 read as 9007199254740992, and -9223372036854775808 | `Value::Blob`; an `i64` bind stores the same integers |
| bind `"a\ud800b"`, read it back | `"a\uFFFDb"`, bytes `61 EF BF BD 62` | a Rust `String` cannot hold the input |

So the port binds a JavaScript-originated number as `i64` when it is an integer up to 2^53 - 1
in absolute value, as Bun 1.4.5 does, and as `f64` otherwise. It reads a numeric column as
`f64` from `Integer` or `Real` alike.

Errors. `errno` of the original and the extended code of rusqlite are equal; the
message text is equal too.

| Input | Original `code`, `errno` | rusqlite `ErrorCode`, extended code |
| --- | --- | --- |
| a damaged header | `SQLITE_NOTADB`, 26 | `NotADatabase`, 26 |
| a damaged page, a truncated file | `SQLITE_CORRUPT`, 11 | `DatabaseCorrupt`, 11 |
| write on a read-only connection | `SQLITE_READONLY`, 8 | `ReadOnly`, 8 |
| duplicate unique value; `NULL` into `NOT NULL`; a failing `CHECK` | `SQLITE_CONSTRAINT_UNIQUE` 2067; `SQLITE_CONSTRAINT_NOTNULL` 1299; `SQLITE_CONSTRAINT_CHECK` 275 | `ConstraintViolation` with the same numbers |
| a failing foreign key; BLOB into a `STRICT` `TEXT` column | `SQLITE_CONSTRAINT_FOREIGNKEY` 787; `SQLITE_CONSTRAINT_DATATYPE` 3091 | `ConstraintViolation` with the same numbers |
| text into an `INTEGER PRIMARY KEY` | `SQLITE_MISMATCH`, 20 | `TypeMismatch`, 20 |
| `wal_checkpoint(PASSIVE)` on a read-only connection during another connection's write | `SQLITE_IOERR_WRITE`, 778 | `SystemIoFailure`, 778 |

rusqlite has no code name. The `SQLITE_CORRUPT_` family is 267 (`VTAB`), 523
(`SEQUENCE`), and 779 (`INDEX`) in
`libsqlite3-sys-0.40.0/src/bindgen_bundled_version.rs`. Take the message from
`sqlite_error()` or `msg`; `Display` of `SqlInputError` adds the statement and an offset.

Schema text. Three stores compare DDL text with the text they expect.

| Input | Original | Result |
| --- | --- | --- |
| tickets: `sqlite_schema.sql` against `TICKET_SCHEMA_V1` | `tickets/store.ts:93`: each `CREATE` statement, trimmed and sorted, must be equal, else `Unrecognized ticket schema.` | |
| search: a database rusqlite made, with the DDL reflowed onto one line, or with `user_version` 10 | reflowed: `recreated: false`, because `schema.ts:128` collapses whitespace before the comparison; version 10: `recreated: true`, the database is deleted and created again with version 11 | |
| search: `PRAGMA auto_vacuum` | must be 2 on open (`schema.ts:171`); it is 2 only after the `VACUUM` at `schema.ts:233` | a database made without that `VACUUM` reads `0` |
| search: `search_chunks_fts_config` | `automerge` 4, `crisismerge` 1000, `secure-delete` 1, `rank` `bm25(1.0)`, and `version` 4 written by FTS5 | same rows |

SQL results that differ from JavaScript. All three engines agree, so the port keeps them.

| Input | Original | Note |
| --- | --- | --- |
| `ORDER BY` a text column holding U+FFFF and U+10000; `CAST(1.0e-5 AS TEXT)` | U+FFFF first; `1.0e-05` | UTF-8 byte order, where the default `sort()` in JavaScript puts U+10000 first; JavaScript prints `0.00001` |
| `json_extract('{"a":9007199254740993}', '$.a')` compared with a bound 9007199254740992 | `0` | the integer stays exact inside SQLite |
| `json_extract('not json', '$.a')` | `SQLITE_ERROR`, `malformed JSON` | one damaged row makes the query throw |

Bun 1.4.3 against 1.4.5. The first row reaches the original: it binds `Number.MAX_SAFE_INTEGER`
as a cursor sentinel.

| Input | Bun 1.4.5 | Bun 1.4.3 |
| --- | --- | --- |
| bind `9007199254740991`; the largest and the most negative integer still bound as INTEGER | `typeof` `integer`; 9007199254740991 and -9007199254740991 | `typeof` `real`, stored as `9007199254740991.0`; 2251799813685247 and -2251799813685248 |
| bind `"a\ud800b"` and read it back | `"a\uFFFDb"` | `"a\ud800\udc62"`, bytes `61 F0 90 81 A2`: four bytes for the surrogate and `b` is lost |
| bind an `ArrayBuffer(2)`, a `Blob`, a `Date` | BLOB `0000`; a `TypeError` for each of the other two | `NULL` for each |
| `.get({ a: 1 })` for `$a` | `1` | `null` |
| `for (row of stmt.iterate()) break;`, then `exec("VACUUM")` | no error | `SQLITE_ERROR`, `cannot VACUUM - SQL statements in progress` |
| `exec("BEGIN IMMEDIATE; COMMIT")` while another connection holds the write lock | `SQLITE_BUSY`, `database is locked` | `SQLITE_ERROR`, `cannot commit - no transaction is active`; the single statement gives `SQLITE_BUSY` on both |

The other 175 lines of a 187-line matrix are equal: errors and codes, transactions, statement
lifecycle, `run().changes`, FTS5 configuration, JSON, math, and string functions. FTS5 vocabulary
and `MATCH` ranks on 142 rows are equal for 1.4.3, 1.4.5, and rusqlite, in every pairing.

## Cross-implementation results

- Ledger made by the original's `openConnection`: rusqlite reads `user_version` 3, WAL, the
  same `sqlite_master` text, and file mode 0600, then wrote one `current` view and two rows,
  which the original's `loadViews`, `nextOrdinal`, and `decodeStoredLedgerRow` read.
- Search made by the original's `openSearchDatabase` equals the store rusqlite creates from
  its DDL verbatim (same SHA-256); the original opens that store and a reflowed one with
  `recreated: false`, on Bun 1.4.3 and on 1.4.5.
- Tickets made by the original's `TicketStore` (15 objects, `user_version` 1): a clone rusqlite
  made from that DDL, with a `ticket_meta` row, opens in the original with the `storeId` rusqlite
  wrote. Pull-request reviews (24 objects, `user_version` 0): the rusqlite clone has the same
  SHA-256 and opens in the original.

## Sources

- `bun:sqlite` declarations: `node_modules/.bun/bun-types@1.4.3/node_modules/bun-types/sqlite.d.ts:14`
  (binding types), `:36` to `:84` (`strict`, `safeIntegers`), `:1272` to `:1302` (`SQLiteError`).
- rusqlite 0.43.0 in the cargo registry: `src/lib.rs:173` (cache size), `:1336` (default
  open flags), `src/inner_connection.rs:90` (busy timeout), `src/transaction.rs:107`
  and `:160` (transactions and savepoints); [docs.rs](https://docs.rs/rusqlite/0.43.0/rusqlite/).
- SQLite: [compile-time options](https://www.sqlite.org/compile.html), [result codes](https://www.sqlite.org/rescode.html),
  [FTS5](https://www.sqlite.org/fts5.html).

## Not verified

- `strict: true` changes one thing on either Bun: `.get({})` for `$a` throws
  `Missing parameter "a"`. The original binds positionally, where it changes nothing.
- `MAX_VARIABLE_NUMBER`: other limits failed first in every engine. A damaged FTS5 index:
  the code the original reports was not provoked.
- Which Bun a deployment runs decides between the two columns of the 1.4.3 table; that is
  for the manager to settle.
