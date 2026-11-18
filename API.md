# JavaScript and TypeScript API reference

The root module exports the synchronous API; import `@velr-ai/velr/worker`
for the async worker API. This reference is generated from the same API comments
included in the published type declarations and editor help.

Start with the [README](README.md), see [task guides](GUIDE.md) for workflows, and
use the [query language reference](QUERY_LANGUAGE.md) for Cypher.

All result handles require their parents to remain open. Close cursors, tables,
streams, traces, and transactions when finished; connection close invalidates its
children. Close is idempotent. Database operations can fail both at query start
and during result reads. Direct operations throw `VelrError` for runtime/query
failures, `VelrStateError` for closed handles, or `VelrTypeError` for invalid
arguments/conversions. Worker operations reject promises. A worker child
invalidated through a parent can reject with an ordinary `Error`; its
`closed` flag records closure of that individual handle and can remain false
after parent closure. Keep parents open until their children are finished.
In-memory databases
cannot create fulltext or vector indexes. Use a file path for those features.

Direct callbacks are synchronous: returned promises are not awaited. This applies
to transactions, savepoint scopes, row visitors, and row mappers. The worker
counterparts await supported callbacks. Explicit transaction cancellation may end
the transaction; start a new one after it ends. Generic result types assert the
caller's expected shape and do not validate returned data.

## Cell

One value returned by a Velr result table.

Use `asJs()` for normal application code, or inspect `type`, `i64`, `f64`,
and `data` when a lossless representation is required.

### Cell.type

Runtime cell kind.

```ts
readonly type: CellType;
```

### Cell.i64

Integer payload for `bool` and `int64` cells.

```ts
readonly i64: bigint;
```

### Cell.f64

Floating-point payload for `double` cells.

```ts
readonly f64: number;
```

### Cell.data

Raw UTF-8 bytes for `text` and `json` cells.

```ts
readonly data: Buffer;
```

### Cell.constructor

Create a cell with its kind and matching payload: `i64` for bool/int64,
`f64` for double, and UTF-8 `data` for text/JSON. Defaults are zero/empty.
Most applications receive cells from query results.

```ts
constructor(type: CellType, i64 = 0n, f64 = 0, data: Buffer = Buffer.alloc(0))
```

### Cell.asJs

Convert this cell to an idiomatic JavaScript value.

By default, JSON cells are parsed, text cells are decoded as UTF-8, and
int64 cells become `number` only when the value is safe.

```ts
asJs(options: CellAsJsOptions = {}): CellValue
```

### Cell.asString

Decode a `text` or `json` cell as UTF-8.

Throws `VelrTypeError` for numeric, boolean, or null cells.

```ts
asString(): string
```

### Cell.asBuffer

Return a copy of the raw byte payload for this cell.

```ts
asBuffer(): Buffer
```

## Velr

Synchronous Velr database connection.

Import from the main package:

```ts
import { Velr } from "@velr-ai/velr";
```

The direct driver calls the native library on the current Node.js thread. Use
`VelrWorker` from `@velr-ai/velr/worker` when query execution should run in a worker
thread.

### Velr.open

Open a database for reading and writing.

Pass `null` or omit `path` for an in-memory database. A file path opens or
creates a persistent database. Fulltext and vector indexes require a
file-backed database. Opening does not migrate older supported databases;
use `needsMigration()` and `migrate()` before graph queries or transactions.
Close the connection after its queries and results are finished. Invalid arguments
throw `VelrTypeError`; open failures throw `VelrError`.

```ts
static open(path: string | null = null): Velr
```

### Velr.create

Create a new database and return its open connection.

Pass a new file path, or `null` or `":memory:"` for an in-memory database.
Use `options.inlineEdgeProperties` to choose the property at creation.
Existing paths, invalid options, and unsupported runtimes raise an error.
Close the returned connection or use it with `using`.

```ts
static create(path: string | null = null, options: CreateOptions = {}): Velr
```

### Velr.openReadonly

Open an existing supported database for reads, without creating,
initializing, migrating, or repairing it. Migrate a supported older database
on a writable connection, then reopen read-only connections before querying.
Close when finished. Missing files and unsupported schemas throw `VelrError`.

```ts
static openReadonly(path: string): Velr
```

### Velr.closed

Whether this connection has already been closed.

```ts
get closed(): boolean
```

### Velr.inlineEdgeProperties

Return a copy of the inline edge property names in configured order.

The selection remains available after reopening the database. Returns an
empty array when no property is selected. A closed connection or runtime
that cannot report the selection raises an error.

```ts
inlineEdgeProperties(): string[]
```

### Velr.schemaVersion

Return the schema version stored in the opened database.

```ts
schemaVersion(): number
```

### Velr.currentSchemaVersion

Return the schema version expected by the loaded Velr runtime.

```ts
currentSchemaVersion(): number
```

### Velr.needsMigration

Return `true` when the database schema is older than the runtime schema.

```ts
needsMigration(): boolean
```

### Velr.migrate

Explicitly migrate a writable database to the current schema and return
its versions, status, and applied steps. Call from maintenance code outside
an active transaction; read-only or failed migrations throw `VelrError`.
Migrate supported older databases before graph queries or transactions;
reopen read-only connections after another connection migrates the file.

```ts
migrate(): MigrationReport
```

### Velr.vacuum

Compact a writable current-schema database file outside any open
transaction. Returns no value; unmet prerequisites and maintenance
failures throw `VelrError`.

```ts
vacuum(): void
```

### Velr.registerVectorEmbedder

Register or replace a synchronous vector embedder.

Embedder-backed vector indexes reference this name from
`CREATE VECTOR INDEX ... OPTIONS { indexConfig: { embedder: 'name' } }`.
Register it separately on each connection that needs embeddings, including
after reopening a database; registration is not persisted with the file.
Registration itself, index creation/recovery, indexed writes or their
commit, and text queries through vector procedures can request embeddings.
Register before performing those operations. If an embedder-backed index
has pending transaction updates, searching it fails until the transaction
commits or rolls back.

Stored-vector indexes, such as `CREATE VECTOR INDEX ... ON (n.embedding)`,
index the vector/list property directly and do not use a registered
embedder. They query with numeric vectors/lists.

`OPTIONS { indexConfig: ... }` configures Velr vector indexes. Prefer
`` `vector.dimensions` `` and `` `vector.similarity_function` `` where they exist;
`dimensions` and `metric` are accepted aliases. `embedder` names a registered callback for
`ON EACH [...]` indexes, `embedder_fingerprint` stores application model/version metadata,
and `cache_policy` controls embedder-output caching with `required`, `best_effort`, or
`none`. It defaults to `required` with an embedder and `none` without one. Stored-vector
indexes require `none`. HNSW tuning uses `` `vector.hnsw.m` `` (`1..512`),
`` `vector.hnsw.ef_construction` `` (`1..3200`), and
`` `vector.hnsw.ef_search` `` (`1..3200`; default `64`). Velr validates
embedding dimensions and finite values.

Direct-driver callbacks must return synchronously. Use `VelrWorker` when
your embedder needs asynchronous work. Registration retains the callback
until replacement or connection close. Return one finite vector per input
in input order and with the requested dimensions. Do not call the same
connection from the callback; its failure fails the requesting operation.
Names must be nonempty and contain no NUL. Invalid names or callbacks throw
`VelrTypeError`; a closed connection throws `VelrStateError`. Unavailable
runtime support or registration/index failures throw `VelrError`.

```ts
registerVectorEmbedder(name: string, embedder: VectorEmbedder): void
```

### Velr.bindArrowIpc

Bind an Arrow IPC file/Feather v2 payload as a logical table.

