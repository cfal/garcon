# SQLite: bun:sqlite against rusqlite

Checked 2026-11-27 against Bun 1.4.5 and rusqlite 0.43.0 with libsqlite3-sys 0.40.0
(`bundled`), built with Rust 1.99.1 and gcc 13.3. Every "original" result below is the
output of a Bun 1.4.5 script on that input.

## Where the original uses it

Twenty-eight files outside tests import `bun:sqlite`. A single-line scan finds 147
`db.query(sql)` calls (cached statements), 5 `db.prepare`, 6 `db.transaction`, and no
custom SQL function, hook, collation, `loadExtension`, blob API, backup, serialize, or
in-memory database.

- Ledger: `server/controller/ledger/connection-setup.ts:26` opens `new Database(path)`;
  `:47` to `:50` set `journal_mode = WAL`, `synchronous = NORMAL` or `FULL`,
  `foreign_keys = ON`, `busy_timeout = 5000`; `:84` sets `user_version = 3`; `:174`
  runs `wal_checkpoint(PASSIVE)` before `close()`. `sqlite-operations.ts:16` runs
  `BEGIN IMMEDIATE`, then `COMMIT`, and `ROLLBACK` only when `db.inTransaction`.
  `failure-fences.ts:84` and `store.ts:640` check `error.code` for `SQLITE_CORRUPT`,
  the `SQLITE_CORRUPT_` prefix, and `SQLITE_NOTADB`. `activity-query.ts:10` opens a
  second read-only connection.
- Tickets and pull-request reviews: `server/controller/lib/private-sqlite.ts:41` opens
  with `{ strict: true, readwrite: true, create: false }`; `:64` sets
  `foreign_keys=ON` and `synchronous=FULL` and reads both back. Tickets:
  `server/controller/tickets/store.ts:27` to `:46`, `:68` (`transaction(...).immediate()`),
  `:98` (`PRAGMA quick_check(1)`). Reviews: `pull-request-reviews/store.ts:113`;
  `schema.ts:37` has generated columns that call `json_extract`.
- Search: `server-agents/common/src/search/schema.ts:141` to `:146` (pragmas),
  `:149` to `:164` (FTS5 configuration), `:166` to `:204` (validation on open),
  `:265` to `:273` (read-only reader with `busy_timeout = 2000` and `temp_store = MEMORY`),
  `query.ts:479` (`MATCH ?` and `rank`).
- Shell native store: `server-agents/shell/src/native-store.ts:88` and `:106`
  (`journal_mode = DELETE`, `synchronous = EXTRA`). Cursor history:
  `server-agents/cursor/src/agents/cursor/history-loader.ts:275` opens a file Cursor wrote.

## Behavior the port must keep

- Pragmas in the original's order, per store; `user_version`; schema text byte for byte.
- A stored integer and a stored real both arrive as a JavaScript `number`.
- `error.code` is the name of SQLite's extended result code and `error.errno` its number.
- SQLite creates files with mode 0644; the stores change them to 0600 and use 0700 directories.
- The ledger writes through `BEGIN IMMEDIATE` on the connection, not a transaction object.

## Rust crate, built with Rust 1.99.1

`rusqlite = "0.43.0"` with feature `bundled` only. It carries SQLite 3.54.1, source id
`2026-10-16 555e07ef...`, the same version and source id as Bun 1.4.5. FTS5 with the
`unicode61`, `porter`, `ascii`, and `trigram` tokenizers, `fts5vocab`, and the JSON
functions are in both. Differences in `PRAGMA compile_options` (51 entries in each):

- Only in Bun: `ENABLE_MATH_FUNCTIONS`, `ENABLE_PERCENTILE`, `ENABLE_GEOPOLY`,
  `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_RBU`, `ENABLE_UPDATE_DELETE_LIMIT`.
- Only in rusqlite: `DEFAULT_FOREIGN_KEYS`, `ENABLE_STAT4`, `ENABLE_API_ARMOR`,
  `ENABLE_LOAD_EXTENSION`, `SOUNDEX`, `USE_URI`, `HAVE_ISNAN`.
- Different value: `MAX_VARIABLE_NUMBER`, 250000 in Bun and 32766 in rusqlite.

