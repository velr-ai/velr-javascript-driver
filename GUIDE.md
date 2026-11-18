# JavaScript and TypeScript guide

Task guides for the synchronous and worker APIs. Start with the [README](README.md),
use the [API reference](API.md) for method contracts, and see the
[query language reference](QUERY_LANGUAGE.md) for supported Cypher syntax.

Each TypeScript example below is a complete module with imports, setup, and
cleanup. Run examples separately. `using` closes synchronous handles when their
scope ends; worker examples explicitly await cleanup. See
[TypeScript setup](#running-the-typescript-examples) before running them.

## Query parameter binding

Use `$name` in Cypher and omit `$` from `params` keys. Bound values are data,
not query text. Parameters accept `null`, booleans, signed 64-bit integers,
finite numbers, strings, nested arrays, and objects with string keys. Integer
`number` values must be safe integers; use `bigint` outside that range.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
db.run("UNWIND $people AS person CREATE (:Person {name:person.name, age:person.age})", {
  params: { people: [{ name: "Alice", age: 42 }, { name: "Bob", age: 17 }] },
});
const rows = db.query(
  "MATCH (p:Person) WHERE p.age >= $minimum RETURN p.name AS name ORDER BY name",
  { params: { minimum: 18 } },
);
console.log(rows); // [{ name: 'Alice' }]
```

Invalid parameter values throw `VelrTypeError`; an unbound parameter is a query
error. Bind values separately instead of interpolating them into Cypher strings.

## Query execution

| Task | API | Cleanup |
|---|---|---|
| Writes, DDL, or scripts whose rows are unnecessary | `run()` / `execute()` | Results close automatically |
| Collect exactly one table as objects | `query()` | Table closes automatically |
| Inspect one table and process its rows | `execOne()` | Close the table |
| Consume scripts with multiple tables | `exec()` | Close each table and the stream |

`execOne()` and `query()` reject zero or multiple result tables. Use unique
result aliases; Cypher rejects conflicting column names. `query<T>()` and
`toObjects<T>()` assert your expected TypeScript shape without validating it at
runtime.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
db.run("CREATE (:Person {name:$name, age:$age})", { params: { name: "Alice", age: 42 } });
using table = db.execOne(
  "MATCH (p:Person) RETURN p.name AS name, p.age AS age",
);
console.log(table.columnNames()); // ['name', 'age']
console.log(table.toObjects({ int64: "number" })); // [{ name: 'Alice', age: 42 }]
```

## Streaming multiple result tables

Consume each table before requesting the next. A table obtained through
`exec()` requires its stream to remain open. Closing a stream closes its
remaining tables; closing a connection or transaction closes its children.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
using stream = db.exec("RETURN $first AS value; RETURN $second AS value", {
  params: { first: "first", second: "second" },
});
for (const table of stream) {
  try {
    console.log(table.toObjects()); // First [{ value: 'first' }], then [{ value: 'second' }].
  } finally {
    table.close();
  }
}
```

### Worker threads

The direct API runs synchronously on the calling Node.js thread. Import
`VelrWorker` from `@velr-ai/velr/worker` to keep database execution off the event
loop. Its database methods return promises, and rows/streams support `for await`.
Await operations and finish one logical operation before starting unrelated work
on the same connection. Use separate connections for independent concurrent work.

```ts
import { VelrWorker } from "@velr-ai/velr/worker";

const db = await VelrWorker.open();
try {
  await db.run("CREATE (:Job {name:$name})", { params: { name: "background" } });
  const stream = await db.exec(
    "MATCH (j:Job) RETURN j.name AS name; RETURN 'complete' AS status",
  );
  try {
    for await (const table of stream) {
      try {
        console.log(await table.toObjects()); // [{ name: 'background' }], then [{ status: 'complete' }].
      } finally {
        await table.close();
      }
    }
  } finally {
    await stream.close();
  }
} finally {
  await db.close();
}
```

## Bounded result previews

`maxResultRows` caps rows independently for every result table. Zero preserves
column metadata without rows. Existing Cypher `LIMIT` clauses still apply. A
row cap does not prevent writes or limit execution time; combine it with a
deadline when needed.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
console.log(db.query("UNWIND range(1, 100) AS n RETURN n", {
  maxResultRows: 2,
})); // [{ n: 1 }, { n: 2 }]
using preview = db.execOne("RETURN 'Alice' AS name", { maxResultRows: 0 });
console.log(preview.columnNames(), preview.toObjects()); // ['name'] []
```

## Query cancellation and timeouts

Pass `timeoutMs` to a connection or transaction query. It is a finite,
non-negative number of milliseconds covering execution and subsequent table/row
fetching. Omit it for no deadline; `0` expires immediately. A worker deadline
also includes time waiting for that worker to process the request.

```ts
import { Velr, VelrError } from "@velr-ai/velr";

using db = Velr.open();
console.log(db.query("RETURN 1 AS n", { timeoutMs: 2_000 })); // [{ n: 1 }]
try {
  db.query("RETURN 1 AS n", { timeoutMs: 0 });
} catch (error) {
  if (error instanceof VelrError && error.stopReason === "deadline_exceeded") {
    console.log(error.stopReason); // deadline_exceeded
  } else {
    throw error;
  }
}
```

### Cancel worker queries

Pass an `AbortSignal` to a worker connection or transaction query. Call
`abort()` from your request or UI handler to cancel execution or stop further
fetching. A signal stays aborted; create a fresh controller for independent
operations. This example cancels after obtaining a table and before reading it:

```ts
import { VelrWorker } from "@velr-ai/velr/worker";

const db = await VelrWorker.open();
const controller = new AbortController();
try {
  const table = await db.execOne("UNWIND range(1, 100) AS n RETURN n", {
    signal: controller.signal,
    timeoutMs: 2_000,
  });
  try {
    controller.abort();
    await table.toObjects();
  } catch (error) {
    const reason = error && typeof error === "object" && "stopReason" in error
      ? error.stopReason : undefined;
    if (reason === "cancelled") console.log(reason); // cancelled
    else throw error;
  } finally {
    await table.close();
  }
} finally {
  await db.close();
}
```

A stop reports `"cancelled"` or `"deadline_exceeded"`. Fast operations can finish
before a stop request. Keep cancellation controls until fetching finishes and
handle errors during execution, stream advancement, and row reads. Close every
result handle on completion, failure, or early exit. If interruption ends an
explicit transaction, close its handle and start a new one. The direct API accepts deadlines;
user-initiated `AbortSignal` cancellation is provided by the worker API.

## Results, lifetimes, and threads

`Cell` represents null, boolean, signed 64-bit integer, double, text, or JSON.
`asJs()` returns normal JavaScript values. Integers become `number` when safe
and `bigint` otherwise. Select `int64: "bigint"` or `"string"` for a uniform
representation; `"number"` can lose precision.

Lists, maps, and graph entities are JSON cells. They are parsed with `JSON.parse`
by default, which can round large nested integers. `parseJson: false` retains
raw JSON text; `decodeText: false` returns text/JSON bytes instead of strings.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
const params = { id: 9007199254740993n, values: [9007199254740993n] };
const rows = db.query("RETURN $id AS id, $values AS values", { params });
console.log(typeof rows[0].id, String(rows[0].id)); // bigint 9007199254740993
const lossless = db.query("RETURN $id AS id, $values AS values", {
  params, int64: "string", parseJson: false,
});
console.log(lossless); // [{ id: '9007199254740993', values: '[9007199254740993]' }]
```

### Read rows and keep owned values

Tables from `execOne()` belong to their connection or transaction; tables from
`exec()` also require their stream. Keep those parents open while fetching.
Closing a parent invalidates its remaining result handles. JavaScript `Cell`
objects and collected values are copied and remain usable after parents close.

```ts
import { Velr, type Cell } from "@velr-ai/velr";

const retained: Cell[] = [];
{
  using db = Velr.open();
  db.run("CREATE (:Person {name:$name, age:$age})", { params: { name: "Alice", age: 42 } });
  using table = db.execOne("MATCH (p:Person) RETURN p.name AS name, p.age AS age");
  using rows = table.rows();
  for (const row of rows) retained.push(...row);
}
console.log(retained.map((cell) => cell.asJs())); // ['Alice', 42]
```

`forEachRow()` visits rows and `collect(mapper)` retains mapped results in memory.
Their direct-driver callbacks must be synchronous: returned promises are not
awaited. Throwing from a callback stops iteration, propagates that exception,
and closes the temporary cursor. Worker row visitors/mappers can be async.
`query()`, `toObjects()`, and `collect()` collect all rows; use a row cursor or
visitor for large results.

Use a connection and its handles on their owning thread. Do not transfer live
handles to another Node.js worker. `VelrWorker` exposes asynchronous access from
its calling thread; this does not make one connection a set of independent
sessions. Use separate connections for parallel work. Database/query failures
report `VelrError`; inspect `message`, `code`, and `stopReason`. Direct argument
and conversion failures use `VelrTypeError`. Direct closed/consumed handles and
local worker-handle guards use `VelrStateError`. A worker child invalidated by
its parent can still report `closed: false`, and its operations can reject with
an ordinary `Error`. Keep parents open while using children and handle operation
failures regardless of the local `closed` flag.

## Transactions and savepoints

Only one transaction can be active on a connection. A writable `beginTx()`
reserves the writer slot when it starts, even before a write. Keep transactions
short and prepare external inputs before opening one. For a read-only snapshot,
use `openReadonly()` and `beginTx()`.

Commit keeps the transaction's changes; rollback or closing an uncommitted
transaction discards them. Commit/rollback consumes the handle and closes its
results. Finish scoped savepoints and result handles before finalizing.

### Scoped savepoints

An anonymous savepoint is owned by its handle. `release()` keeps its changes
pending in the transaction; `rollback()` or closing an active handle rolls back
and releases it.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
using tx = db.beginTx();
tx.run("CREATE (:Person {name:$name})", { params: { name: "Alice" } });
{
  using savepoint = tx.savepoint();
  tx.run("CREATE (:Person {name:$name})", { params: { name: "Temporary" } });
  savepoint.rollback();
}
tx.commit();
console.log(db.query("MATCH (p:Person) RETURN p.name AS name")); // [{ name: 'Alice' }]
```

Direct `transaction()`, `withSavepoint()`, and `withSavepointNamed()` callbacks
must be synchronous. A successful callback commits/releases its scope, and a
thrown exception rolls it back, unless the callback already consumed that
scope. Returned promises are not awaited. The callback result is returned;
result handles cannot escape a completed transaction.

### Named savepoints

Named savepoints belong to the transaction. Names must be unique while active.
Closing a named JavaScript handle leaves that savepoint active. `rollbackTo()`
discards newer named savepoints and keeps its target; `releaseSavepoint()`
releases the newest active named savepoint. Calling `release()` or `rollback()`
on the named handle consumes that savepoint. Commit releases remaining named
savepoints and retains surviving changes.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
db.transaction((tx) => {
  tx.run("CREATE (:Person {name:$name})", { params: { name: "Alice" } });
  tx.savepointNamed("before_import").close();
  tx.run("CREATE (:Person {name:'Temporary'})");
  tx.savepointNamed("newer").close();
  tx.run("CREATE (:Person {name:'Also temporary'})");
  tx.rollbackTo("before_import");
  tx.withSavepoint(() => {
    tx.run("CREATE (:Person {name:$name})", { params: { name: "Grace" } });
  });
  tx.releaseSavepoint("before_import");
});
console.log(db.query("MATCH (p:Person) RETURN p.name AS name ORDER BY name"));
// [{ name: 'Alice' }, { name: 'Grace' }]
```

### Async worker transactions

Worker transaction/savepoint callbacks await returned promises. While an async
transaction callback is active, issue its queries through the supplied `tx`.
Do not start another transaction or unrelated operations on the same worker
connection, including through `Promise.all`. Await its operations in order.
Use another connection for unrelated work; an `await` does not release a
transaction's writer reservation.

```ts
import { VelrWorker } from "@velr-ai/velr/worker";

const db = await VelrWorker.open();
try {
  await db.transaction(async (tx) => {
    await tx.run("CREATE (:Job {name:$name})", { params: { name: "queued" } });
    await tx.withSavepoint(async (savepoint) => {
      await tx.run("CREATE (:Job {name:'temporary'})");
      await savepoint.rollback();
    });
  });
  console.log(await db.query("MATCH (j:Job) RETURN j.name AS name")); // [{ name: 'queued' }]
} finally {
  await db.close();
}
```

## SEARCH clause

`SEARCH` requires a Velr 0.2.62+ runtime with the corresponding search features
and a file-backed database. Use it inside `MATCH` or `OPTIONAL MATCH`, bind the
node/relationship in the pattern, and provide a mandatory candidate `LIMIT`.
`SCORE AS alias` exposes scores; use `ORDER BY alias DESC` for ranked output.
Driver row caps and search candidate limits apply independently.

Vector index names must be identifiers; backticks permit spaces. Fulltext index
names can also be string parameters. Query values can refer to earlier query
variables, but not to the element being searched. `LIMIT` accepts integers in
`0..2147483647`. Fulltext `SKIP`/`OFFSET` accepts `0..9223372036854775807` before
`LIMIT`; vector search does not support either. Pagination uses static
expressions or parameters, not variables bound by earlier rows.

### Candidate filters and score filters

Declare vector filter properties with index DDL `WITH [n.property]`. An inner
`WHERE` filters before nearest-neighbor selection. An enclosing `WHERE`, before
or after `SEARCH`, filters selected matches and can return fewer than the limit.
Inner filters allow `=`, `<`, `<=`, `>`, `>=`, `IN`, boolean/null property tests,
joined by `AND`. Each property permits one lower plus one upper bound, or one
equality, `IN`, or null test. Other predicates belong in the enclosing `WHERE`.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-filtered-search-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("UNWIND $chunks AS c CREATE (:Chunk {text:c.text, category:c.category, embedding:c.embedding})", {
    params: { chunks: [
      { text: "Graph guide", category: "docs", embedding: [1.0, 0.0] },
      { text: "Other material", category: "other", embedding: [0.0, 1.0] },
    ] },
  });
  db.run(`CREATE VECTOR INDEX filteredChunks FOR (n:Chunk) ON (n.embedding)
    WITH [n.category] OPTIONS {indexConfig:{dimensions:2, metric:'cosine'}}`);
  const rows = db.query(`MATCH (chunk)
    SEARCH chunk IN (VECTOR INDEX filteredChunks FOR $vector
      WHERE chunk.category = $category LIMIT $limit)
    SCORE AS score WHERE score >= $minimum
    RETURN chunk.text AS text, score ORDER BY score DESC`, {
    params: { vector: [1.0, 0.0], category: "docs", limit: 10, minimum: 0.5 },
  });
  console.log(rows); // [{ text: 'Graph guide', score: 1 }]
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Cosine SEARCH scores use `(1 + cosine) / 2`; Euclidean SEARCH scores use
`1 / (1 + squaredDistance)`, both in `0..1`. Dot scores are unbounded. Vector
`CALL` procedures retain raw cosine or negative squared Euclidean scores.
Fulltext scores use the same query-specific, unnormalized scale in both forms.

### Fulltext analyzers and pagination

Fulltext accepts `WITH ANALYZER` and inner `SKIP`/`OFFSET`; it has no inner
`WHERE`. An outer filter applies after the selected page. Analyzer names are
`standard` (default; aliases `standard-no-stop-words` and `default`), `keyword`,
`whitespace`, `simple`, and `english`. Analyzer expressions can refer to earlier
query variables.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-paged-search-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("UNWIND $titles AS title CREATE (:Paper {title:title})", {
    params: { titles: ["Graph databases", "Graph search", "Graph theory"] },
  });
  db.run("CREATE FULLTEXT INDEX paperText FOR (n:Paper) ON EACH [n.title]");
  const rows = db.query(`MATCH (paper)
    SEARCH paper IN (FULLTEXT INDEX $index FOR $text
      WITH ANALYZER $analyzer OFFSET $offset LIMIT $limit)
    SCORE AS relevance RETURN paper.title AS title, relevance ORDER BY relevance DESC, title`, {
    params: { index: "paperText", text: "graph", analyzer: "standard", offset: 1, limit: 2 },
  });
  console.log(rows.length); // 2
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

### Subqueries and relationship indexes

Search patterns contain exactly one node or one relationship hop. Only the
searched element can be named or constrained. Multi-pattern matches, path
bindings, shortest paths, and variable-length hops are unsupported in a search
pattern. For a relationship index, use `MATCH ()-[r]->()` with `SEARCH r`.
Null queries and zero limits return no matches; `OPTIONAL MATCH` preserves an
input row with null entity/score values.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-search-subqueries-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("CREATE (:Paper {title:'Graph databases'})-[:CITES {note:'graph reference'}]->(:Paper {title:'Other topic'})");
  db.run("CREATE FULLTEXT INDEX paperText FOR (n:Paper) ON EACH [n.title]");
  db.run("CREATE FULLTEXT INDEX citationText FOR ()-[r:CITES]-() ON EACH [r.note]");
  console.log(db.query(`UNWIND $terms AS term RETURN term, COUNT {
    MATCH (paper) SEARCH paper IN (FULLTEXT INDEX paperText FOR term LIMIT 10)
  } AS matches ORDER BY term`, { params: { terms: ["graph", "missing"] } }));
  // [{ term: 'graph', matches: 1 }, { term: 'missing', matches: 0 }]
  console.log(db.query(`MATCH ()-[r]->()
    SEARCH r IN (FULLTEXT INDEX citationText FOR $text LIMIT 1)
    RETURN r.note AS note`, { params: { text: "graph" } })); // [{ note: 'graph reference' }]
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

`EXISTS { ... }` also supports SEARCH. `COUNT { OPTIONAL MATCH ... }` counts
preserved optional rows, including a null row for an unmatched input.

## Fulltext search

Create fulltext indexes over text properties in a file-backed database. Writes
keep them up to date. Search text supports terms, quoted phrases, property
scoping (`title:graph`), boolean grouping, required/excluded terms, phrase slop,
term/phrase prefixes, and boosts. Adjacent terms use `OR`. A field scope applies
to the next term or phrase only. `?` wildcards and term-level fuzzy matching are
unsupported. See the [fulltext grammar](QUERY_LANGUAGE.md#fulltext-search).

The `CALL` alternatives remain supported for nodes and relationships. Fulltext
procedures default to at most 1,000 matches; pass a third options argument to
change that cap. `WHERE` after `YIELD` filters the selected candidates. Scores
rank relevance within one query; do not compare them across queries.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-fulltext-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("CREATE (:Paper {title:$title, abstract:$abstract})", {
    params: { title: "Graph databases", abstract: "Connected data and vector search" },
  });
  db.run("CREATE FULLTEXT INDEX paperText FOR (n:Paper) ON EACH [n.title, n.abstract]");
  const rows = db.query(`CALL db.index.fulltext.queryNodes('paperText', $text, {limit: 10})
    YIELD node, score RETURN node.title AS title, score ORDER BY score DESC`, {
    params: { text: "title:graph AND abstract:vector" },
  });
  console.log(rows.map((row) => row.title)); // ['Graph databases']
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Writable opens repair missing or corrupt fulltext index data. Read-only opens
never repair indexes.

## Vector search and embeddings

### Stored-vector indexes and score scales

Store precomputed embeddings as numeric vector/list properties and use
`CREATE VECTOR INDEX ... ON (n.embedding)`. Every vector must match the declared
dimensions. Cosine queries require a nonzero component. Use
`vector.similarity.cosine(left, right)` for exact scoring without an index;
it returns a score in `0..1`, including `0.5` for orthogonal vectors.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-vector-scores-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("CREATE (:Chunk {text:$text, embedding:$embedding})", {
    params: { text: "Connected data", embedding: [1.0, 0.0] },
  });
  db.run("CREATE VECTOR INDEX chunkEmbedding FOR (n:Chunk) ON (n.embedding) OPTIONS {indexConfig:{dimensions:2, metric:'cosine'}}");
  const params = { vector: [0.0, 1.0], stored: [1.0, 0.0], limit: 1 };
  const search = db.query(`MATCH (node)
    SEARCH node IN (VECTOR INDEX chunkEmbedding FOR $vector LIMIT $limit)
    SCORE AS score RETURN score`, { params });
  const procedure = db.query(`CALL db.index.vector.queryNodes('chunkEmbedding', $limit, $vector)
    YIELD score RETURN score`, { params });
  const exact = db.query("RETURN vector.similarity.cosine($stored, $vector) AS score", { params });
  console.log(search[0].score, procedure[0].score, exact[0].score); // 0.5 0 0.5
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

For stored-vector indexes, searches inside a transaction see its own writes.
For an embedder-backed index with pending changes, commit or roll back before
searching that index. A neighbor count of zero returns no candidates. The
`queryRelationships` procedure supports relationship indexes.

### Text embeddings

For text-to-vector indexing, register a connection-owned callback and name it
in `CREATE VECTOR INDEX ... ON EACH [...]`. Return one finite vector per input,
in input order and with the requested dimensions. Selected property fields
arrive in their declared order; a text query arrives as one unnamed string
field. `input.purpose` distinguishes index entities from queries, and fields
provide `value`, `valueType`, `valueJson`, and a display string.

The callback below is a deterministic demonstration; replace it with your
embedding model. It seeds data, creates the index, runs a bound text query,
and repeats the query after reopening and registering the callback again:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr, type VectorEmbedder } from "@velr-ai/velr";

const embed: VectorEmbedder = (inputs) => inputs.map((input) => {
  const text = input.fields.map((field) => field.display).join(" ").toLowerCase();
  return new Float32Array([text.includes("graph") ? 1 : 0, text.includes("vector") ? 1 : 0, 1]);
});
const query = `CALL db.index.vector.queryNodes('paperEmbedding', $limit, $text)
  YIELD node, score RETURN node.title AS title, score ORDER BY score DESC`;
const params = { text: "graph", limit: 1 };
const directory = mkdtempSync(join(tmpdir(), "velr-text-embeddings-"));
try {
  const path = join(directory, "graph.db");
  {
    using db = Velr.open(path);
    db.registerVectorEmbedder("demo", embed);
    db.run("UNWIND $papers AS paper CREATE (:Paper {title:paper.title, abstract:paper.abstract})", {
      params: { papers: [
        { title: "Graph databases", abstract: "Connected data" },
        { title: "Semantic vectors", abstract: "Vector retrieval" },
      ] },
    });
    db.run(`CREATE VECTOR INDEX paperEmbedding FOR (n:Paper) ON EACH [n.title, n.abstract]
      OPTIONS {indexConfig:{dimensions:3, metric:'cosine', embedder:'demo'}}`);
    console.log(db.query(query, { params }).map((row) => row.title)); // ['Graph databases']
  }
  {
    using reopened = Velr.open(path);
    reopened.registerVectorEmbedder("demo", embed);
    console.log(reopened.query(query, { params }).map((row) => row.title)); // ['Graph databases']
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Callback registration lasts until replacement or connection close. Register it
on each connection before operations that need generated embeddings, including
text queries, writes to indexed source properties, and recovery that needs the
model. Numeric query vectors can be supplied without invoking an embedder.
Writable connections repair index data according to the index configuration;
read-only opens never repair it.

Direct callbacks must be synchronous. Do not call the same connection from its
embedder. Worker embedders can return promises but run on the calling thread;
offload CPU-intensive model work to your own worker or service.

### Async worker embedders

Use the worker API when obtaining embeddings requires asynchronous work. This
complete example uses an async demonstration callback:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VelrWorker } from "@velr-ai/velr/worker";

const directory = mkdtempSync(join(tmpdir(), "velr-worker-embeddings-"));
try {
  const db = await VelrWorker.open(join(directory, "graph.db"));
  try {
    await db.registerVectorEmbedder("demo", async (inputs) => inputs.map((input) => {
      const text = input.fields.map((field) => field.display).join(" ").toLowerCase();
      return new Float32Array([text.includes("graph") ? 1 : 0, 1]);
    }));
    await db.run("CREATE (:Paper {title:$title})", { params: { title: "Graph databases" } });
    await db.run(`CREATE VECTOR INDEX paperEmbedding FOR (n:Paper) ON EACH [n.title]
      OPTIONS {indexConfig:{dimensions:2, metric:'cosine', embedder:'demo'}}`);
    const rows = await db.query(`CALL db.index.vector.queryNodes('paperEmbedding', $limit, $text)
      YIELD node, score RETURN node.title AS title, score ORDER BY score DESC`, {
      params: { text: "graph", limit: 1 },
    });
    console.log(rows.map((row) => row.title)); // ['Graph databases']
  } finally {
    await db.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Do not call the same `VelrWorker` from its embedder. Use the connection's
`registerVectorEmbedder()` before operations requiring embeddings after a reopen.

### Index configuration

Pass options in `CREATE VECTOR INDEX ... OPTIONS {indexConfig:{...}}`.
The following option descriptions apply to direct and worker connections:

| Option | Accepted aliases | Contract |
|---|---|---|
| `vector.dimensions` | `dimensions` | Required vector width for stored values, callback outputs, and query vectors. |
| `vector.similarity_function` | `metric`, `similarity_function` | `cosine` (default), `l2`/`euclidean`, or `dot`/`inner_product`/`max_inner_product`. |
| `embedder` | `velr.embedder` | Callback name for `ON EACH [...]`; omit for stored-vector indexes. |
| `embedder_fingerprint` | `embedderFingerprint`, `velr.embedder_fingerprint` | Application model/version metadata; does not select or invoke a model. |
| `cache_policy` | `cachePolicy` | `required` retains generated embeddings for recovery; `best_effort` tolerates failures to retain them; `none` requires recomputation. Defaults: `required` with an embedder, `none` without. Stored-vector indexes require `none`. |
| `vector.hnsw.m` | — | Integer `1..512`. Higher values can improve recall with more memory, disk use, and build time. |
| `vector.hnsw.ef_construction` | — | Integer `1..3200`. Higher values can improve index quality with slower builds. |
| `vector.hnsw.ef_search` | — | Integer `1..3200`, default `64`. Higher values can improve recall with slower queries. |

Quote dotted option keys with backticks in Cypher. `WITH [n.property]` declares
properties available to inner vector SEARCH filters.

## Arrow IPC

`toArrowIpc()` exports owned IPC file/Feather v2 bytes without an Arrow JavaScript
dependency. Bind those bytes as queryable input with `bindArrowIpc()` and `BIND()`.
The bytes outlive the result table; binding borrows them only during its call.
IPC streams are unsupported.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
let ipc: Buffer;
{
  using table = db.execOne("UNWIND $names AS name RETURN name ORDER BY name", {
    params: { names: ["Grace", "Ada"] },
  });
  ipc = table.toArrowIpc();
}
db.bindArrowIpc("people", ipc);
console.log(db.query("UNWIND BIND('people') AS row RETURN row.name AS name ORDER BY name"));
// [{ name: 'Ada' }, { name: 'Grace' }]
```

### Convert to an Apache Arrow table

`toArrowTable()` requires the optional `apache-arrow` package (15 or newer).
Keep its table and parents open until the promise resolves. The converted Arrow
table remains usable afterward. Its public return type is `unknown`; after
installing Arrow, use its `Table` type when you need typed access:

```ts
import type { Table as ArrowTable } from "apache-arrow";
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
using table = db.execOne("RETURN $name AS name, $age AS age", {
  params: { name: "Alice", age: 42 },
});
const arrow = await table.toArrowTable() as ArrowTable;
console.log(arrow.numRows, arrow.numCols); // 1 2
```

Export infers a schema for each result. Numeric columns can be integers or
floats; incompatible mixed kinds become strings. Lists, maps, nodes,
relationships, and paths become JSON UTF-8 strings rather than nested Arrow
arrays. Nulls remain null; empty/all-null columns use UTF-8. Inspect the exported
schema before choosing application types. Export can materialize the whole
result and use memory proportional to its size. Worker tables offer the same
IPC/Arrow conversion methods asynchronously.

## Introspection

`SHOW INDEXES` lists range, fulltext, and vector indexes. Its fields are `name`,
`state`, `type`, `entityType`, `labelsOrTypes`, and `properties`. Catalog procedures
list graph names, including index declarations and registered unused property
keys. `SHOW CURRENT GRAPH SHAPE` describes stored data, rather than declaring a
schema. Migrate supported older databases before graph queries or introspection.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-inspection-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("CREATE (:Person {name:'Alice', age:42})-[:KNOWS {weight:0.5}]->(:Person {name:'Grace', age:37})");
  db.run("CREATE INDEX personName FOR (p:Person) ON (p.name)");
  console.log(db.query("SHOW INDEXES YIELD name, type RETURN name, type ORDER BY name"));
  // [{ name: 'personName', type: 'RANGE' }]
  console.log(db.query("CALL db.labels() YIELD label RETURN label ORDER BY label")); // [{ label: 'Person' }]
  console.log(db.query("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType"));
  // [{ relationshipType: 'KNOWS' }]
  console.log(db.query("CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey"));
  // [{ propertyKey: 'age' }, { propertyKey: 'name' }, { propertyKey: 'weight' }]
  const properties = db.query(`SHOW CURRENT GRAPH SHAPE
    YIELD element_kind, element_name, property_name, observed_type, owner_count
    WHERE element_kind = 'node_property'
    RETURN property_name ORDER BY property_name`);
  console.log(properties.map((row) => row.property_name)); // ['age', 'name']
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Use `YIELD`, `WHERE`, and `RETURN` to filter/project these results. Plain graph
shape returns `element_kind`, `element_name`, `property_name`, `observed_type`,
`owner_count`, `present_count`, and `missing_count`; `YIELD *` exposes additional
fields including `surface`, `source_label`, `target_label`, `required`,
`storage_class`, and `tag`.

## Explain plans

`explain()` builds an `ExplainTrace` without executing a query.
`explainAnalyze()` executes it, including writes. The trace supports indexed
access, owned `snapshot()` data, and `toCompactString()`. Diagnostic text can
change between versions. These APIs also exist on transactions and workers.
Use an explicit transaction and rollback when analyzed writes should be discarded.

```ts
import { Velr } from "@velr-ai/velr";

using db = Velr.open();
db.run("CREATE (:Person {name:'Alice'})");
{
  using trace = db.explain("MATCH (p:Person) RETURN p.name AS name");
  console.log(trace.planCount(), trace.snapshot().length, typeof trace.toCompactString()); // 1 1 string
}
{
  using tx = db.beginTx();
  {
    using trace = tx.explainAnalyze("CREATE (:Person {name:'Temporary'})");
    console.log(trace.planCount()); // 1
  }
  tx.rollback();
}
console.log(db.query("MATCH (p:Person) RETURN count(p) AS count")); // [{ count: 1 }]
```

## Opening an existing database read-only

`openReadonly()` requires an existing supported database. It never creates,
initializes, migrates, or repairs a database. Migrate supported older files on a
writable connection first, then reopen read-only connections. This example
creates a file, closes the writer, and opens it for reads:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-readonly-"));
try {
  const path = join(directory, "graph.db");
  {
    using writer = Velr.open(path);
    writer.run("CREATE (:Person {name:$name})", { params: { name: "Alice" } });
  }
  using reader = Velr.openReadonly(path);
  console.log(reader.query("MATCH (p:Person) RETURN p.name AS name")); // [{ name: 'Alice' }]
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

## Database creation options

`Velr.create(path, options)` requires a fresh file path; it fails if the file
already exists. Omit the path or pass `null` or `":memory:"` for in-memory
creation. Choose zero or one nonempty, case-sensitive relationship property
name without NUL bytes in `inlineEdgeProperties`. The selection applies to all
relationship types, persists on reopen, and cannot be changed afterward.
Normal Cypher reads/writes preserve access to all supported values.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-create-"));
try {
  const path = join(directory, "events.db");
  {
    using db = Velr.create(path, { inlineEdgeProperties: ["timestamp"] });
    db.run("CREATE ()-[:EVENT {timestamp:$time}]->()", { params: { time: 1700000000 } });
  }
  using reader = Velr.openReadonly(path);
  console.log(reader.inlineEdgeProperties()); // ['timestamp']
  console.log(reader.query("MATCH ()-[r:EVENT]->() RETURN r.timestamp AS timestamp"));
  // [{ timestamp: 1700000000 }]
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

`VelrWorker.create()` accepts the same creation options and returns a promise;
its `inlineEdgeProperties()` method is also async.

## Schema migration

Opening a database never migrates it. The 0.2.62 runtime creates schema version
11 and supports migration from schema versions 3 through 9. Migrate supported
older formats on a writable connection before graph queries or transactions.
Reopen read-only connections afterward. Databases created before Velr 0.2.14
must be recreated by importing source data.

The following complete example uses a fresh database, so its report is
`already_current`. In application maintenance code, use the existing database
path and check `needsMigration()` before deciding to migrate:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-migrate-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  console.log(db.schemaVersion(), db.currentSchemaVersion(), db.needsMigration()); // 11 11 false
  const report = db.migrate();
  console.log(report.status, report.fromVersion, report.toVersion); // already_current 11 11
  console.log(db.query("MIGRATE DATABASE").map((row) => row.status)); // ['already_current']
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

Migration requires a writable connection outside an active transaction. The
`MIGRATE DATABASE` command is the equivalent query API for scripts/tools.

## Maintenance

After large deletes or pruning, call `vacuum()` to compact a file-backed
database. It requires a writable, current-schema connection outside a
transaction. `VACUUM DATABASE` is the equivalent command.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Velr } from "@velr-ai/velr";

const directory = mkdtempSync(join(tmpdir(), "velr-vacuum-"));
try {
  using db = Velr.open(join(directory, "graph.db"));
  db.run("CREATE (:Person {name:'Alice'}), (:Expired {name:'temporary'})");
  db.run("MATCH (n:Expired) DETACH DELETE n");
  db.vacuum();
  console.log(db.query("MATCH (n) RETURN count(n) AS count")); // [{ count: 1 }]
} finally {
  rmSync(directory, { recursive: true, force: true });
}
```

## Deployment configuration

Install npm optional dependencies so the runtime package for your platform is
available. For a custom compatible runtime, set `VELR_NATIVE_LIBRARY` to its
absolute library path before the first connection opens; `VELR_LIB` is an alias.
The direct and worker APIs must load the same runtime. Missing runtime features
raise `VelrError`. `VELR_CACHE_DIR` is not a JS driver setting. Browsers are unsupported.

## Running the TypeScript examples

Use Node.js 22 or newer and a TypeScript compiler compatible with your installed
Node.js type declarations. The `using` syntax requires TypeScript 5.2 or newer
and `ESNext.Disposable` in `compilerOptions.lib`. The complete configuration
below includes `DOM` for the Web Stream declarations used by optional Apache
Arrow types. Node.js remains the runtime for these examples. Byte-only Arrow
IPC methods do not require the Apache Arrow package.

A project using `.mts` examples can use this configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "ESNext.Disposable", "DOM"],
    "types": ["node"],
    "strict": true,
    "outDir": "dist"
  },
  "include": ["*.mts"]
}
```

Install `@velr-ai/velr`, `typescript`, and `@types/node` in your application;
install `apache-arrow` 15 or newer for the optional Arrow-table conversion.
Save a TypeScript block as an `.mts` file, compile it with `npx tsc`, and run the
emitted `.mjs` with Node.js. Plain JavaScript can use `try` / `finally` and
`close()` as shown in the README. Worker cleanup must be awaited.