The bytes are borrowed only for the duration of the call. IPC streams are
not accepted. Query the name with `UNWIND BIND('name') AS row`.
Invalid arguments throw `VelrTypeError`; import failures throw `VelrError`.

```ts
bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): void
```

### Velr.exec

Execute Cypher and return a stream of result tables.

Close the returned stream when finished, or use `run()`/`query()` for common
one-shot workflows.
A timeout covers execution and result iteration. Both can throw `VelrError`.

```ts
exec(cypher: string, options?: QueryOptions): Stream
```

### Velr.execOne

Execute Cypher and return exactly one result table.

Throws when the statement produces no tables or multiple tables.
A timeout covers execution and row reads, which can throw `VelrError`.
Close the table before its parent connection or transaction closes. Its
parent closes any remaining result handles automatically.

```ts
execOne(cypher: string, options?: QueryOptions): Table
```

### Velr.run

Execute Cypher and discard all result tables.

This is the preferred helper for DDL and writes where no rows are needed.
Pass `timeoutMs` to set an execution deadline.

```ts
run(cypher: string, options?: QueryOptions): void
```

### Velr.execute

Alias for `run()`.

```ts
execute(cypher: string, options?: QueryOptions): void
```

### Velr.transaction

Run a function inside a transaction.

The transaction commits when `fn` returns successfully and rolls back when
`fn` throws, unless the callback has already committed or rolled back.
The callback must be synchronous: a returned promise is not awaited.
Use `VelrWorker.transaction()` for asynchronous callbacks. The return value
of `fn` is returned unchanged; transaction failures throw `VelrError`.
Consume and close result handles before the callback ends; copied cells,
objects, and explain snapshots can outlive it. Only one transaction may be
active on a connection. Use the supplied transaction until it finishes;
use a separate connection for independent work. A writable transaction
reserves the writer slot; use a transaction on a separate read-only
connection for a snapshot while another connection writes.
Callback errors propagate unless rollback cleanup itself throws.

```ts
transaction<T>(fn: (tx: VelrTx) => T): T
```

### Velr.query

Execute Cypher and convert the single result table into objects.

Column names become object keys and cell conversion follows `Cell.asJs()`.
Use unique result aliases; Cypher rejects duplicate result column names.
The generic `T` is a caller assertion, without runtime shape validation.
Collects all rows in memory and closes the table on success or failure.
A timeout covers execution and collection; errors throw `VelrError`.

```ts
query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): T[]
```

### Velr.explain

Build an explain trace without executing the query.

Accepts query text only, without parameter bindings or query options.
Keep this connection and the returned trace open while reading it; closing
either invalidates the trace. Close the trace when finished. Its copied
`snapshot()` and `toCompactString()` results survive handle closure.
Invalid query text or runtime failures throw `VelrError`, invalid host
arguments throw `VelrTypeError`, and a closed connection throws `VelrStateError`.

```ts
explain(cypher: string): ExplainTrace
```

### Velr.explainAnalyze

Execute the query, including its writes, and return an analyzed explain trace.

Accepts query text only, without parameter bindings or query options.
Use `VelrTx.explainAnalyze()` and roll back that transaction when analysis
writes should be discarded. Keep this connection and the trace open while
reading it, then close the trace. Copied snapshots and strings survive
closure; the live trace does not. Query/runtime failures throw `VelrError`,
invalid host arguments throw `VelrTypeError`, and a closed connection
throws `VelrStateError`.

```ts
explainAnalyze(cypher: string): ExplainTrace
```

### Velr.beginTx

Start the connection's single explicit transaction.

Use its execution methods until it finishes. A writable transaction reserves
the writer slot when started. For a snapshot while another connection writes,
use a separate read-only connection and begin its transaction there.
Close result handles before `commit()` or `rollback()`, which consume the
transaction and close remaining children. `close()` rolls back uncommitted
work. Keep this connection open until finalization. An already-active
transaction or begin failure throws `VelrError`; a closed connection throws
`VelrStateError`. Use savepoints for nested scopes.

```ts
beginTx(): VelrTx
```

### Velr.close

Close this connection and all open child handles.

Calling `close()` more than once is safe.

```ts
close(): void
```

### Velr.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## Stream

Synchronous stream of result tables returned by `Velr.exec()`.

Most Cypher statements return one table, but multi-statement execution may
produce more. Close the stream to release native resources.

### Stream.nextTable

Return the next result table, or `null` when the stream is exhausted.
Throws `VelrError` if query execution fails while advancing the stream.

```ts
nextTable(): Table | null
```

### Stream.[Symbol.iterator]

Iterate over result tables until the stream is exhausted.

```ts
*[Symbol.iterator](): Iterator<Table>
```

### Stream.close

Close this stream and any tables still owned by it.

```ts
close(): void
```

### Stream.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## Table

One result table returned by a query.

A table exposes column metadata, row cursors, eager collection helpers, and
Arrow IPC export. Close it when finished. Tables from `exec()` require the
producing stream to remain open; tables from `execOne()` require their
connection or transaction to remain open. Closing any parent invalidates
its child handles. Copied `Cell` and JavaScript values remain usable.

### Table.columnCount

Return the number of columns in this table.

```ts
columnCount(): number
```

### Table.columnNames

Return column names in result order.

```ts
columnNames(): readonly string[]
```

### Table.rows

Open a row cursor; keep this table and its parents open until the cursor
closes. Close the cursor on success, error, or early exit. Fetching can
throw `VelrError`; returned cells own their bytes and remain usable.

```ts
rows(): Rows
```

### Table.forEachRow

Visit every row in order with `fn(row, zeroBasedIndex)`.

The callback runs synchronously; returned promises are not awaited. Use
the worker API when each callback must finish asynchronous work before
visiting the next row. A thrown callback error stops iteration and
propagates; fetch errors can also throw `VelrError`. The temporary cursor
always closes, while the caller still owns the table. Copied cells remain
usable after iteration and handle closure.

```ts
forEachRow(fn: (row: readonly Cell[], index: number) => void): void
```

### Table.collect

Collect all rows into an array.

Without a mapper, each row is returned as a fresh `Cell[]`. `map` receives
the row cells and a zero-based index and returns one output per row. It
runs synchronously: returned promises become array entries and are not
awaited. The worker API awaits asynchronous mappers. A thrown mapper
error stops collection and propagates; fetching can throw `VelrError`.
Collects all output in memory and always closes the temporary cursor;
the caller still owns the table. Returned cells and copied values survive
closing the table or its parents.

```ts
collect<T = Cell[]>(map?: RowMapper<T>): T[]
```

### Table.toObjects

Convert all rows into objects keyed by column name.

Cell values follow `Cell.asJs(options)`. Use unique result aliases;
Cypher rejects duplicate result column names. The generic `T` does
not validate result shapes. All rows are collected in memory. Fetch and
conversion failures propagate; the temporary cursor always closes.

```ts
toObjects<T extends Record<string, unknown> = Record<string, unknown>>(
    options: CellAsJsOptions = {}
  ): T[]
```

### Table.toArrowIpc

Export this table as an owned Arrow IPC file/Feather v2 `Buffer`.

The buffer remains usable after this table and its parents close. No
Apache Arrow JavaScript dependency is needed for this method. Export can
materialize the entire result and allocate memory proportional to its size.

Column types are inferred for this result: numeric columns may be integers
or floating-point, and incompatible mixed kinds become strings. Cypher
lists, maps, nodes, relationships, and paths become JSON strings in UTF-8
columns, rather than nested Arrow arrays. Nulls remain null; empty/all-null
columns use UTF-8 strings. Inspect the exported schema before assuming a dtype.