The original's SQL uses nothing from the first group: a scan for math, percentile, and
geopoly function names in SQL under `server/` and `server-agents/` finds JavaScript
calls and the core `json_valid`, `json_type`, `json_set` only.

## Traps

Connections, statements, and parameters.

| Input | Original | rusqlite 0.43.0 with `bundled` |
| --- | --- | --- |
| fresh connection, `PRAGMA foreign_keys` | `0` | `1`, from `DEFAULT_FOREIGN_KEYS` |
| fresh connection, `PRAGMA busy_timeout` | `0` | `5000`; rusqlite sets it at open (`src/inner_connection.rs:90`) |
| `BEGIN IMMEDIATE` while another connection holds the write lock | `SQLITE_BUSY`, `database is locked`, at once | the same error after 5.0 s, the default timeout |
| `db.query("SELECT ? AS a").get()`, and a named parameter not supplied | `null` | `InvalidParameterCount(0, 1)`: `Wrong number of parameters passed to query. Got 0, needed 1` |
| `db.query("SELECT ?1, ?2").get(1)` | `Error`: `SQLite query expected 2 values, received 1` | `InvalidParameterCount(2, 1)`: `Got 1, needed 2` |
| `new Database(path, { create: false })` on a missing file | `SQLITE_CANTOPEN`, `unable to open database file` | the same text followed by `: <path>` |
| a column that does not exist (`SELECT b FROM t`, `SELECT nope FROM r`) | `SQLITE_ERROR`, `no such column: b` | `no such column: nope in SELECT nope FROM r at offset 7`; rusqlite appends the statement, and `SqlInputError` holds the message alone in `msg` |
| `db.query(sql)` twice | one statement cached per SQL text (cache size not verified) | `prepare_cached` keeps an LRU of 16 (`src/lib.rs:173`); `prepare` caches nothing |
| `db.transaction(fn)`, `.immediate()`, a nested call | `BEGIN DEFERRED`, then `BEGIN IMMEDIATE`, then a savepoint | `transaction()` is deferred too; `transaction_with_behavior(Immediate)`; nesting is `savepoint()` |
| `db.transaction(async () => ...)` | commits before the body runs | not expressible |

Values.

| Input | Original | rusqlite |
| --- | --- | --- |
| `SELECT 1.0`, then `SELECT 9223372036854775807` | `number` 1, then `number` 9223372036854776000 | `ValueRef::Real(1.0)`, then `Integer(9223372036854775807)`; `get::<i64>` fails on the first with `Invalid column type Real` |
| bind `1.0`, `1e15`, `9007199254740991`, `true` | `typeof` is `integer` | `real` for every `f64`; `true` is `integer` 1 |
| bind `1e18`, 2 to the power of 53, `-0`, `0.5` | `real` | `real` |
| bind `NaN`, `Infinity` | `NULL`, REAL `Inf` | the same |
| bind `undefined` or `{}` | `NULL` | not expressible; `Option::None` is `NULL` |
| bind a string with a lone surrogate, read it back | the string with U+FFFD in its place | a Rust `String` cannot hold the input |
| bind `9007199254740993n` | INTEGER 9007199254740993, read as 9007199254740992 | an `i64` bind stores the same integer |

So the port binds a JavaScript-originated number as `i64` when it is a safe integer and
as `f64` otherwise, and reads a numeric column as `f64` from `Integer` or `Real` alike.

Errors. `errno` of the original and the extended code of rusqlite are equal; the
message text is equal too.

| Input | Original `code`, `errno` | rusqlite `ErrorCode`, extended code |
| --- | --- | --- |
| a damaged header | `SQLITE_NOTADB`, 26 | `NotADatabase`, 26 |
| a damaged page, a truncated file | `SQLITE_CORRUPT`, 11 | `DatabaseCorrupt`, 11 |
| write on a read-only connection | `SQLITE_READONLY`, 8 | `ReadOnly`, 8 |
| duplicate unique value | `SQLITE_CONSTRAINT_UNIQUE`, 2067 | `ConstraintViolation`, 2067 |
| `NULL` into a `NOT NULL` column | `SQLITE_CONSTRAINT_NOTNULL`, 1299 | `ConstraintViolation` |
| a failing `CHECK` | `SQLITE_CONSTRAINT_CHECK`, 275 | `ConstraintViolation` |
| a failing foreign key | `SQLITE_CONSTRAINT_FOREIGNKEY`, 787 | `ConstraintViolation` |
| BLOB into a `STRICT` `TEXT` column | `SQLITE_CONSTRAINT_DATATYPE`, 3091 | `ConstraintViolation` |
| text into an `INTEGER PRIMARY KEY` | `SQLITE_MISMATCH`, 20 | `TypeMismatch`, 20 |
| `wal_checkpoint(PASSIVE)` on a read-only connection during another connection's write | `SQLITE_IOERR_WRITE`, 778 | `SystemIoFailure`, 778 |

