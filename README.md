# Velr

Velr is an embedded property-graph database from Velr.ai, queried using openCypher.

It runs in-process and is designed for local, embedded, and edge use cases.

This package provides the **JavaScript and TypeScript bindings** for Velr and
bundles the database runtime. It exposes an idiomatic Node.js API for executing Cypher queries, streaming result
tables, working with transactions, using worker threads, and exporting or
binding Arrow IPC data.

For the main Velr public entry point, see
[velr-ai/velr](https://github.com/velr-ai/velr).  
For the Velr website, see [velr.ai](https://velr.ai/).

## Community

- **Community and questions:** [GitHub Discussions](https://github.com/velr-ai/velr/discussions)
- **Bug reports and feature requests:** [GitHub Issues](https://github.com/velr-ai/velr/issues)
- **JavaScript examples:** [velr-ai/velr-javascript-examples](https://github.com/velr-ai/velr-javascript-examples)
- **TypeScript examples:** [velr-ai/velr-typescript-examples](https://github.com/velr-ai/velr-typescript-examples)

We'd love to have you join the Velr community.

---

## Compatibility

Databases created before Velr 0.2.14 must be recreated by re-importing the source
data.

### Schema version 11 compatibility

New databases use schema version 11. Databases at schema versions 3 through 9
require an [explicit migration](#schema-migration) before graph queries can run.

Create fulltext and vector indexes with Cypher DDL and query them with `CALL`.

---

## Installation

The driver requires Node.js 22 or newer.

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
The file must already exist and have a supported Velr schema version. After
migrating an older database on a writable connection, reopen any read-only
connections before querying it.

### Inline edge properties

Use `Velr.create()` to choose a frequently used relationship property, such
as a numeric timestamp. The choice applies to that name across all
relationship types.

```ts
import { Velr } from "@velr-ai/velr";

{
  using db = Velr.create("events.db", { inlineEdgeProperties: ["timestamp"] });
  db.run("CREATE ()-[:EVENT {timestamp: 1700000000}]->()");
}

using db = Velr.openReadonly("events.db");
console.log(db.inlineEdgeProperties()); // ["timestamp"]
console.log(db.query("MATCH ()-[r:EVENT]->() RETURN r.timestamp AS timestamp"));
// [{ timestamp: 1700000000 }]
```

Use a new file path and pass at most one name. The selection is fixed when
the database is created. Omit the list or pass an empty list to leave inline
edge properties disabled. Velr can inline integers, floating-point numbers,
and strings up to 128 UTF-8 bytes. Values too large to inline still work with
the same Cypher reads and writes.

`VelrWorker.create()` and `inlineEdgeProperties()` provide the same
operations as promises in the worker driver.

---

## Schema migration

Open the database on a writable connection and call `migrate()` or run
`MIGRATE DATABASE` outside an active transaction.

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

## Maintenance

After large deletes or prune operations on a file-backed database, call
`db.vacuum()` from maintenance code when you want to compact the database file:

```ts
using db = Velr.open("mygraph.db");
db.run("MATCH (n:Expired) DETACH DELETE n");
db.vacuum();
```

`vacuum()` must run on a writable current-schema connection outside an open
transaction. The equivalent command for scripts is `VACUUM DATABASE`.

---

## Introspection

Use `SHOW CURRENT GRAPH SHAPE` to inspect the observed schema of the graph. It
reports the shape present in stored data: node labels, relationship types,
properties, observed value types, and counts. It is an observed shape surface,
not a declared GQL graph type.

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

`score` is an unnormalized, query-specific relevance score. Higher scores
indicate more relevant matches within that query's result set. Compare scores
within the same query; values are not restricted to `0..1`.

Fulltext queries return up to 1,000 matches by default. Pass a third
argument such as `{limit: 5000}` to change the cap.

Fulltext queries see changes made earlier in the current transaction.
Opening a file-backed database for writing applies pending index updates
and repairs missing or corrupt index data. If the shared index cannot serve
the query's snapshot, Velr builds a temporary index for that search. This
can happen when updates are pending, a concurrent writer has published a
newer index, or a read-only connection opens an index that needs repair.
The temporary build scans the indexed graph.

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

The returned table remains usable until it or its parent connection or
transaction is closed.

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

Velr supports two vector index shapes.

If your application already computes embeddings, store them as a vector/list
property and index that property. No embedder is needed, and queries pass a
numeric vector/list:

```ts
using db = Velr.open("graph.db");

db.run(`
  CREATE (:Chunk {
    id: 'chunk-1',
    text: 'Graph databases store connected data',
    embedding: [0.12, 0.34, 0.56]
  })
`);

db.run(`
  CREATE VECTOR INDEX chunkEmbedding IF NOT EXISTS
  FOR (n:Chunk)
  ON (n.embedding)
  OPTIONS { indexConfig: { dimensions: 3, metric: 'cosine' } }
`);

const rows = db.query(`
  CALL db.index.vector.queryNodes('chunkEmbedding', 10, [0.10, 0.30, 0.50])
  YIELD node, score
  RETURN node, score
`);
```

For exact query-time scoring without a native vector index, use the
Neo4j-compatible scalar function `vector.similarity.cosine(left, right)` inside
`WITH`, `WHERE`, `RETURN`, and `ORDER BY`.

For text-to-vector search, register an embedding callback and reference it from
`CREATE VECTOR INDEX`.

`OPTIONS { indexConfig: ... }` configures Velr vector indexes. Prefer the
Neo4j-style names where they exist; shorter aliases are accepted for existing
queries and examples.

```cypher
OPTIONS {
  indexConfig: {
    `vector.dimensions`: 384,
    `vector.similarity_function`: 'cosine',
    embedder: 'text',
    cache_policy: 'required',
    `vector.hnsw.ef_search`: 128
  }
}
```

Core options:

| Option | Accepted aliases | Meaning |
|---|---|---|
| `` `vector.dimensions` `` | `dimensions` | Required vector width. Every stored vector, embedder output, and query vector must contain exactly this many values. |
| `` `vector.similarity_function` `` | `metric`, `similarity_function` | Distance function. Use `cosine` for most semantic embeddings, `l2`/`euclidean` for geometric distance, and `dot`/`inner_product`/`max_inner_product` for inner-product retrieval. Default: `cosine`. |
| `embedder` | `velr.embedder` | Name of a registered callback for `ON EACH [...]` indexes. Omit it for stored-vector indexes such as `ON (n.embedding)`. |
| `embedder_fingerprint` | `embedderFingerprint`, `velr.embedder_fingerprint` | Optional model/version metadata stored with the index definition. Velr does not use it to call the embedder. |
| `cache_policy` | `cachePolicy` | Embedder-backed indexes only. `required` stores generated embeddings in the database so index files can be rebuilt without recomputing them; `best_effort` skips cache write errors; `none` stores no generated embedding cache. Defaults: `required` with `embedder`, `none` without. Stored-vector indexes require `none` because the vector property is already the durable source. |

HNSW tuning options:

| Option | Integer count | Meaning |
|---|---:|---|
| `` `vector.hnsw.m` `` | `1..512` neighbors | Maximum graph connectivity per vector. For example, `16` means each vector keeps roughly 16 HNSW neighbor links. Higher values can improve recall on difficult datasets, with more memory, larger index files, and slower builds. |
| `` `vector.hnsw.ef_construction` `` | `1..3200` candidates | Build-time candidate pool per inserted vector. For example, `320` means the builder considers a working set of 320 candidate neighbors while placing each vector. Higher values can improve index quality and recall, usually with slower index creation. |
| `` `vector.hnsw.ef_search` `` | `1..3200` candidates | Query-time candidate pool. For example, `128` means each search keeps a working set of 128 candidate vectors while traversing the HNSW graph. Higher values can improve recall, usually with slower searches. Velr's default is `64`. |

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

For file-backed databases, Velr can repair missing or corrupt vector index data
from stored vector properties or from registered embedders, depending on how
the index was created.

Embedding callbacks run while Velr is maintaining the index or evaluating the
query. For heavier embedding work, use `VelrWorker` so database work runs off
the main thread.

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

## Regular expression matching

Use the openCypher operator `=~` to match an entire string against a regular
expression. Matching is case-sensitive by default. Use `(?i)` for
case-insensitive matching.

```cypher
RETURN 'alice' =~ '(?i)A.*' AS matched
```

This returns `true`.

The pattern string uses the Rust regex dialect. Lookaround and backreferences
are unsupported. A null or non-string operand yields `null`. An invalid
pattern raises a query error when both operands are strings.
See [supported pattern syntax](https://docs.rs/regex/latest/regex/#syntax).

---

## Errors

Query and database failures throw `VelrError`, with diagnostic text in `message`
and an optional numeric operation status in `code`. For Cypher errors, the
diagnostic identifies the query category and compile-time or runtime phase.
Categories include
`SyntaxError`, `TypeError`, `ArgumentError`, `EntityNotFound`,
`ConstraintVerificationFailed`, `SemanticError`, `ParameterMissing`,
`ProcedureNotFound`, and `ArithmeticError`.

`VelrStateError` extends `VelrError` for closed or consumed handles.
`VelrTypeError` extends JavaScript `TypeError` for invalid JavaScript arguments
and incompatible value conversions.

Handle errors around both query execution and result consumption. `nextTable()`,
row iteration, and collection can throw after a stream or table is returned.
Worker API operations reject their promises with the corresponding errors.

```ts
import { Velr, VelrError } from "@velr-ai/velr";

using db = Velr.open(null);
try {
  console.log(db.query("RETURN missing"));
} catch (error) {
  if (error instanceof VelrError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
```

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

Bundled platforms:

- macOS arm64 (Apple Silicon)
- macOS x86_64 (Intel)
- Linux x86_64
- Linux aarch64
- Windows x86_64

---

## License

This package is licensed under the MIT License. See [`LICENSE`](LICENSE).

The bundled native runtime may be used and freely redistributed in unmodified
form under the terms of [`LICENSE.runtime`](LICENSE.runtime).
