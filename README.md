# Velr for JavaScript and TypeScript

Velr is an embedded property-graph database queried with openCypher. This Node.js
package includes the database runtime, a synchronous API, and an asynchronous
worker API. Databases can live in memory or in a local file. Use the
[driver guide](GUIDE.md) for detailed workflows and the [API reference](API.md)
for complete method and option contracts.

## Requirements and installation

- Node.js 22 or newer. Browsers are unsupported.
- Bundled runtimes: macOS arm64/x86_64, Linux arm64/x86_64 with glibc, and Windows
  x86_64. Linux musl environments, including Alpine, are unsupported by these bundles.
- Keep npm optional dependencies enabled; they supply the runtime for your platform.
- `SEARCH` and creation options below require Velr runtime 0.2.62 or newer.
  Use a driver and runtime from the same release.

```sh
npm install @velr-ai/velr
```

TypeScript declarations and API comments are included. TypeScript users need
TypeScript 5.2 or newer for explicit resource management, a compiler compatible
with their installed Node.js types, and `ESNext.Disposable` in the compiler
`lib` list. The examples below are JavaScript and also work in TypeScript.
Apache Arrow is optional; install `apache-arrow` 15 or newer for `toArrowTable()`:

```sh
npm install apache-arrow
```

See the [TypeScript setup guide](GUIDE.md#running-the-typescript-examples) for
a complete compiler configuration, including the optional Arrow types.

## Quick start

Save this as `example.mjs` and run `node example.mjs`:

```js
import { Velr } from "@velr-ai/velr";

const db = Velr.open();
try {
  db.run("CREATE (:Person {name: $name, born: $born})", {
    params: { name: "Keanu Reeves", born: 1964 },
  });
  const rows = db.query(
    "MATCH (p:Person {name: $name}) RETURN p.name AS name, p.born AS born",
    { params: { name: "Keanu Reeves" } },
  );
  console.log(rows[0].name, rows[0].born); // Keanu Reeves 1964
} finally {
  db.close();
}
```

Each JavaScript example below is a standalone ES module. Save it as an `.mjs`
file and run it with Node.js; every opened handle is closed when finished.

## Queries and results

### In-memory, persistent, and read-only databases

`Velr.open()` creates a private in-memory database. Pass a path to open or create
a persistent database. Parent directories must exist. A read-only connection
requires an existing supported database and never creates, initializes, migrates,
or repairs it:

```js
import { Velr } from "@velr-ai/velr";

const writer = Velr.open("graph.db");
try {
  writer.run("MERGE (:Person {name: 'Alice'})");
} finally {
  writer.close();
}
const reader = Velr.openReadonly("graph.db");
try {
  console.log(reader.query("MATCH (p:Person) RETURN p.name AS name"));
} finally {
  reader.close();
}
```

### Database creation options

`Velr.create(path, options)` creates a new database and rejects an existing file;
omit the path or pass `null` for an in-memory database. For a creation-time
relationship property selection, pass zero or one case-sensitive, nonempty name
without NUL characters:

```js
import { Velr } from "@velr-ai/velr";

const configuredDb = Velr.create(null, { inlineEdgeProperties: ["weight"] });
try {
  configuredDb.run("CREATE ()-[:LINK {weight:$weight}]->()", { params: { weight: 0.5 } });
  console.log(configuredDb.inlineEdgeProperties()); // ['weight']
} finally {
  configuredDb.close();
}
```

The selection applies across relationship types, persists when a file is reopened,
and cannot be changed after creation. Read and write every value through ordinary Cypher.
Omit the option to use the default empty selection. `VelrWorker.create()` provides
the same options asynchronously.

### Choosing an execution method

The same query methods are available on connections and transactions:

| Method | Use it for | Result ownership |
|---|---|---|
| `query()` | Collect exactly one table as objects | Automatically closes its table |
| `run()` / `execute()` | Writes or scripts whose rows you do not need | Drains and closes results |
| `execOne()` | Exactly one table with metadata and row access | Close the returned table |
| `exec()` | Scripts that may produce multiple tables | Close the stream and its tables |

### Parameters and owned values

Bind `$name` separately through `params` keys without `$`. Parameters accept
`null`, booleans, finite numbers, signed 64-bit `bigint` values, strings, nested
arrays, and objects with string keys. Use `bigint` for integers outside
JavaScript's safe integer range. For example, create several nodes from a list
of records and select them with a bound filter:

```js
import { Velr } from "@velr-ai/velr";

const peopleDb = Velr.open();
try {
  peopleDb.run("UNWIND $people AS p CREATE (:Person {name:p.name, age:p.age})", {
    params: { people: [{ name: "Alice", age: 42 }, { name: "Bob", age: 17 }] },
  });
  console.log(peopleDb.query(
    "MATCH (p:Person) WHERE p.age >= $minAge RETURN p.name AS name, p.age AS age",
    { params: { minAge: 18 } },
  )); // [{ name: 'Alice', age: 42 }]
} finally {
  peopleDb.close();
}
```

Result integers become `number` when safe and `bigint` otherwise. Choose
`int64: "bigint"` or `"string"` for a uniform representation; `"number"` can
lose precision. Text becomes a string and JSON cells are parsed by default.
`JSON.parse` can lose precision for large JSON integers; `parseJson: false`
keeps their raw text. Use unique result aliases: Cypher rejects duplicate result
column names. `query()` collects all rows in memory.

### Multiple result tables and rows

Use `exec()` for scripts and `table.rows()` for incremental row processing.
Each row contains `Cell` objects; `asJs()` converts a cell to a JavaScript value:

```js
import { Velr } from "@velr-ai/velr";

const streamDb = Velr.open();
try {
  const stream = streamDb.exec("RETURN 1 AS one; RETURN 2 AS two");
  try {
    for (const table of stream) {
      try {
        console.log(table.columnNames());
        const rows = table.rows();
        try {
          for (const row of rows) console.log(row.map((cell) => cell.asJs()));
        } finally {
          rows.close();
        }
      } finally {
        table.close();
      }
    }
  } finally {
    stream.close();
  }
} finally {
  streamDb.close();
}
```

Tables from `exec()` require their stream to remain open; `execOne()` tables
belong directly to their connection or transaction. Closing a parent closes its
remaining children. Keep parents open until results are finished; copied cells
and collected JavaScript values remain usable afterward.

### Row caps, deadlines, and cancellation

`maxResultRows` limits each result table; `0` preserves columns without rows.
Existing Cypher `LIMIT` clauses still apply. A row cap does not prevent writes
or bound execution time. `timeoutMs` is a finite, non-negative deadline in
milliseconds covering execution and subsequent table/row reads. Omit it for no
deadline; `timeoutMs: 0` expires immediately:

```js
import { Velr } from "@velr-ai/velr";

const previewDb = Velr.open();
try {
  console.log(previewDb.query("UNWIND range(1, 100) AS n RETURN n", {
    maxResultRows: 3,
    timeoutMs: 2_000,
  })); // [{ n: 1 }, { n: 2 }, { n: 3 }]
} finally {
  previewDb.close();
}
```

Use the [worker API](#run-asynchronously-and-cancel-work) with an `AbortSignal`
when work must be cancelled from the event loop. The direct API supports
deadlines; it does not accept a query `AbortSignal`. See the
[query control guide](GUIDE.md#query-cancellation-and-timeouts) for fetch-time
errors and cancellation lifetime.

## Transactions

### Commit, rollback, and savepoints

`transaction()` commits when its synchronous callback returns and rolls back
when it throws, unless the callback has already ended the transaction. A
savepoint lets you discard part of the work and keep the surrounding changes:

```js
import { Velr } from "@velr-ai/velr";

const txDb = Velr.open();
try {
  txDb.transaction((tx) => {
    tx.run("CREATE (:Person {name:'Alice'})");
    tx.withSavepoint((savepoint) => {
      tx.run("CREATE (:Person {name:'Temporary'})");
      savepoint.rollback();
    });
  });
  console.log(txDb.query("MATCH (p:Person) RETURN p.name AS name")); // Alice only
} finally {
  txDb.close();
}
```

For manual control, `beginTx()` returns a transaction with `commit()`,
`rollback()`, and `close()`. Closing an uncommitted transaction rolls it back;
commit/rollback consumes it and closes its results. Anonymous savepoints roll
back and release on close.

Only one transaction can be active on a connection. A writable transaction
reserves the writer slot when it starts. For a read-only snapshot while another
connection writes, open a separate read-only connection and begin its
transaction there. Use the transaction handle for all work in that scope.

Direct callbacks must be synchronous: do not pass an `async` function to
`transaction()`, savepoint helpers, row visitors, or row mappers. Returned
promises are not awaited. Worker counterparts await supported callbacks.
Keep unrelated operations on the same worker serialized until an async
transaction callback has finished, including across its `await` expressions.
See the [transaction guide](GUIDE.md#transactions-and-savepoints) for details.

### Named savepoints

Named savepoints from `savepointNamed(name)` belong to the transaction and remain
active when their JavaScript handle closes. Names must be unique while active.
`rollbackTo(name)` keeps its target and discards newer named savepoints; release
the newest with `releaseSavepoint(name)`. Commit releases surviving named
savepoints:

```js
import { Velr } from "@velr-ai/velr";

const db = Velr.open();
try {
  db.transaction((tx) => {
    tx.run("CREATE (:Person {name:'Alice'})");
    tx.savepointNamed("beforeDraft").close();
    tx.run("CREATE (:Person {name:'Draft'})");
    tx.rollbackTo("beforeDraft");
    tx.run("CREATE (:Person {name:'Grace'})");
    tx.releaseSavepoint("beforeDraft");
  });
  console.log(db.query("MATCH (p:Person) RETURN p.name AS name ORDER BY name"));
  // [{ name: 'Alice' }, { name: 'Grace' }]
} finally {
  db.close();
}
```

## Errors and concurrency

### Handle execution and fetch errors

Direct database/query failures throw `VelrError`; inspect `message`, `code`, and
`stopReason`. Driver-side argument/conversion failures use `VelrTypeError`;
closed or consumed direct handles use `VelrStateError`. Worker operations reject
promises. A worker child invalidated by closing its parent can reject with an
ordinary `Error`, and its `closed` flag may remain false. That flag records
closure of the individual handle; keep parents open until their children are
finished. Queries can fail when execution
starts, a stream advances, or rows are read. Put the complete operation in your
error-handling scope and close results on success, error, or early exit:

```js
import { Velr } from "@velr-ai/velr";

import { VelrError } from "@velr-ai/velr";

const errorDb = Velr.open();
try {
  console.log(errorDb.query("RETURN missing"));
} catch (error) {
  if (error instanceof VelrError) console.error(error.message);
  else throw error;
} finally {
  errorDb.close();
}
```

### Run asynchronously and cancel work

The direct API is synchronous and runs on the calling Node.js thread. Use each
connection and its handles on one thread. `VelrWorker` keeps database work off
the event loop; its methods return promises and streams/rows support `for await`.
Pass an `AbortSignal` to cancel execution and subsequent result reads:

```js
import { VelrWorker } from "@velr-ai/velr/worker";

const workerDb = await VelrWorker.open();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 25);
try {
  const rows = await workerDb.query(
    "UNWIND range(1, 1000000) AS n RETURN sum(n) AS total",
    { signal: controller.signal, timeoutMs: 2_000 },
  );
  console.log(rows);
} catch (error) {
  const reason = error && typeof error === "object" && "stopReason" in error
    ? error.stopReason : undefined;
  if (reason === "cancelled" || reason === "deadline_exceeded") console.log(reason);
  else throw error;
} finally {
  clearTimeout(timer);
  await workerDb.close();
}
```

A stop reports `"cancelled"` or `"deadline_exceeded"`; fast queries can complete
before a stop request. Keep cancellation controls available until fetching
finishes. If interruption ends an explicit transaction, start a new one.

## Features and integrations

### SEARCH clause

Use `MATCH` or `OPTIONAL MATCH` with `SEARCH` to retrieve fulltext or vector
matches through the normal query methods. Search indexes require a file-backed
database and a mandatory `LIMIT` inside the search parentheses. Bind query values
and limits with parameters. `SCORE AS score` exposes each match's score;
`ORDER BY score DESC` orders the returned rows explicitly.

`LIMIT` accepts integers from `0` through `2147483647`; fulltext `SKIP`/`OFFSET`
accepts integers from `0` through `9223372036854775807`. Pagination expressions
can use constants and parameters, but cannot depend on query variables. Query
values can refer to variables from earlier clauses, including correlated
`EXISTS { ... }` and `COUNT { ... }` subqueries.

Vector index names must be identifiers; use backticks for names containing
spaces. Fulltext index names also accept string parameters. Search patterns
contain one node or one relationship hop, with only the searched element named
or constrained. For relationship indexes, use `MATCH ()-[r]->()` with `SEARCH r`.
Null queries and zero limits produce no matches; `OPTIONAL MATCH` preserves the
input row with null entity and score values. Use a fresh name for `SCORE AS`.
The [search guide](GUIDE.md#search-clause) gives complete filtering, pagination,
analyzer, relationship, and correlated-subquery examples.

### Fulltext search

Define an index with Cypher DDL, then search it. This example seeds a paper,
binds the index and query, and selects the first page:

```js
import { Velr } from "@velr-ai/velr";

const searchDb = Velr.open("search.db");
try {
  searchDb.run("MERGE (p:Paper {id:'paper-1'}) SET p.title=$title, p.abstract=$abstract", {
    params: { title: "Graph databases", abstract: "Connected data and vector search" },
  });
  searchDb.run(`CREATE FULLTEXT INDEX paperText IF NOT EXISTS
    FOR (n:Paper) ON EACH [n.title, n.abstract]`);
  console.log(searchDb.query(`
    MATCH (node:Paper)
    SEARCH node IN (FULLTEXT INDEX $index FOR $text
      WITH ANALYZER 'standard' OFFSET $offset LIMIT $limit)
    SCORE AS score RETURN node.title AS title, score ORDER BY score DESC
  `, { params: { index: "paperText", text: "title:graph", offset: 0, limit: 10 } }));
} finally {
  searchDb.close();
}
```

Search text supports terms, phrases, field scopes, boolean grouping, prefixes,
and boosts. Scores rank matches within a query and are not normalized or
comparable across queries. Writes update indexes automatically.
`WITH ANALYZER` selects `standard` (default), `keyword`, `whitespace`, `simple`,
or `english`; `standard-no-stop-words` and `default` are aliases for `standard`.
An enclosing `WHERE` filters the selected page; fulltext has no inner `WHERE`.

### Vector search and embeddings

Store precomputed embeddings as numeric vector/list properties and index them:

```js
import { Velr } from "@velr-ai/velr";

const vectorDb = Velr.open("vectors.db");
try {
  vectorDb.run("MERGE (n:Chunk {id:'chunk-1'}) SET n.text=$text, n.embedding=$embedding, n.category=$category", {
    params: { text: "Connected data", embedding: [0.12, 0.34, 0.56], category: "guide" },
  });
  vectorDb.run(`CREATE VECTOR INDEX chunkEmbedding IF NOT EXISTS
    FOR (n:Chunk) ON (n.embedding) WITH [n.category]
    OPTIONS {indexConfig: {dimensions: 3, metric: 'cosine'}}`);
  console.log(vectorDb.query(`
    MATCH (node:Chunk)
    SEARCH node IN (VECTOR INDEX chunkEmbedding FOR $embedding
      WHERE node.category = $category LIMIT $limit)
    SCORE AS score RETURN node.text AS text, score ORDER BY score DESC
  `, { params: { embedding: [0.10, 0.30, 0.50], category: "guide", limit: 10 } }));
} finally {
  vectorDb.close();
}
```

Vectors must match the configured dimensions; cosine query vectors must be
nonzero. Cosine `SEARCH` scores use `(1 + cosine) / 2`; Euclidean scores use
`1 / (1 + squaredDistance)`. Both range from 0 to 1, with higher scores better.
Dot-product indexes use unbounded dot scores. For exact scoring without an
index, use `vector.similarity.cosine(left, right)` in Cypher.

Declare filter properties with index DDL `WITH [...]`. An inner `WHERE` filters
before nearest-neighbor selection; an enclosing `WHERE`, before or after
`SEARCH`, filters the selected matches and can return fewer than the limit.
Inner filters support property comparisons, `IN`, boolean and null tests joined
by `AND`. Each property permits one lower and one upper bound, or one equality,
`IN`, or null test. Use the enclosing `WHERE` for other predicates. Vector search
does not accept inner `SKIP`, `OFFSET`, or `WITH ANALYZER`.

For text embeddings, `registerVectorEmbedder(name, callback)` supplies one finite
vector per input, in order and with the requested dimensions. Reference the name
with `embedder: 'name'` in an `ON EACH [...]` vector index. Direct callbacks are
synchronous; worker callbacks can be async but run on the caller's thread. Do
not call the same connection/worker from its embedder. Register the callback on
each connection whose operations need embeddings, including after reopening a
file. If a transaction has pending changes to an embedder-backed index, commit
or roll back before searching that index. The
[vector guide](GUIDE.md#vector-search-and-embeddings) demonstrates registration,
text queries, callback inputs, and index options.

### Compatible procedure calls

Existing fulltext and vector procedures remain supported, including
`queryRelationships` for relationship indexes. These standalone examples use
the procedure forms with bound query values:

```js
import { Velr } from "@velr-ai/velr";

const db = Velr.open("fulltext-procedure.db");
try {
  db.run("MERGE (:Paper {title:'Graph databases'})");
  db.run("CREATE FULLTEXT INDEX paperText IF NOT EXISTS FOR (p:Paper) ON EACH [p.title]");
  console.log(db.query(
    "CALL db.index.fulltext.queryNodes('paperText', $text, {limit: 10}) " +
      "YIELD node, score RETURN node.title AS title, score ORDER BY score DESC",
    { params: { text: "graph" } },
  ));
} finally {
  db.close();
}
```

```js
import { Velr } from "@velr-ai/velr";

const db = Velr.open("vector-procedure.db");
try {
  db.run("MERGE (:Chunk {text:'Connected data', embedding:[1.0,0.0]})");
  db.run(`CREATE VECTOR INDEX chunkEmbedding IF NOT EXISTS
    FOR (n:Chunk) ON (n.embedding) OPTIONS {indexConfig:{dimensions:2, metric:'cosine'}}`);
  console.log(db.query(
    "CALL db.index.vector.queryNodes('chunkEmbedding', 10, $embedding) " +
      "YIELD node, score RETURN node.text AS text, score ORDER BY score DESC",
    { params: { embedding: [1.0, 0.0] } },
  ));
} finally {
  db.close();
}
```

Fulltext procedure scores use the same scale as `SEARCH`; without an explicit
options limit they return at most 1,000 matches. Vector procedures retain raw
cosine or negative squared Euclidean scores, so their scores differ from
`SEARCH`. Registered embedders also accept text queries through vector procedures.

### Arrow import and export

`toArrowIpc()` exports owned IPC file/Feather v2 bytes without an Arrow JavaScript
dependency. Bind those bytes with `bindArrowIpc()` and read them using `BIND()`:

```js
import { Velr } from "@velr-ai/velr";

const arrowDb = Velr.open();
try {
  const table = arrowDb.execOne("RETURN 'Alice' AS name, 42 AS age");
  try {
    const ipc = table.toArrowIpc();
    arrowDb.bindArrowIpc("_people", ipc);
    console.log(arrowDb.query(`
      UNWIND BIND('_people') AS row RETURN row.name AS name, row.age AS age
    `));
    // Requires the optional apache-arrow package installed above:
    const arrowTable = await table.toArrowTable();
    console.log(arrowTable.numRows, arrowTable.numCols); // 1 2
  } finally {
    table.close();
  }
} finally {
  arrowDb.close();
}
```

IPC streams are unsupported. Input buffers are borrowed only during binding;
exported buffers and converted Arrow tables outlive result handles. Keep the
source table open until `toArrowTable()` resolves. Exports can materialize the
whole result. Types are inferred per result: numeric columns can be integers or
floats, incompatible mixed kinds become strings, and lists/maps/graph values are
JSON UTF-8 strings rather than nested Arrow arrays. Nulls stay null;
empty/all-null columns are UTF-8. Inspect the exported schema before choosing
data types.

### Graph introspection and explain

```js
import { Velr } from "@velr-ai/velr";

const inspectionDb = Velr.open("inspection.db");
try {
  inspectionDb.run("MERGE (:Paper {title: 'Graph databases'})");
  inspectionDb.run("CREATE FULLTEXT INDEX paperText IF NOT EXISTS FOR (p:Paper) ON EACH [p.title]");
  console.log(inspectionDb.query(`SHOW INDEXES
    YIELD name, type, entityType, properties
    RETURN name, type, entityType, properties ORDER BY name`));
  console.log(inspectionDb.query("CALL db.labels() YIELD label RETURN label ORDER BY label"));
  console.log(inspectionDb.query(`SHOW CURRENT GRAPH SHAPE
    YIELD element_kind, element_name, property_name, observed_type
    RETURN element_kind, element_name, property_name, observed_type`));
  const trace = inspectionDb.explain("MATCH (p:Paper) RETURN count(p) AS papers");
  try {
    console.log(trace.toCompactString());
  } finally {
    trace.close();
  }
} finally {
  inspectionDb.close();
}
```

Graph shape describes stored data rather than declaring a schema. `explain()`
does not execute the query; `explainAnalyze()` executes it, including writes.
Use `trace.snapshot()` for an owned structured result; copied snapshots and
strings remain usable after closure. Explain methods accept query text without
parameter bindings or query options. See the [explain guide](GUIDE.md#explain-plans).
`SHOW INDEXES` lists range, fulltext, and vector indexes. `db.labels()`,
`db.relationshipTypes()`, and `db.propertyKeys()` list the graph's labels,
relationship types, and property names.

## Compatibility and maintenance

Opening a database never migrates it automatically. New databases use schema
version 11. Databases at schema versions 3 through 9 require explicit migration
on a writable connection before graph queries or transactions can run. After
migration, reopen any read-only connections. Databases created before Velr
0.2.14 must be recreated by importing the source data.

```js
import { Velr } from "@velr-ai/velr";

const maintenanceDb = Velr.open("maintenance.db");
try {
  if (maintenanceDb.needsMigration()) {
    const report = maintenanceDb.migrate();
    console.log(report.status, report.fromVersion, report.toVersion);
  }
  maintenanceDb.run("MERGE (:Expired {id:'old'})");
  maintenanceDb.run("MATCH (n:Expired) DETACH DELETE n");
  maintenanceDb.vacuum();
  console.log(maintenanceDb.query("MATCH (n:Expired) RETURN count(n) AS remaining"));
} finally {
  maintenanceDb.close();
}
```

Migration and vacuum require a writable connection outside an active
transaction; vacuum also requires the current schema. Their Cypher equivalents
are `MIGRATE DATABASE` and `VACUUM DATABASE`. Migrate supported older databases
before inspecting their graph shape.

Normally npm supplies the runtime. For a custom compatible library, set
`VELR_NATIVE_LIBRARY` to its absolute path before the first connection opens
(`VELR_LIB` is an alias). See the [deployment guide](GUIDE.md#deployment-configuration)
for additional configuration.

## Reference and support

- [Public API reference](API.md): all types, methods, options, errors, and lifetime contracts;
  the published TypeScript declarations also provide editor documentation.
- [Query language reference](QUERY_LANGUAGE.md): syntax, functions, search grammar, and restrictions.
- [Extended driver guide](GUIDE.md): additional examples and tuning options.
- [JavaScript examples](https://github.com/velr-ai/velr-javascript-examples) and
  [TypeScript examples](https://github.com/velr-ai/velr-typescript-examples).
- [Community questions](https://github.com/velr-ai/velr/discussions) and
  [bug reports or feature requests](https://github.com/velr-ai/velr/issues).

## License

The binding source is [MIT licensed](LICENSE). The bundled native runtime is
licensed separately under [LICENSE.runtime](LICENSE.runtime), which permits use
and redistribution of unmodified binaries under its terms.