rusqlite has no code name. The `SQLITE_CORRUPT_` family is 267 (`VTAB`), 523
(`SEQUENCE`), and 779 (`INDEX`) in
`libsqlite3-sys-0.40.0/src/bindgen_bundled_version.rs`. Take the message from
`sqlite_error()` or `msg`; `Display` of rusqlite adds the statement and an offset.

Schema text. Two stores compare DDL text and reject the database when it differs.

| Input | Original | Result |
| --- | --- | --- |
| tickets: `sqlite_schema.sql` against `TICKET_SCHEMA_V1` | `tickets/store.ts:94`: equal after `trim()`, else `Unrecognized ticket schema.` | |
| search: DDL reflowed onto fewer lines, database created by rusqlite | `openSearchDatabase` answers `recreated: true`: the database is deleted and created again | with the original's line breaks kept: `recreated: false` |
| search: `PRAGMA auto_vacuum` | must be `2` on open (`schema.ts:172`); it is 2 only after the `VACUUM` at `schema.ts:233` | a database made without that `VACUUM` reads `0` |
| search: `search_chunks_fts_config` | `automerge` 4, `crisismerge` 1000, `secure-delete` 1, `rank` `bm25(1.0)`, and `version` 4 written by FTS5 | same rows |

SQL results that differ from JavaScript. Both engines agree, so the port keeps them.

| Input | Original | Note |
| --- | --- | --- |
| `ORDER BY` a text column holding U+FFFF and U+10000 | U+FFFF first | UTF-8 byte order; the default `sort()` in JavaScript puts U+10000 first |
| `CAST(1.0e-5 AS TEXT)` | `1.0e-05` | JavaScript prints `0.00001` |
| `json_extract('{"a":9007199254740993}', '$.a')` compared with a bound 9007199254740992 | `0` | the integer stays exact inside SQLite |
| `json_extract('not json', '$.a')` | `SQLITE_ERROR`, `malformed JSON` | one damaged row makes the query throw |

## Cross-implementation results

- Ledger made by the original's `openConnection`: rusqlite reads `user_version` 3, WAL,
  the same `sqlite_master` text, and file mode 0600. rusqlite then wrote one `current`
  view and two rows; the original's `loadViews`, `nextOrdinal`, and
  `decodeStoredLedgerRow` read all three.
- Search: a database with the search schema and 142 rows has the same SHA-256 whether
  Bun or rusqlite creates it. Its 223 `fts5vocab` terms and the `rank` of 47 `MATCH`
  queries are equal in all four pairings of writer and reader.

## Sources

- `bun:sqlite` declarations: `node_modules/.bun/bun-types@1.4.3/node_modules/bun-types/sqlite.d.ts:14`
  (binding types), `:36` to `:84` (`strict`, `safeIntegers`), `:1272` to `:1302` (`SQLiteError`).
- rusqlite 0.43.0 in the cargo registry: `src/lib.rs:173` (cache size), `:1336` (default
  open flags), `src/inner_connection.rs:90` (busy timeout), `src/transaction.rs:107`
  and `:160` (transactions and savepoints); [docs.rs](https://docs.rs/rusqlite/0.43.0/rusqlite/).
- SQLite: [compile-time options](https://www.sqlite.org/compile.html), [result codes](https://www.sqlite.org/rescode.html),
  [FTS5](https://www.sqlite.org/fts5.html).

## Not verified

- `strict: true` in Bun 1.4.5: no difference from the default on the inputs tried.
- `MAX_VARIABLE_NUMBER`: other limits failed first in both engines.
- The tickets and pull-request-review databases were not created through the original's code.
- A damaged FTS5 index: the code the original reports was not provoked.