Throws `VelrError` for a closed table, unavailable runtime support, or a
row-read, conversion, or export failure.

```ts
toArrowIpc(): Buffer
```

### Table.toArrowTable

Convert this table to an Apache Arrow table.

Requires the optional `apache-arrow` peer dependency. Uses the schema and
structured-value conversion described by `toArrowIpc()`. Keep this table
and its parents open until the promise resolves; the returned Arrow table
then owns its data independently. The promise rejects on a missing peer
dependency, incompatible Arrow API, or result export/conversion failure.

```ts
async toArrowTable(): Promise<unknown>
```

### Table.close

Close this table and any open row cursors.

```ts
close(): void
```

### Table.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## Rows

Streaming row cursor for a `Table`.

Use `Table.collect()` or `Table.toObjects()` when eager collection is more
convenient.

### Rows.next

Return the next row, or `null` when the cursor is exhausted.
Throws `VelrError` if query execution fails while fetching the row.

```ts
next(): Cell[] | null
```

### Rows.[Symbol.iterator]

Iterate over rows until the cursor is exhausted.

```ts
*[Symbol.iterator](): Iterator<Cell[]>
```

### Rows.close

Close this row cursor. Calling `close()` more than once is safe.

```ts
close(): void
```

### Rows.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## ExplainTrace

Explain or explain-analyze trace returned by Velr.

Keep this trace and its owning connection or transaction open while reading
it, on the same thread. Closing either parent or trace invalidates the live
trace; subsequent reads throw `VelrStateError`. Close the trace explicitly.
Indexed methods read individual entries; `snapshot()` copies the whole trace
into plain JavaScript objects. Copied snapshots, metadata, and compact strings
remain valid after handle closure. Runtime/read failures throw `VelrError`.
Explain output is diagnostic text/data and may change between releases.

### ExplainTrace.planCount

Return the number of plans in this trace.

```ts
planCount(): number
```

### ExplainTrace.planMeta

Return metadata for a plan by zero-based plan index.

```ts
planMeta(planIdx: number): ExplainPlanMeta
```

### ExplainTrace.stepCount

Return the number of steps in a plan.

```ts
stepCount(planIdx: number): number
```

### ExplainTrace.stepMeta

Return metadata for a step by zero-based plan and step indexes.

```ts
stepMeta(planIdx: number, stepIdx: number): ExplainStepMeta
```

### ExplainTrace.statementCount

Return the number of SQL statements attached to a step.

```ts
statementCount(planIdx: number, stepIdx: number): number
```

### ExplainTrace.statementMeta

Return metadata for a SQL statement by zero-based indexes.

```ts
statementMeta(planIdx: number, stepIdx: number, stmtIdx: number): ExplainStatementMeta
```

### ExplainTrace.sqlitePlanDetail

Return one SQLite plan-detail row for a SQL statement.

```ts
sqlitePlanDetail(planIdx: number, stepIdx: number, stmtIdx: number, detailIdx: number): string
```

### ExplainTrace.snapshot

Copy the full trace into plain JavaScript objects.

```ts
snapshot(): ExplainPlan[]
```

### ExplainTrace.toCompactString

Render the trace using Velr's compact human-readable format.

```ts
toCompactString(): string
```

### ExplainTrace.close

Close this explain trace. Calling `close()` more than once is safe.

```ts
close(): void
```

### ExplainTrace.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## VelrTx

Explicit synchronous transaction.

Create transactions with `Velr.beginTx()` or `Velr.transaction()`. A
transaction must be committed, rolled back, or closed.

### VelrTx.closed

Whether this transaction has already ended.

```ts
get closed(): boolean
```

### VelrTx.exec

Execute Cypher inside this transaction and return a stream of result tables.
A timeout covers execution and result fetching. Close the stream when finished.

```ts
exec(cypher: string, options?: QueryOptions): StreamTx
```

### VelrTx.execOne

Execute Cypher inside this transaction and return exactly one result table.

Throws when the statement produces no tables or multiple tables.
A timeout covers execution and row reads, which can throw `VelrError`.
Close the table before its parent connection or transaction closes. Its
parent closes any remaining result handles automatically.

```ts
execOne(cypher: string, options?: QueryOptions): Table
```

### VelrTx.run

Execute Cypher inside this transaction and discard all result tables. Supports deadlines.

```ts
run(cypher: string, options?: QueryOptions): void
```

### VelrTx.execute

Alias for `run()`.

```ts
execute(cypher: string, options?: QueryOptions): void
```

### VelrTx.bindArrowIpc

Bind an Arrow IPC file/Feather v2 payload for use inside this transaction.

The binding follows transaction visibility and disappears when the
transaction ends.

```ts
bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): void
```

### VelrTx.query

Execute Cypher inside this transaction and convert one result table into objects.
A timeout covers execution and collection.

```ts
query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): T[]
```

### VelrTx.explain

Explain query text inside this transaction without executing it.

Parameter bindings and query options are not accepted. The returned trace
requires this transaction and its connection to stay open; close it before
finalizing the transaction. Copied snapshots and compact strings remain
usable afterward. Query/runtime failures throw `VelrError`, invalid host
arguments throw `VelrTypeError`, and a closed transaction throws `VelrStateError`.

```ts
explain(cypher: string): ExplainTrace
```

### VelrTx.explainAnalyze

Execute and profile query text inside this transaction, including writes.

Changes remain part of this transaction; commit or roll back normally.
Parameter bindings and query options are not accepted. Keep this transaction,
its connection, and the returned trace open while reading, then close the
trace before finalizing the transaction. Copied snapshots and strings survive
closure. Query/runtime failures throw `VelrError`, invalid host arguments
throw `VelrTypeError`, and a closed transaction throws `VelrStateError`.

```ts
explainAnalyze(cypher: string): ExplainTrace
```

### VelrTx.savepoint

Create an anonymous savepoint.

```ts
savepoint(): Savepoint
```

### VelrTx.withSavepoint

Run a function inside an anonymous savepoint.

The savepoint is released when `fn` returns successfully and rolled back
when `fn` throws, unless the callback already consumed it. Return values
are passed through. The callback must be synchronous; promises are not
awaited. Use the worker API for async callbacks.

```ts
withSavepoint<T>(fn: (savepoint: Savepoint) => T): T
```

### VelrTx.savepointNamed

Create a named savepoint.

Named savepoints are stack-like: only the newest named savepoint can be
released directly. `rollbackTo(name)` retains the named target and removes
newer named savepoints.

```ts
savepointNamed(name: string): Savepoint
```

### VelrTx.withSavepointNamed

Run a function inside a named savepoint.

The savepoint is released on success and rolled back on failure, unless the
callback already consumed it. The callback must be synchronous; promises
are not awaited. Use the worker API for async callbacks.

```ts
withSavepointNamed<T>(name: string, fn: (savepoint: Savepoint) => T): T
```

### VelrTx.rollbackTo

Roll back to a named savepoint and keep that savepoint active.

Newer named savepoints are invalidated.

```ts
rollbackTo(name: string): void
```

### VelrTx.releaseSavepoint

Release the newest active named savepoint with `name`.

```ts
releaseSavepoint(name: string): void
```

### VelrTx.commit

Commit the transaction and close all child handles.

```ts
commit(): void
```

### VelrTx.rollback

Roll back the transaction and close all child handles.

```ts
rollback(): void
```

### VelrTx.close

Close the transaction without committing.

This releases the native transaction handle. Prefer `rollback()` when you
want rollback errors to be surfaced.

```ts
close(): void
```

### VelrTx.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## StreamTx

