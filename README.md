# Velr

Velr is an embedded property-graph database from Velr.ai, written in Rust,
built on top of SQLite (persisting to a standard SQLite database file) and
queried using the openCypher language.

It runs in-process and is designed for local, embedded, and edge use cases.

This package provides the **JavaScript and TypeScript bindings** for Velr. It
wraps a bundled native runtime with a C ABI, implemented in Rust, and exposes a
small, idiomatic Node.js API for executing Cypher queries, streaming result
tables, working with transactions, using worker threads, and exporting or
binding Arrow IPC data.

For the main Velr public entry point, see
[velr-ai/velr](https://github.com/velr-ai/velr).  
For the Velr website, see [velr.ai](https://velr.ai/).

## Community

- **Community and questions:** [GitHub Discussions](https://github.com/velr-ai/velr/discussions)
- **Bug reports and feature requests:** [GitHub Issues](https://github.com/velr-ai/velr/issues)
- **JavaScript examples:** [velr-javascript-examples](https://github.com/velr-ai/velr-javascript-examples)
- **TypeScript examples:** [velr-typescript-examples](https://github.com/velr-ai/velr-typescript-examples)

We'd love to have you join the Velr community.

---

## Release status

Velr is currently in public **alpha**.

- The JavaScript and TypeScript API is still evolving.
- Velr supports openCypher and passes all positive openCypher TCK tests. Exact
  error semantics are not guaranteed to match other openCypher implementations.
- During the `0.2.x` series, we do **not** guarantee database migration or
  on-disk database compatibility between releases.
- Velr 0.2.14 includes a breaking on-disk storage change; existing databases
  from earlier releases must be recreated by re-importing the source data.
- Starting with the `0.3.x` series, we intend to guarantee internal database
  compatibility within the branch.

### Schema version 7 compatibility

This release's current on-disk schema is version 7. Supported older databases
can be opened with `Velr.open()` or `Velr.openReadonly()` without changing the
file. Reads continue to work on those databases, but writes (`CREATE`, `MERGE`,
`SET`, `DELETE`, `DETACH DELETE`, and other mutating queries) are only available
after migrating to the current schema version. This is intentional: migration
is an explicit maintenance operation, not a side effect of opening a database.

Velr is already usable for real workflows and representative use cases, but
rough edges remain and the API is not yet stable.

Fulltext search and vector search are available today through Cypher DDL and
`CALL` syntax. API details may still evolve while Velr remains alpha.

---

## Installation

Install from npm:

```bash
npm install @velr-ai/velr
```

The npm package selects a bundled native runtime for supported platforms during
installation. Users should not need to download or configure `.dll`, `.so`, or
`.dylib` files manually.

For Arrow table conversion workflows, install Apache Arrow:

```bash
npm install apache-arrow
```

### Licensing in simple terms

- The **JavaScript and TypeScript binding source code** in this package is
  licensed under **MIT**.
- The **bundled native runtime binaries** may be **used and freely
  redistributed in unmodified form** under the terms of **`LICENSE.runtime`**.

---

## Quick start

```ts
import { Velr } from "@velr-ai/velr";

const MOVIES_CREATE = `
CREATE
  (keanu:Person:Actor {name:'Keanu Reeves', born:1964}),
  (nolan:Person:Director {name:'Christopher Nolan'}),
  (matrix:Movie {title:'The Matrix', released:1999, genres:['Sci-Fi','Action']}),
  (inception:Movie {title:'Inception', released:2010, genres:['Sci-Fi','Heist']}),
  (keanu)-[:ACTED_IN {roles:['Neo']}]->(matrix),
  (nolan)-[:DIRECTED]->(inception);
`;

using db = Velr.open(null);
db.run(MOVIES_CREATE);

const table = db.execOne(
  "MATCH (m:Movie {title:'Inception'}) " +
    "RETURN m.title AS title, m.released AS year, m.genres AS genres"
);

try {
  console.log(table.columnNames());
  console.log(table.toObjects({ int64: "number" }));
} finally {
  table.close();
}
```

Open a file-backed database instead of an in-memory database:

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open("mygraph.db");
db.run("CREATE (:Person {name:'Alice'})");
```

Open an existing database for reads only:

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.openReadonly("mygraph.db");
const rows = db.query("MATCH (n) RETURN count(n) AS count", { int64: "number" });
console.log(rows);
```

`openReadonly()` never creates, initializes, migrates, or repairs a database.
The file must already exist and have a supported Velr schema version. Older
supported databases, such as schema version 3, 4, 5, or 6 databases opened by a
schema version 7 runtime, remain available for reads. Writes and features that
require the current schema fail with a normal query error until the database is
explicitly migrated.

---

## Schema migration

Velr does not migrate supported older databases automatically on open. Use the
driver migration API, or run `MIGRATE DATABASE`, from maintenance code when you
intend to update the on-disk schema. See the release-status note above for the
schema version 7 read/write compatibility behavior.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open("mygraph.db");

if (db.needsMigration()) {
  const report = db.migrate();
  console.log(report.status, report.fromVersion, report.toVersion, report.steps);
}
```

The equivalent Cypher command is useful for scripts and tools that already work
through query execution:

```ts
using db = Velr.open("mygraph.db");
const report = db.query("MIGRATE DATABASE");
console.log(report);
```

---

## Introspection

Use `SHOW CURRENT GRAPH SHAPE` to inspect the observed schema of the graph. It
reports the shape present in stored data: node labels, relationship types,
properties, observed value types, and counts. It is an observed shape surface,
not a declared GQL graph type.

`SHOW CURRENT GRAPH SHAPE` is available on schema version 5 or newer databases.
Older supported databases can still be opened for reads, but must be migrated
explicitly before this command is valid. Schema version 5 introduced this
inventory through the write planner instead of persistent graph-shape triggers.

The default projection returns `element_kind`, `element_name`, `property_name`,
`observed_type`, `owner_count`, `present_count`, and `missing_count`. `YIELD *`
exposes the full row shape, including `surface`, `source_label`, `target_label`,
`required`, `storage_class`, and `tag`.

```ts
using db = Velr.open("mygraph.db");

const rows = db.query(
  `
  SHOW CURRENT GRAPH SHAPE
  YIELD element_kind, element_name, property_name, observed_type, owner_count
  WHERE element_kind = 'node_property'
  RETURN element_name, property_name, observed_type, owner_count
  `,
  { int64: "number" }
);

console.log(rows);
```

Use `YIELD` to compose the command with `WHERE` and `RETURN`. Plain
`SHOW CURRENT GRAPH SHAPE` returns the default projection; `YIELD *` exposes the
full current row shape.

---

## Fulltext Search

Fulltext search is available through normal Cypher execution. Define indexes
with `CREATE FULLTEXT INDEX` and query them with
`CALL db.index.fulltext.queryNodes(...)`.

```ts
using db = Velr.open("mygraph.db");

db.run(`
  CREATE FULLTEXT INDEX paperText
  FOR (n:Paper) ON EACH [n.title, n.abstract]
`);

const rows = db.query(`
  CALL db.index.fulltext.queryNodes('paperText', 'abstract:vector')
  YIELD node, score
  RETURN node, score
`);
```

The query string supports this fulltext grammar:

- Terms: `vector search`
- Phrases: `"vector search"`
- Field scoping by indexed property: `title:graph`, `abstract:"vector search"`
- Boolean operators and grouping: `graph AND (vector OR semantic)`
- Default `OR` between adjacent terms: `vector search`
- Required and excluded terms: `+vector -draft`
- Phrase slop: `"vector search"~2`
- Phrase prefix on the last phrase term: `"vector sea"*`
- Boosts: `title:graph^2.0`
- Match all indexed nodes: `*`

Field scoping applies to the next term or phrase only. For example,
`title:graph search` searches `graph` in `title` and `search` in the default
fulltext field.

`score` is a non-normalized relevance score. Higher scores are better within a
single query result set; scores are not guaranteed to be in `0..1` or
comparable across different queries.

Fulltext indexes use a sidecar next to file-backed databases. The sidecar is
kept up to date by writes and rebuilt on open if it is missing or corrupt.

---

## Query model

A query may produce zero or more result tables.

Velr exposes three main ways to run Cypher:

- `run()` executes a query or script and drains all result tables.
- `exec()` returns a stream of result tables.
- `execOne()` expects exactly one result table.

### `run()`

Use `run()` when you only care about side effects:

```ts
using db = Velr.open(null);
db.run("CREATE (:Movie {title:'Interstellar', released:2014})");
```

### `execOne()`

Use `execOne()` when the query should yield exactly one table:

```ts
using db = Velr.open(null);
db.run("CREATE (:Person {name:'Alice', age:30})");

const table = db.execOne("MATCH (p:Person) RETURN p.name AS name, p.age AS age");
try {
  console.log(table.columnNames());
  console.log(table.toObjects({ int64: "number" }));
} finally {
  table.close();
}
```

### `exec()`

Use `exec()` when a query or script may produce multiple result tables:

```ts
using db = Velr.open(null);

const stream = db.exec(
  "MATCH (m:Movie {title:'The Matrix'}) RETURN m.title AS title; " +
    "MATCH (m:Movie {title:'Inception'}) RETURN m.released AS released"
);

try {
  for (const table of stream) {
    console.log(table.columnNames());
    console.log(table.toObjects({ int64: "number" }));
    table.close();
  }
} finally {
  stream.close();
}
```

---

## Bounded result previews

Pass `maxResultRows` when a host needs projected column names and a small row
sample without rewriting the Cypher text:

```ts
using db = Velr.openReadonly("mygraph.db");

const table = db.execOne(
  "MATCH (n) RETURN labels(n) AS labels, n.name AS name ORDER BY name",
  { maxResultRows: 20 }
);

try {
  const columns = table.columnNames();
  const sample = table.toObjects();
  console.log(columns);
  console.log(sample);
} finally {
  table.close();
}
```

`maxResultRows: 0` preserves column metadata and makes row cursors return no
rows. The cap is enforced by Velr during result emission, not by appending or
injecting Cypher `LIMIT`, and applies independently to each result table
produced by `exec()`. Existing Cypher `LIMIT` clauses still apply. It is not a
timeout or cancellation mechanism; keep read-only validation and execution
deadlines as separate host concerns.

---

## Query parameter binding

Pass `params` to bind openCypher parameters out of band. Query text uses
`$name`; parameter names in JavaScript and TypeScript omit the leading `$`.
Values are passed as Cypher values, not interpolated into query text, so a
JavaScript `string` is always a Cypher string value.

```ts
using db = Velr.open(null);

db.run("CREATE (:Person {name: $name, age: $age})", {
  params: { name: "Alice", age: 42 }
});

const rows = db.query(
  "MATCH (p:Person) WHERE p.age >= $minAge RETURN p.name AS name ORDER BY name",
  {
    maxResultRows: 20,
    params: { minAge: 18 }
  }
);

console.log(rows);
```

Supported parameter values are `null`, booleans, signed 64-bit integers,
finite numbers, strings, arrays, and objects with string keys. Use `bigint`
when an integer is outside the safe JavaScript integer range.

---

## Table lifetime and ownership

Table lifetime depends on how a table was obtained.

### Tables from `exec()`

Tables pulled from `exec()` are **stream-scoped**.

They remain valid while the producing stream remains open, and closing the
stream closes any still-open tables produced by that stream.

```ts
const stream = db.exec("MATCH (n) RETURN n");
const table = stream.nextTable();
// table is valid here while stream remains open
stream.close();
```

### Tables from `execOne()`

Tables returned by `execOne()` are **parent-scoped**, not stream-scoped.

- `Velr.execOne()` returns a table parented to the connection.
- `VelrTx.execOne()` returns a table parented to the transaction.

That means the returned table remains usable after the internal stream logic
used by `execOne()` has finished.

Even so, tables should still be closed when no longer needed, ideally with
`try` / `finally` or TypeScript `using`.

---

## Rows and cells

Rows are exposed through `Rows`. Each yielded row is an array of `Cell` objects.

`Cell.asJs()` converts values to normal JavaScript values:

- `NULL` to `null`
- `BOOL` to `boolean`
- `INT64` to `number` when safe, or `bigint` when outside the safe range
- `DOUBLE` to `number`
- `TEXT` to `string` by default
- `JSON` to parsed JavaScript values by default

Example:

```ts
const table = db.execOne("MATCH (p:Person) RETURN p.name AS name, p.age AS age");
try {
  const rows = table.rows();
  try {
    for (const row of rows) {
      console.log(row[0]?.asJs(), row[1]?.asJs({ int64: "number" }));
    }
  } finally {
    rows.close();
  }
} finally {
  table.close();
}
```

For convenience, `table.toObjects()` maps rows to JavaScript objects keyed by
column name.

---

## Transactions and savepoints

Use `beginTx()` to open a transaction:

```ts
using db = Velr.open(null);

const tx = db.beginTx();
try {
  tx.run("CREATE (:Movie {title:'Interstellar', released:2014})");
  tx.commit();
} catch (err) {
  if (!tx.closed) tx.rollback();
  throw err;
}
```

For callback-style transactional code, use `transaction()`:

```ts
using db = Velr.open(null);

db.transaction((tx) => {
  tx.run("CREATE (:Movie {title:'Interstellar', released:2014})");
});
```

If a transaction is closed without `commit()`, it is rolled back.

After `commit()` or `rollback()`, a transaction can no longer be used.

### Savepoints

Velr supports two savepoint styles:

- `savepoint()` creates a scoped, handle-owned savepoint.
- `savepointNamed(name)` creates a transaction-owned named savepoint.

Scoped savepoints are owned by the JavaScript handle:

- closing the handle closes the savepoint
- `release()` releases it
- `rollback()` rolls back to it and releases it

Named savepoints are owned by the transaction:

- closing the returned JavaScript handle does not remove the named savepoint
- `rollbackTo(name)` rolls back to that named savepoint, discards any newer
  named savepoints, and keeps the target named savepoint active
- `releaseSavepoint(name)` releases a named savepoint by name; the named
  savepoint must be the most recent active named savepoint
- `release()` or `rollback()` on a named savepoint handle consumes that named
  savepoint

Active named savepoints are released automatically during `commit()` so that
surviving changes are preserved in the committed transaction.

Use `withSavepoint()` or `withSavepointNamed(name)` when you want Python-style
scope behavior in JavaScript: the savepoint is released when the callback
returns and rolled back when the callback throws.

```ts
using db = Velr.open(null);

const tx = db.beginTx();
tx.run("CREATE (:Temp {k:'outer'})");

tx.savepointNamed("sp1");
tx.run("CREATE (:Temp {k:'a'})");

tx.savepointNamed("sp2");
tx.run("CREATE (:Temp {k:'b'})");

tx.rollbackTo("sp1"); // undoes a and b, drops sp2, keeps sp1 active
tx.run("CREATE (:Temp {k:'c'})");

tx.releaseSavepoint("sp1");
tx.commit();
```

---

## JavaScript / TypeScript / Apache Arrow interop

Velr can export result tables as Arrow IPC and convert them into an
`apache-arrow` table when the optional package is installed:

```ts
using db = Velr.open(null);
db.run(MOVIES_CREATE);

const table = db.execOne(
  "MATCH (m:Movie) RETURN m.title AS title, m.released AS released ORDER BY released"
);

try {
  const ipc = table.toArrowIpc();
  const arrowTable = await table.toArrowTable();
  console.log(ipc.byteLength, arrowTable);
} finally {
  table.close();
}
```

Velr can also bind external Arrow IPC file / Feather v2 bytes under a logical
name and query them from Cypher:

```ts
db.bindArrowIpc("_people", ipc);

const rows = db.query(`
  UNWIND BIND('_people') AS row
  RETURN row.name AS name
`);
```

The IPC buffer is borrowed only for the duration of the call.

---

## Vector indexes

Register an embedding callback, then reference it from `CREATE VECTOR INDEX`.

```ts
import { Velr, type VectorEmbedder } from "@velr-ai/velr";

const toyEmbedder: VectorEmbedder = (inputs) =>
  inputs.map((input) => {
    const text = input.fields.map((field) => String(field.value ?? "")).join("\n");
    return toyVector(text, input.dimensions);
  });

using db = Velr.open("graph.db");
db.registerVectorEmbedder("toy", toyEmbedder);

db.run(`
  CREATE VECTOR INDEX paperEmbedding IF NOT EXISTS
  FOR (n:Paper)
  ON EACH [n.title, n.abstract]
  OPTIONS {
    indexConfig: {
      dimensions: 3,
      metric: 'cosine',
      embedder: 'toy'
    }
  }
`);
```

`ON EACH [n.title, n.abstract]` passes both property values to the callback in
that order. Query text is passed as one unnamed string field. Vector `score` is
metric-dependent and non-normalized; higher scores are better within a single
query result set.

The direct callback is synchronous because the current native callback ABI calls
it synchronously. For heavier embedding work, use `VelrWorker` so database work
runs off the main thread.

---

## Worker threads

The core API is synchronous. Use `@velr-ai/velr/worker` to keep synchronous database work
off the main thread. The worker API mirrors the main driver, but methods that
touch the database are async and handle iteration uses `for await`.

```ts
import { VelrWorker } from "@velr-ai/velr/worker";

const db = await VelrWorker.open("graph.db");
try {
  await db.run("CREATE (:Job {name:'background'})");
  const rows = await db.query("MATCH (j:Job) RETURN j.name AS name");
  console.log(rows);
} finally {
  await db.close();
}
```

The same shape is available for transactions, result tables, streams, rows, and
explain traces:

```ts
await db.transaction(async (tx) => {
  await tx.run("CREATE (:Job {name: $name})", { params: { name: "queued" } });
});

const stream = await db.exec("RETURN 1 AS one; RETURN 2 AS two");
try {
  for await (const table of stream) {
    console.log(await table.columnNames(), await table.toObjects());
    await table.close();
  }
} finally {
  await stream.close();
}
```

`registerVectorEmbedder()` also works on `VelrWorker`. The function remains in
the owner thread, while the worker registers a native callback that bridges
embedding requests over shared memory and waits synchronously for the result.
The embedder may return vectors directly or return a promise.

Do not call back into the same `VelrWorker` from inside a worker embedder; the
database worker is paused waiting for that embedder response.

---

## Explain support

Velr exposes explain traces through:

- `Velr.explain()`
- `Velr.explainAnalyze()`
- `VelrTx.explain()`
- `VelrTx.explainAnalyze()`

These return an `ExplainTrace`, which can be navigated incrementally, fully
materialized with `snapshot()`, or rendered with `toCompactString()` when the
loaded runtime exposes compact rendering.

```ts
using db = Velr.open(null);

const trace = db.explain("MATCH (n) RETURN n");
try {
  console.log(trace.snapshot());
} finally {
  trace.close();
}
```

---

## Query language support

Velr supports the openCypher query language and passes all positive openCypher
TCK tests. Exact error semantics, including error messages, categories, and
timing, are not guaranteed to match other openCypher implementations.

---

## OpenCypher functions

The following openCypher functions and constructors are available:

**Graph and path**

- `id()`
- `type()`
- `labels()`
- `keys()`
- `properties()`
- `length()`
- `nodes()`
- `relationships()`

**Lists and predicates**

- `size()`
- `head()`
- `last()`
- `tail()`
- `reverse()`
- `range()`
- `all()`
- `any()`
- `none()`
- `single()`

**Strings and conversion**

- `coalesce()`
- `toInteger()`
- `toString()`
- `toLower()`
- `trim()`
- `substring()`
- `split()`

**Numeric**

- `abs()`
- `ceil()`
- `rand()`
- `sign()`
- `sqrt()`

**Temporal**

- `date()`
- `time()`
- `localtime()`
- `datetime()`
- `localdatetime()`
- `duration()`
- `datetime.fromepoch()`
- `datetime.fromepochmillis()`
- `date.realtime()`, `date.transaction()`, `date.statement()`
- `time.realtime()`, `time.transaction()`, `time.statement()`
- `localtime.realtime()`, `localtime.transaction()`, `localtime.statement()`
- `datetime.realtime()`, `datetime.transaction()`, `datetime.statement()`
- `localdatetime.realtime()`, `localdatetime.transaction()`,
  `localdatetime.statement()`

**Aggregates**

- `count()`
- `sum()`
- `avg()`
- `min()`
- `max()`
- `collect()`
- `percentileDisc()`
- `percentileCont()`

---

## Thread safety

The direct `Velr` driver is synchronous and intended to be used from one Node.js
thread at a time.

Use `VelrWorker` from `@velr-ai/velr/worker` when you want database work to run on a
worker thread and expose an async API to the main thread.

---

## Platform support

This package installs or resolves a bundled native runtime for the current
platform so user installation stays:

```bash
npm install @velr-ai/velr
```

Currently targeted bundled platforms:

- macOS universal (arm64 + x86_64)
- Linux x86_64
- Linux aarch64
- Windows x86_64

For local Velr development only, you can override runtime resolution with an
explicit native library path:

```bash
VELR_NATIVE_LIBRARY=/path/to/libvelrc.dylib node app.mjs
```

`VELR_LIB` is accepted as a shorter alias. This override is intended for local
development and troubleshooting; normal npm users should not need it.

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
VELR_JS_NATIVE_TESTS=1 npm test
```

Useful development environment variables:

- `VELR_NATIVE_LIBRARY`: explicit path to `libvelrc.dylib`, `libvelrc.so`, or
  `velrc.dll`
- `VELR_LIB`: short alias for `VELR_NATIVE_LIBRARY`
- `VELR_JS_NATIVE_TESTS=1`: opt in to tests that load the native runtime
- `VELR_JS_NATIVE_FEATURE_TESTS=1`: also run fulltext/vector engine feature
  tests

The driver targets Node.js 22 and newer.

---

## License

This package is licensed under the MIT License. See [`LICENSE`](LICENSE).

The bundled native runtime may be used and freely redistributed in unmodified
form under the terms of [`LICENSE.runtime`](LICENSE.runtime).