Synchronous stream of result tables returned by `VelrTx.exec()`.

Close the stream to release transaction-scoped native resources.

### StreamTx.nextTable

Return the next transaction result table, or `null` when exhausted.

```ts
nextTable(): Table | null
```

### StreamTx.[Symbol.iterator]

Iterate over result tables until the stream is exhausted.

```ts
*[Symbol.iterator](): Iterator<Table>
```

### StreamTx.close

Close this stream and any tables still owned by it.

```ts
close(): void
```

### StreamTx.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## Savepoint

Transaction savepoint handle.

Savepoints are created by `VelrTx.savepoint()` or `VelrTx.savepointNamed()`.
Release to keep changes after the savepoint, or roll back to undo them.

### Savepoint.name

Savepoint name, or `null` for anonymous savepoints.

```ts
get name(): string | null
```

### Savepoint.closed

Whether this savepoint has already been released, rolled back, or closed.

```ts
get closed(): boolean
```

### Savepoint.release

Release this savepoint and keep changes made after it.

```ts
release(): void
```

### Savepoint.rollback

Roll back changes made after this savepoint and consume the handle.

```ts
rollback(): void
```

### Savepoint.close

Close this handle; calling it more than once is safe.

An active anonymous savepoint rolls back changes after it and releases
itself. Closing a named handle leaves its transaction-owned savepoint
active; use `releaseSavepoint(name)` or `rollbackTo(name)` on the
transaction, or `release()` / `rollback()` before closing the handle.

```ts
close(): void
```

### Savepoint.[Symbol.dispose]

Dispose hook for JavaScript explicit resource management.

```ts
[Symbol.dispose](): void
```

## VelrError

Base error thrown for failures reported by the Velr runtime.

For openCypher errors, `message` identifies the query error category and
compile-time or runtime phase, followed by diagnostic context. A numeric
operation status is exposed through `code` when available; it is separate
from the query error category.

Query execution and result iteration can both throw this error.
Query categories include `SyntaxError`, `TypeError`, `ArgumentError`,
`EntityNotFound`, `ConstraintVerificationFailed`, `SemanticError`,
`ParameterMissing`, and `ArithmeticError`.

### VelrError.code

Optional numeric operation status, separate from the Cypher error category.

```ts
readonly code?: number;
```

### VelrError.constructor

Create an error with diagnostic `message`, optional numeric `code`, and underlying `cause`.

```ts
constructor(message: string, options: { code?: number; cause?: unknown } = {})
```

### VelrError.stopReason

Returns `"cancelled"` for an aborted query and `"deadline_exceeded"` for
an expired query timeout. Returns `undefined` for other errors.
Query calls and result reads can both report these outcomes.

```ts
get stopReason(): "cancelled" | "deadline_exceeded" | undefined
```

## VelrStateError

Error used by driver guards for closed or consumed handles.

Worker handles invalidated by parent closure or another handle operation may
reject with an ordinary `Error` instead. A worker handle's local `closed`
property does not establish whether its parent and worker-side resource remain valid.

### VelrStateError.constructor

Create a Velr state error.

```ts
constructor(message: string)
```

### VelrStateError.code

Optional numeric operation status, separate from the Cypher error category.

```ts
readonly code?: number;
```

### VelrStateError.stopReason

Returns `"cancelled"` for an aborted query and `"deadline_exceeded"` for
an expired query timeout. Returns `undefined` for other errors.
Query calls and result reads can both report these outcomes.

```ts
get stopReason(): "cancelled" | "deadline_exceeded" | undefined
```

## VelrTypeError

Error thrown for invalid JavaScript arguments before calling the runtime.

### VelrTypeError.constructor

Create a Velr argument/type error.

```ts
constructor(message: string)
```

## QueryScalar

Primitive values accepted as query parameters.

```ts
export type QueryScalar = null | boolean | number | bigint | string;
```

## QueryValue

A JSON-like value accepted by Velr query parameters.

Parameters may be nested arrays or objects. JavaScript `bigint` values are
passed to Velr as signed 64-bit integers. Numbers must be finite; integer
numbers must be safe integers. Values outside these ranges throw
`VelrTypeError`. Parameters are bound separately from query text.

```ts
export type QueryValue =
  | QueryScalar
  | readonly QueryValue[]
  | { readonly [key: string]: QueryValue };
```

## QueryParams

Named query parameters passed as `$name`; keys omit the leading `$`.

```ts
export type QueryParams = Record<string, QueryValue>;
```

## CreateOptions

Options applied when creating a new database.

```ts
export interface CreateOptions {
  /**
   * Ordered list of case-sensitive relationship property names. Pass zero
   * or one nonempty name. An omitted or empty list leaves inline edge
   * properties disabled. The choice applies to every relationship type and
   * is fixed at creation.
   *
   * All values use the same Cypher reads and writes.
   */
  readonly inlineEdgeProperties?: readonly string[];
}
```

## QueryOptions

Options accepted by query execution helpers.

```ts
export interface QueryOptions {
  /**
   * Non-negative safe integer cap on rows per result table, including every
   * table in a multi-statement script. `0` preserves columns without rows.
   * `null` or `undefined` leaves the runtime default unchanged. Invalid values
   * throw `VelrTypeError`. This does not cap execution time or replace Cypher
   * `LIMIT` clauses.
   */
  readonly maxResultRows?: number | null;
  /** Named Cypher parameters available as `$name` in the query. */
  readonly params?: QueryParams | null;
  /**
   * Finite, non-negative query timeout in milliseconds. Omit it for no
   * deadline; `0` expires immediately. It covers execution and subsequent
   * table and row reads. Worker deadlines also include time waiting for
   * earlier worker operations. A deadline error has `VelrError.stopReason`
   * set to `"deadline_exceeded"`. Invalid or out-of-range durations throw
   * `VelrTypeError` (or reject a worker call).
   */
  readonly timeoutMs?: number;
}
```

## Int64Mode

Controls how signed 64-bit integer cells are converted by `Cell.asJs()`.

`"number-or-bigint"` returns a JavaScript `number` when the value is inside
the safe integer range and a `bigint` otherwise. `"bigint"` and `"string"`
always use the requested representation. `"number"` always converts to a
number and can lose precision outside the safe integer range.

```ts
export type Int64Mode = "number-or-bigint" | "number" | "bigint" | "string";
```

## CellAsJsOptions

Cell conversion options used by `Cell.asJs()` and object helpers.

```ts
export interface CellAsJsOptions {
  /** Integer conversion mode. Defaults to `"number-or-bigint"`. */
  readonly int64?: Int64Mode;
  /** Parse JSON cells with `JSON.parse`; JSON integers can lose precision. Defaults to `true`. */
  readonly parseJson?: boolean;
  /** Decode text and JSON cells as UTF-8 strings. Defaults to `true`. */
  readonly decodeText?: boolean;
}
```

## CellType

Runtime cell kind returned by Velr result tables.

```ts
export type CellType = "null" | "bool" | "int64" | "double" | "text" | "json";
```

## JsonValue

JSON value returned when JSON cells are parsed.

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

## CellValue

JavaScript value returned from `Cell.asJs()`.

```ts
export type CellValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

## MigrationReport

Result returned by `migrate()`.

```ts
export interface MigrationReport {
  /** Schema version before migration started. */
  readonly fromVersion: number;
  /** Schema version after migration finished. */
  readonly toVersion: number;
  /** Whether a migration was applied or the database was already current. */
  readonly status: "already_current" | "migrated";
  /** Runtime migration step identifiers applied by Velr. */
  readonly steps: readonly string[];
}
```

## VectorEmbeddingPurpose

Why Velr is requesting embeddings from a registered vector embedder.

This is only used by embedder-backed indexes. Stored-vector indexes, such as
`CREATE VECTOR INDEX ... ON (n.embedding)`, use the vector/list property
directly.

```ts
export type VectorEmbeddingPurpose = "index_entity" | "query";
```

## VectorEntityKind

Entity type being embedded for a vector index.

```ts
export type VectorEntityKind = "node" | "relationship";
```

## VectorPropertyValueType

Velr property value type seen by a vector embedding callback.

```ts
export type VectorPropertyValueType =
  | "null"
  | "bool"
  | "int64"
  | "double"
  | "string"
  | "date"
  | "local_time"
  | "zoned_time"
  | "local_datetime"
  | "zoned_datetime"
  | "duration"
  | "point"
  | "geometry"
  | "geography"
  | "list"
  | "vector"
  | "bytes";
```

## VectorEmbeddingField

Single property field passed to a vector embedding callback.

Fields are produced for `CREATE VECTOR INDEX ... ON EACH [...]` sources.
Stored-vector indexes created with `ON (n.embedding)` do not call an
embedder.

```ts
export interface VectorEmbeddingField {
  /** Property name, or `null` for unnamed payloads. */
  readonly name: string | null;
  /** Decoded JavaScript value when Velr can represent it directly. */
  readonly value: unknown;
  /** Velr type tag for `value`. */
  readonly valueType: VectorPropertyValueType;
  /** JSON-compatible representation of the field value when available. */
  readonly valueJson: unknown;
  /** Stable display string suitable for text embedders. */
  readonly display: string;
}
```

## VectorEmbeddingInput

Batch input passed to a registered vector embedding callback.

Stored-vector indexes created with `ON (n.embedding)` query with numeric
vectors/lists instead of producing embedder inputs.

```ts
export interface VectorEmbeddingInput {
  /** Vector index name that requested the embedding. */
  readonly indexName: string;
  /** Number of dimensions expected in every returned embedding. */
  readonly dimensions: number;
  /** Whether this is an index-time or query-time embedding request. */
  readonly purpose: VectorEmbeddingPurpose;
  /** Entity kind for index-time embedding requests, or `null` for query inputs. */
  readonly entityKind: VectorEntityKind | null;
  /** Velr entity id for index-time embedding requests, or `null` for query inputs. */
  readonly entityId: bigint | null;
  /** Property fields Velr selected for embedding. */
  readonly fields: readonly VectorEmbeddingField[];
}
```

## VectorEmbedding

One embedding vector returned by a vector embedder.

Every value must be finite; the vector length must match
`VectorEmbeddingInput.dimensions`.

```ts
export type VectorEmbedding = readonly number[] | Float32Array;
```

## VectorEmbedder

Synchronous vector embedding callback used by the direct driver for
embedder-backed vector indexes.

Return one embedding for each input in the same order. The worker driver uses
`VelrWorkerVectorEmbedder`, which may return a promise.
Stored-vector indexes do not call this callback. Registration retains the
callback until replacement or connection close. Do not call the same
connection from inside its callback. Callback failures fail the query or
index operation that requested the embeddings.

```ts
export type VectorEmbedder = (
  inputs: readonly VectorEmbeddingInput[]
) => readonly VectorEmbedding[];
```

## ExplainPlanMeta

Top-level metadata for one explain plan.

```ts
export interface ExplainPlanMeta {
  /** Stable plan identifier assigned by Velr. */
  readonly planId: string;
  /** Cypher statement explained by this plan. */
  readonly cypher: string;
  /** Number of execution steps in the plan. */
  readonly stepCount: number;
}
```

## ExplainStepMeta

Metadata for one step in an explain plan.

```ts
export interface ExplainStepMeta {
  /** Step number in display order. */
  readonly stepNo: number;
  /** Planner group identifier for related operations. */
  readonly groupId: string;
  /** Operation index inside the planner trace. */
  readonly opIndex: string;
  /** Planner or execution phase. */
  readonly phase: string;
  /** Human-readable step title. */
  readonly title: string;
  /** Source subsystem that produced the step. */
  readonly source: string;
  /** Optional explanatory note from Velr. */
  readonly note: string | null;
  /** Number of SQL statements attached to the step. */
  readonly statementCount: number;
}
```

## ExplainStatementMeta

Metadata for one SQL statement inside an explain step.

```ts
export interface ExplainStatementMeta {
  /** Stable statement identifier assigned by Velr. */
  readonly stmtId: string;
  /** Statement category. */
  readonly kind: string;
  /** SQL emitted for this planner step. */
  readonly sql: string;
  /** Optional explanatory note from Velr. */
  readonly note: string | null;
  /** Number of SQLite plan-detail rows for this SQL statement. */
  readonly sqlitePlanCount: number;
}
```

## ExplainStatement

SQL statement plus SQLite plan details returned by `ExplainTrace.snapshot()`.

```ts
export interface ExplainStatement extends ExplainStatementMeta {
  /** Raw SQLite `EXPLAIN QUERY PLAN` detail rows. */
  readonly sqlitePlan: readonly string[];
}
```

## ExplainStep

Explain step plus all SQL statements returned by `ExplainTrace.snapshot()`.

```ts
export interface ExplainStep extends ExplainStepMeta {
  /** SQL statements emitted by this step. */
  readonly statements: readonly ExplainStatement[];
}
```

## ExplainPlan

Full explain plan returned by `ExplainTrace.snapshot()`.

```ts
export interface ExplainPlan extends ExplainPlanMeta {
  /** Execution steps in display order. */
  readonly steps: readonly ExplainStep[];
}
```

## VelrWorkerOptions

Options used when spawning a Velr worker thread.

```ts
export interface VelrWorkerOptions {
  /** Additional worker data passed to Node's `Worker` constructor. */
  readonly workerData?: unknown;
}
```

## WorkerQueryOptions

Query options for a worker connection or transaction.

```ts
export interface WorkerQueryOptions extends QueryOptions {
  /**
   * Signal for cancelling execution and subsequent table and row reads.
   * An aborted query rejects with a `VelrError` whose `stopReason` is
   * `"cancelled"`. You can pass a signal together with `timeoutMs`.
   */
  readonly signal?: AbortSignal;
}
```

## VelrWorkerVectorEmbedder

Vector embedding callback used by `VelrWorker` for embedder-backed indexes.

Unlike the direct driver's `VectorEmbedder`, the worker embedder may return a
promise because the callback runs on the main thread while database execution
happens in the worker.
Stored-vector indexes do not call this callback.

```ts
export type VelrWorkerVectorEmbedder = (
  inputs: readonly VectorEmbeddingInput[]
) => readonly VectorEmbedding[] | Promise<readonly VectorEmbedding[]>;
```

## VelrWorker

Asynchronous Velr database connection backed by a Node.js worker thread.

Import from the worker subpath:

```ts
import { VelrWorker } from "@velr-ai/velr/worker";
```

The worker API mirrors the direct `Velr` API, but methods return promises and
native execution happens away from the caller's event loop. Individual
requests execute in order; an asynchronous transaction callback does not
reserve the worker across its awaits. Use one transaction at a time and
avoid unrelated calls on this connection until it finishes. Use separate
worker connections for independent concurrent transaction scopes. Worker
communication failures can reject calls with ordinary Node.js errors.

### VelrWorker.worker

Underlying Node.js worker thread.

```ts
readonly worker: Worker;
```

### VelrWorker.open

Open a database for reading and writing in a worker thread.

Pass `null` or omit `path` for an in-memory database. File paths open or
create a persistent database. Fulltext and vector indexes require a file.
Opening never migrates automatically. Close the returned worker when all
queries and results are finished; open failures reject with `VelrError`.
Migrate supported older databases before graph queries or transactions.

```ts
static async open(path: string | null = null, options: VelrWorkerOptions = {}): Promise<VelrWorker>
```

### VelrWorker.create

Create a new database in a worker thread.

Pass a new file path, or `null` or `":memory:"` for an in-memory database.
Use `options.inlineEdgeProperties` to choose the property at creation.
Existing paths, invalid options, and unsupported runtimes reject the
promise. Close the returned connection or use it with `await using`.

```ts
static async create(
    path: string | null = null,
    options: VelrWorkerOptions & CreateOptions = {}
  ): Promise<VelrWorker>
```

### VelrWorker.openReadonly

Open an existing supported database for reads without creating,
initializing, migrating, or repairing it. Missing files or unsupported
schemas reject with `VelrError`. Close the returned worker when finished.
Migrate supported older databases on a writable connection, then reopen
read-only workers before querying.

```ts
static async openReadonly(path: string, options: VelrWorkerOptions = {}): Promise<VelrWorker>
```

### VelrWorker.closed

Whether this worker connection has already been closed.

```ts
get closed(): boolean
```

### VelrWorker.inlineEdgeProperties

Return the inline edge property names in configured order.

The selection remains available after reopening the database. Returns an
empty array when no property is selected. A closed connection or runtime
that cannot report the selection rejects the promise.

```ts
async inlineEdgeProperties(): Promise<string[]>
```

### VelrWorker.schemaVersion

Return the schema version stored in the opened database.

```ts
async schemaVersion(): Promise<number>
```

### VelrWorker.currentSchemaVersion

Return the schema version expected by the loaded Velr runtime.

```ts
async currentSchemaVersion(): Promise<number>
```

### VelrWorker.needsMigration

Return `true` when the database schema is older than the runtime schema.

```ts
async needsMigration(): Promise<boolean>
```

### VelrWorker.migrate

Explicitly migrate a writable database outside an active transaction.
Resolves to the before/after versions, status, and applied steps; failures
reject with `VelrError`. Opening a worker never migrates automatically.
Migrate supported older databases before graph queries or transactions;
reopen read-only workers after another connection migrates the file.

```ts
async migrate(): Promise<MigrationReport>
```

### VelrWorker.vacuum

Compact a writable current-schema file outside an active transaction.
Resolves without a value; unmet prerequisites reject with `VelrError`.

```ts
async vacuum(): Promise<void>
```

### VelrWorker.registerVectorEmbedder

Register or replace a vector embedder for worker-side vector indexes.

Embedder-backed vector indexes reference this name from
`CREATE VECTOR INDEX ... OPTIONS { indexConfig: { embedder: 'name' } }`.
Register it separately on each worker connection that needs embeddings,
including after reopening; registration is not persisted with the file.
Registration itself, index creation/recovery, indexed writes or their
commit, and text queries through vector procedures can request embeddings.
Register before those operations. If an embedder-backed index has pending
transaction updates, commit or roll back before searching that index.

The callback runs on the calling thread and may be asynchronous. Database
work runs in the worker; CPU-intensive embedder code still blocks the
calling thread unless the application offloads that computation. Return one
finite embedding for each input in the same order and with the requested
dimensions. The callback is retained until replacement or close. Do not
call the same worker from its callback; doing so cannot complete while
that worker waits for the callback. Callback failures fail the requesting
query or index operation. Names must be nonempty and contain no NUL;
invalid names or callbacks reject with `VelrTypeError`. Runtime support,
registration, and index failures reject with `VelrError`; closed or
invalidated workers may reject with an ordinary `Error` or `VelrStateError`.

Stored-vector indexes, such as `CREATE VECTOR INDEX ... ON (n.embedding)`,
index the vector/list property directly and do not use a registered
embedder.

Common vector `indexConfig` keys are `dimensions` / `` `vector.dimensions` ``,
`metric` / `` `vector.similarity_function` ``, `embedder`,
`` `vector.hnsw.m` `` (`1..512`), `` `vector.hnsw.ef_construction` ``
(`1..3200`), and `` `vector.hnsw.ef_search` `` (`1..3200`).

```ts
async registerVectorEmbedder(name: string, embedder: VelrWorkerVectorEmbedder): Promise<void>
```

### VelrWorker.exec

Execute Cypher and return an async stream of result tables.
Cancellation and deadlines apply through result fetching.
Close the returned stream when finished.

```ts
async exec(cypher: string, options?: WorkerQueryOptions): Promise<VelrWorkerStream>
```

### VelrWorker.execOne

Execute Cypher and return exactly one result table.

The promise rejects when the statement produces no tables or multiple
tables. Cancellation and deadlines apply through result fetching.
Close the returned table when finished.

```ts
async execOne(cypher: string, options?: WorkerQueryOptions): Promise<VelrWorkerTable>
```

### VelrWorker.run

Execute Cypher and discard all result tables. Supports cancellation and deadlines.

```ts
async run(cypher: string, options?: WorkerQueryOptions): Promise<void>
```

### VelrWorker.execute

Alias for `run()`.

```ts
async execute(cypher: string, options?: WorkerQueryOptions): Promise<void>
```

### VelrWorker.bindArrowIpc

Bind an Arrow IPC file/Feather v2 payload as a logical table.

IPC streams are not accepted by the current ABI.

```ts
async bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): Promise<void>
```

### VelrWorker.transaction

Run a function inside a worker transaction.

The transaction commits when `fn` resolves and rolls back when `fn` rejects,
unless the callback has already committed or rolled back. Resolves to the
callback result and propagates its rejection or a transaction failure.
Consume and close result handles before the callback finishes; copied cells,
objects, and explain snapshots can outlive it. Only one transaction may be
active on this connection. A writable transaction reserves the writer slot;
use a separate read-only connection for a snapshot while another writes.

The worker orders individual requests, not the entire callback scope. Do
not start another transaction or send unrelated connection calls while
this callback is pending. Await its result before reusing the connection,
or use separate worker connections for independent work. Callback errors
propagate unless rollback cleanup itself fails.

```ts
async transaction<T>(fn: (tx: VelrWorkerTx) => T | Promise<T>): Promise<T>
```

### VelrWorker.query

Execute Cypher and convert the single result table into objects.

Column names become object keys and cell conversion follows `Cell.asJs()`.
Cancellation and deadlines apply to execution and collection.

```ts
async query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: WorkerQueryOptions & CellAsJsOptions
  ): Promise<T[]>
```

### VelrWorker.explain

Explain query text without executing it; accepts no parameter bindings or options.

Keep this connection and the returned trace open until reading finishes,
then close the trace. Closing the parent invalidates it. Copied `snapshot()`
and `toCompactString()` results remain usable after handle closure.
Query/runtime failures reject with `VelrError`, invalid host arguments with
`VelrTypeError`; closed or invalidated worker handles may reject with an
ordinary `Error` or `VelrStateError`.

```ts
async explain(cypher: string): Promise<VelrWorkerExplainTrace>
```

### VelrWorker.explainAnalyze

Execute and profile query text, including its writes, and return a trace.

Accepts no parameter bindings or query options. To discard analysis writes,
use `VelrWorkerTx.explainAnalyze()` and roll back its transaction. Keep this
connection and the returned trace open while reading, then close the trace.
Copied snapshots and compact strings survive handle closure. Query/runtime
failures reject with `VelrError`, invalid host arguments with `VelrTypeError`;
closed or invalidated worker handles may reject with an ordinary `Error`
or `VelrStateError`.

```ts
async explainAnalyze(cypher: string): Promise<VelrWorkerExplainTrace>
```

### VelrWorker.beginTx

Start this connection's single explicit transaction in the worker.

A writable transaction reserves the writer slot. For a snapshot while
another connection writes, begin a transaction on a separate read-only
connection. Use transaction methods until finalization and close its results
first. Commit persists writes; rollback or close discards uncommitted work.
Keep the parent connection open. Use savepoints for nested scopes.
An already-active transaction or begin failure rejects with `VelrError`;
closed worker requests may reject with an ordinary `Error` or `VelrStateError`.
Do not interleave unrelated calls or another transaction on this connection.

```ts
async beginTx(): Promise<VelrWorkerTx>
```

### VelrWorker.close

Close the database connection and terminate the worker thread.

Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorker.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerStream

Async stream of result tables returned by `VelrWorker.exec()`.

Close the stream when finished to release worker-side native resources.

### VelrWorkerStream.nextTable

Return the next result table, or `null` when the stream is exhausted.

```ts
async nextTable(): Promise<VelrWorkerTable | null>
```

### VelrWorkerStream.[Symbol.asyncIterator]

Iterate over result tables until the stream is exhausted.

```ts
async *[Symbol.asyncIterator](): AsyncIterator<VelrWorkerTable>
```

### VelrWorkerStream.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerStream.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerStream.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerStreamTx

Async stream of result tables returned by `VelrWorkerTx.exec()`.

Close the stream when finished to release transaction-scoped resources.

### VelrWorkerStreamTx.nextTable

Return the next transaction result table, or `null` when exhausted.

```ts
async nextTable(): Promise<VelrWorkerTable | null>
```

### VelrWorkerStreamTx.[Symbol.asyncIterator]

Iterate over result tables until the stream is exhausted.

```ts
async *[Symbol.asyncIterator](): AsyncIterator<VelrWorkerTable>
```

### VelrWorkerStreamTx.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerStreamTx.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerStreamTx.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerTable

Result table handle returned by worker query APIs. Close it when finished;
keep its parent connection or transaction open, plus the producing stream
for tables returned by `exec()`. Closing a parent invalidates its children.

The methods mirror `Table`, but every operation crosses the worker boundary
and therefore returns a promise.

### VelrWorkerTable.columnCount

Return the number of columns in this table.

```ts
async columnCount(): Promise<number>
```

### VelrWorkerTable.columnNames

Return column names in result order.

```ts
async columnNames(): Promise<readonly string[]>
```

### VelrWorkerTable.rows

Open an async streaming row cursor for this table.

```ts
async rows(): Promise<VelrWorkerRows>
```

### VelrWorkerTable.forEachRow

Visit rows in order with `fn(row, zeroBasedIndex)` on the caller's thread.

Each returned promise is awaited before fetching the next row. A callback
throw or rejection stops iteration and rejects this call; fetch failures
also reject. The temporary cursor closes on success or failure, while the
caller still owns the table. A cleanup failure can replace an earlier error.
Returned cells own their data and survive closing result handles.

```ts
async forEachRow(fn: (row: readonly Cell[], index: number) => void | Promise<void>): Promise<void>
```

### VelrWorkerTable.collect

Collect all rows into an array.

Fetches the whole result before mapping; use `forEachRow()` for incremental
processing. Without a mapper, each row is returned as a fresh `Cell[]`.
A mapper receives cells and a zero-based index on the caller's thread;
each returned promise is awaited in row order. Mapping exceptions or
rejections stop mapping and reject this call; query/fetch failures also
reject. All rows/output are materialized in memory. The caller still owns
the table; copied cells and values survive closing it or its parents.

```ts
async collect<T = Cell[]>(map?: (row: readonly Cell[], index: number) => T | Promise<T>): Promise<T[]>
```

### VelrWorkerTable.toObjects

Convert all rows into objects keyed by column name.

Cell values are converted using `Cell.asJs(options)` in the worker.
Use unique result aliases; Cypher rejects duplicate result column names.
The generic `T` does not validate runtime result shapes. All rows are
collected in memory; query and fetch failures reject the promise.

```ts
async toObjects<T extends Record<string, unknown> = Record<string, unknown>>(
    options: CellAsJsOptions = {}
  ): Promise<T[]>
```

### VelrWorkerTable.toArrowIpc

Export an owned Arrow IPC file/Feather v2 `Buffer`; no Arrow peer is needed.

The buffer outlives this table and its parents. Export can materialize all
rows and use memory proportional to the result. Types are inferred per
result: numeric columns may be integer/floating-point; incompatible mixed
kinds become strings. Lists, maps, nodes, relationships, and paths become
JSON strings in UTF-8 columns, rather than nested Arrow arrays. Nulls remain null, and
empty/all-null columns use UTF-8 strings. Inspect the exported schema.
Runtime support, row-read, conversion, or export failures reject with
`VelrError`. Closed or invalidated worker handles may reject with an
ordinary `Error` or `VelrStateError`.

```ts
async toArrowIpc(): Promise<Buffer>
```

### VelrWorkerTable.toArrowTable

Convert this table to an Apache Arrow table.

Requires the optional `apache-arrow` peer dependency in the caller process.
Uses the inferred schema and JSON-string conversion of `toArrowIpc()`.
Keep the table and its parents open until the promise resolves; the
returned Arrow table then owns its data independently. Missing dependencies
and result export/conversion failures reject the promise.

```ts
async toArrowTable(): Promise<unknown>
```

### VelrWorkerTable.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerTable.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerTable.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerRows

Async row cursor for a `VelrWorkerTable`.

### VelrWorkerRows.next

Return the next row, or `null` when the cursor is exhausted.

```ts
async next(): Promise<Cell[] | null>
```

### VelrWorkerRows.[Symbol.asyncIterator]

Iterate over rows until the cursor is exhausted.

```ts
async *[Symbol.asyncIterator](): AsyncIterator<Cell[]>
```

### VelrWorkerRows.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerRows.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerRows.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerExplainTrace

Worker-backed explain or explain-analyze trace.

Keep this trace and its parent connection or transaction open while reading
it, and close the trace when finished. Parent closure invalidates the live
trace even when its local `closed` property remains false. Invalidated-worker
requests may reject with an ordinary `Error`; local guards use `VelrStateError`,
and runtime/read failures use `VelrError`.

Indexed methods read individual entries; `snapshot()` copies the full trace
into plain JavaScript objects. Copied snapshots, metadata, and compact strings
survive handle closure. Explain output is diagnostic and may change between
releases.

### VelrWorkerExplainTrace.planCount

Return the number of plans in this trace.

```ts
async planCount(): Promise<number>
```

### VelrWorkerExplainTrace.planMeta

Return metadata for a plan by zero-based plan index.

```ts
async planMeta(planIdx: number): Promise<ExplainPlanMeta>
```

### VelrWorkerExplainTrace.stepCount

Return the number of steps in a plan.

```ts
async stepCount(planIdx: number): Promise<number>
```

### VelrWorkerExplainTrace.stepMeta

Return metadata for a step by zero-based plan and step indexes.

```ts
async stepMeta(planIdx: number, stepIdx: number): Promise<ExplainStepMeta>
```

### VelrWorkerExplainTrace.statementCount

Return the number of SQL statements attached to a step.

```ts
async statementCount(planIdx: number, stepIdx: number): Promise<number>
```

### VelrWorkerExplainTrace.statementMeta

Return metadata for a SQL statement by zero-based indexes.

```ts
async statementMeta(
    planIdx: number,
    stepIdx: number,
    stmtIdx: number
  ): Promise<ExplainStatementMeta>
```

### VelrWorkerExplainTrace.sqlitePlanDetail

Return one SQLite plan-detail row for a SQL statement.

```ts
async sqlitePlanDetail(
    planIdx: number,
    stepIdx: number,
    stmtIdx: number,
    detailIdx: number
  ): Promise<string>
```

### VelrWorkerExplainTrace.snapshot

Copy the full trace into plain JavaScript objects.

```ts
async snapshot(): Promise<ExplainPlan[]>
```

### VelrWorkerExplainTrace.toCompactString

Render the trace using Velr's compact human-readable format.

```ts
async toCompactString(): Promise<string>
```

### VelrWorkerExplainTrace.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerExplainTrace.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerExplainTrace.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerTx

Explicit transaction running inside a Velr worker.

Create transactions with `VelrWorker.beginTx()` or `VelrWorker.transaction()`.
Only one may be active on the connection. Finish its result handles before
commit, rollback, or close; finalization invalidates its worker-side children
without updating every child's local `closed` property. Avoid unrelated
connection calls and overlapping transaction/savepoint scopes during awaits.
Use separate worker connections for independent concurrent work.

### VelrWorkerTx.exec

Execute Cypher inside this transaction and return an async stream of result tables.
Cancellation and deadlines apply through result fetching. Close the stream when finished.

```ts
async exec(cypher: string, options?: WorkerQueryOptions): Promise<VelrWorkerStreamTx>
```

### VelrWorkerTx.execOne

Execute Cypher inside this transaction and return exactly one result table.

The promise rejects when the statement produces no tables or multiple
tables. Cancellation and deadlines apply through result fetching.
Close the returned table when finished.

```ts
async execOne(cypher: string, options?: WorkerQueryOptions): Promise<VelrWorkerTable>
```

### VelrWorkerTx.run

Execute Cypher inside this transaction, supporting cancellation and deadlines.

```ts
async run(cypher: string, options?: WorkerQueryOptions): Promise<void>
```

### VelrWorkerTx.execute

Alias for `run()`.

```ts
async execute(cypher: string, options?: WorkerQueryOptions): Promise<void>
```

### VelrWorkerTx.bindArrowIpc

Bind an Arrow IPC file/Feather v2 payload for use inside this transaction.

The binding follows transaction visibility and disappears when the
transaction ends.

```ts
async bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): Promise<void>
```

### VelrWorkerTx.query

Execute Cypher inside this transaction and convert one result table into objects.
Cancellation and deadlines apply to execution and collection.

```ts
async query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: WorkerQueryOptions & CellAsJsOptions
  ): Promise<T[]>
```

### VelrWorkerTx.explain

Explain query text in this transaction without executing it.

Accepts no parameter bindings or query options. Keep the trace, transaction,
and connection open while reading; close the trace before finalization.
Copied snapshots and compact strings remain usable afterward. Query/runtime
failures reject with `VelrError`, invalid host arguments with `VelrTypeError`;
closed or invalidated handles may reject with an ordinary `Error` or
`VelrStateError`.

```ts
async explain(cypher: string): Promise<VelrWorkerExplainTrace>
```

### VelrWorkerTx.explainAnalyze

Execute and profile query text in this transaction, including its writes.

Changes remain part of this transaction; commit or roll back normally.
Accepts no parameter bindings or query options. Keep the trace, transaction,
and connection open while reading; close the trace before finalization.
Copied snapshots and compact strings survive closure. Query/runtime failures
reject with `VelrError`, invalid host arguments with `VelrTypeError`; closed
or invalidated handles may reject with an ordinary `Error` or `VelrStateError`.

```ts
async explainAnalyze(cypher: string): Promise<VelrWorkerExplainTrace>
```

### VelrWorkerTx.savepoint

Create an anonymous savepoint.

```ts
async savepoint(): Promise<VelrWorkerSavepoint>
```

### VelrWorkerTx.withSavepoint

Run a function inside an anonymous savepoint.

The savepoint is released when `fn` resolves and rolled back when `fn`
rejects, unless the callback already consumed it.

```ts
async withSavepoint<T>(
    fn: (savepoint: VelrWorkerSavepoint) => T | Promise<T>
  ): Promise<T>
```

### VelrWorkerTx.savepointNamed

Create a named savepoint.

Named savepoints are stack-like: only the newest named savepoint can be
released directly. `rollbackTo(name)` retains the named target and removes
newer named savepoints.

```ts
async savepointNamed(name: string): Promise<VelrWorkerSavepoint>
```

### VelrWorkerTx.withSavepointNamed

Run a function inside a named savepoint.

The savepoint is released on success and rolled back on failure, unless the
callback already consumed it.

```ts
async withSavepointNamed<T>(
    name: string,
    fn: (savepoint: VelrWorkerSavepoint) => T | Promise<T>
  ): Promise<T>
```

### VelrWorkerTx.rollbackTo

Roll back to a named savepoint and keep that savepoint active.

Newer named savepoints are invalidated.

```ts
async rollbackTo(name: string): Promise<void>
```

### VelrWorkerTx.releaseSavepoint

Release the newest active named savepoint with `name`.

```ts
async releaseSavepoint(name: string): Promise<void>
```

### VelrWorkerTx.commit

Commit writes and close the transaction and its worker-side children.

Marks this local handle closed before the request finishes, including if
commit rejects. Repeated calls on this marked handle do nothing. Child
local `closed` properties may remain false after invalidation.

```ts
async commit(): Promise<void>
```

### VelrWorkerTx.rollback

Discard uncommitted writes and close the transaction and its worker-side children.

Marks this local handle closed before the request finishes, including if
rollback rejects. Repeated calls on this marked handle do nothing. Child
local `closed` properties may remain false after invalidation.

```ts
async rollback(): Promise<void>
```

### VelrWorkerTx.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerTx.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerTx.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```

## VelrWorkerSavepoint

Worker-backed transaction savepoint handle.

Release to keep changes after the savepoint, or roll back to undo them.

### VelrWorkerSavepoint.name

Savepoint name, or `null` for anonymous savepoints.

```ts
readonly name: string | null;
```

### VelrWorkerSavepoint.release

Release this savepoint, keeping its changes pending in the transaction.

Marks this local handle closed before the worker request finishes, including
if release rejects. Repeated calls on this marked handle do nothing. Keep
the parent transaction open; releasing an invalidated savepoint can reject
with an ordinary `Error` or `VelrError`.

```ts
async release(): Promise<void>
```

### VelrWorkerSavepoint.rollback

Roll back changes made after this savepoint and release it.

Marks this local handle closed before the worker request finishes, including
if rollback rejects. Repeated calls on this marked handle do nothing. Keep
the parent transaction open; an invalidated savepoint can reject with an
ordinary `Error` or `VelrError`.

```ts
async rollback(): Promise<void>
```

### VelrWorkerSavepoint.closed

Whether this local handle has been marked closed by its own `close()` or
finalization call, such as transaction commit or savepoint release. The flag
is set before that call's worker request finishes, including when it rejects.
Parent closure or consumption through another handle does not update this
flag, so `false` does not establish worker-side validity. Requests against
invalidated handles may reject with an ordinary `Error`; local closed-handle
guards use `VelrStateError`.

```ts
get closed(): boolean
```

### VelrWorkerSavepoint.close

Close this handle in the worker. Calling `close()` more than once is safe.

```ts
async close(): Promise<void>
```

### VelrWorkerSavepoint.[Symbol.asyncDispose]

Async dispose hook for JavaScript explicit resource management.

```ts
[Symbol.asyncDispose](): Promise<void>
```
