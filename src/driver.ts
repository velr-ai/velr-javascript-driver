import {
  buildQueryOptions,
  CellKind,
  check,
  checkNoErr,
  cStringToString,
  decodeCellAt,
  ensureNoNul,
  freeQueryParams,
  getBindings,
  isNullPointer,
  makeStrView,
  optStrViewToString,
  outInt,
  outPtr,
  pointerToBuffer,
  registerVectorCallback,
  sizeToNumber,
  strViewToString,
  unregisterVectorCallback,
  type ExplainPlanMetaRaw,
  type ExplainStatementMetaRaw,
  type ExplainStepMetaRaw,
  type MigrationReportRaw,
  type NativePointer,
  type QueryOptionsRaw
} from "./ffi/koffi.js";
import { VelrError, VelrStateError, VelrTypeError } from "./errors.js";
import type {
  CellAsJsOptions,
  CellType,
  CellValue,
  ExplainPlan,
  ExplainPlanMeta,
  ExplainStatement,
  ExplainStatementMeta,
  ExplainStep,
  ExplainStepMeta,
  MigrationReport,
  QueryOptions,
  VectorEmbedder
} from "./types.js";

interface ChildHandle {
  close(): void;
}

interface ParentHandle {
  registerChild(child: ChildHandle): void;
  unregisterChild(child: ChildHandle): void;
}

interface NamedSavepointEntry {
  name: string;
  ptr: NativePointer;
  active: boolean;
}

interface NamedSavepointController {
  readonly name: string;
  isActive(): boolean;
  release(): void;
  rollback(): void;
}

type RowMapper<T> = (row: readonly Cell[], index: number) => T;

function closeChildren(children: Set<ChildHandle>): void {
  const snapshot = [...children].reverse();
  children.clear();
  for (const child of snapshot) {
    child.close();
  }
}

function requireOpen(ptr: NativePointer, what: string): NativePointer {
  if (isNullPointer(ptr)) throw new VelrStateError(`${what} is closed`);
  return ptr;
}

function arrowIpcBuffer(bytes: Buffer | Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array)) {
    throw new VelrTypeError("Arrow IPC bytes must be a Buffer or Uint8Array");
  }
  if (bytes.byteLength === 0) {
    throw new VelrTypeError("Arrow IPC bytes cannot be empty");
  }
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function withQueryOptions<T>(
  options: QueryOptions | undefined,
  run: (raw: QueryOptionsRaw | null) => T
): T {
  const { raw, paramsHandle } = buildQueryOptions(options?.maxResultRows, options?.params);
  try {
    return run(raw);
  } finally {
    freeQueryParams(paramsHandle);
  }
}

/**
 * One value returned by a Velr result table.
 *
 * Use `asJs()` for normal application code, or inspect `type`, `i64`, `f64`,
 * and `data` when a lossless representation is required.
 */
export class Cell {
  /** Runtime cell kind. */
  readonly type: CellType;

  /** Integer payload for `bool` and `int64` cells. */
  readonly i64: bigint;

  /** Floating-point payload for `double` cells. */
  readonly f64: number;

  /** Raw UTF-8 bytes for `text` and `json` cells. */
  readonly data: Buffer;

  /** Create a cell value. Most users receive cells from query results. */
  constructor(type: CellType, i64 = 0n, f64 = 0, data: Buffer = Buffer.alloc(0)) {
    this.type = type;
    this.i64 = i64;
    this.f64 = f64;
    this.data = data;
  }

  /**
   * Convert this cell to an idiomatic JavaScript value.
   *
   * By default, JSON cells are parsed, text cells are decoded as UTF-8, and
   * int64 cells become `number` only when the value is safe.
   */
  asJs(options: CellAsJsOptions = {}): CellValue {
    const int64 = options.int64 ?? "number-or-bigint";
    const parseJson = options.parseJson ?? true;
    const decodeText = options.decodeText ?? true;

    switch (this.type) {
      case "null":
        return null;
      case "bool":
        return this.i64 !== 0n;
      case "int64":
        if (int64 === "bigint") return this.i64;
        if (int64 === "string") return this.i64.toString();
        if (int64 === "number") return Number(this.i64);
        return this.i64 <= BigInt(Number.MAX_SAFE_INTEGER) &&
          this.i64 >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(this.i64)
          : this.i64;
      case "double":
        return this.f64;
      case "text":
        return decodeText ? this.data.toString("utf8") : Buffer.from(this.data);
      case "json":
        if (!decodeText) return Buffer.from(this.data);
        return parseJson
          ? (JSON.parse(this.data.toString("utf8")) as CellValue)
          : this.data.toString("utf8");
    }
  }

  /**
   * Decode a `text` or `json` cell as UTF-8.
   *
   * Throws `VelrTypeError` for numeric, boolean, or null cells.
   */
  asString(): string {
    if (this.type !== "text" && this.type !== "json") {
      throw new VelrTypeError(`cannot convert ${this.type} cell to string`);
    }
    return this.data.toString("utf8");
  }

  /** Return a copy of the raw byte payload for this cell. */
  asBuffer(): Buffer {
    return Buffer.from(this.data);
  }

  /** @internal Convert a raw C ABI cell into a JavaScript `Cell`. */
  static fromRaw(raw: any): Cell {
    const kind = Number(raw.ty);
    switch (kind) {
      case CellKind.Null:
        return new Cell("null");
      case CellKind.Bool:
        return new Cell("bool", BigInt(raw.i64_ ?? 0));
      case CellKind.Int64:
        return new Cell("int64", BigInt(raw.i64_ ?? 0));
      case CellKind.Double:
        return new Cell("double", 0n, Number(raw.f64_ ?? 0));
      case CellKind.Text:
        return new Cell("text", 0n, 0, pointerToBuffer(raw.ptr, raw.len, "text cell"));
      case CellKind.Json:
        return new Cell("json", 0n, 0, pointerToBuffer(raw.ptr, raw.len, "json cell"));
      default:
        throw new VelrError(`unknown Velr cell type ${kind}`);
    }
  }
}

/**
 * Synchronous Velr database connection.
 *
 * Import from the main package:
 *
 * ```ts
 * import { Velr } from "@velr-ai/velr";
 * ```
 *
 * The direct driver calls the native library on the current Node.js thread. Use
 * `VelrWorker` from `@velr-ai/velr/worker` when query execution should run in a worker
 * thread.
 */
export class Velr implements ParentHandle {
  #ptr: NativePointer;
  #children = new Set<ChildHandle>();
  #vectorCallbacks = new Map<string, NativePointer>();

  private constructor(ptr: NativePointer) {
    this.#ptr = ptr;
  }

  /**
   * Open a database for reading and writing.
   *
   * Pass `null` or omit `path` for an in-memory database. Sidecar-backed
   * features such as fulltext and vector indexes require a file-backed
   * database.
   */
  static open(path: string | null = null): Velr {
    if (path != null) ensureNoNul(path, "database path");
    const { lib } = getBindings();
    const outDb = outPtr();
    const outErrValue = outPtr();
    check(lib.velr_open(path, outDb, outErrValue), outErrValue);
    if (isNullPointer(outDb[0])) throw new VelrError("velr_open returned null database");
    return new Velr(outDb[0]);
  }

  /** Open an existing database in read-only mode. */
  static openReadonly(path: string): Velr {
    ensureNoNul(path, "database path");
    const { lib } = getBindings();
    if (!lib.velr_open_existing_readonly) {
      throw new VelrError("loaded Velr runtime does not expose velr_open_existing_readonly");
    }
    const outDb = outPtr();
    const outErrValue = outPtr();
    check(lib.velr_open_existing_readonly(path, outDb, outErrValue), outErrValue);
    if (isNullPointer(outDb[0])) {
      throw new VelrError("velr_open_existing_readonly returned null database");
    }
    return new Velr(outDb[0]);
  }

  /** Whether this connection has already been closed. */
  get closed(): boolean {
    return isNullPointer(this.#ptr);
  }

  /** @internal Register a child handle owned by this connection. */
  registerChild(child: ChildHandle): void {
    this.#children.add(child);
  }

  /** @internal Unregister a child handle owned by this connection. */
  unregisterChild(child: ChildHandle): void {
    this.#children.delete(child);
  }

  /** Return the schema version stored in the opened database. */
  schemaVersion(): number {
    const out = outInt();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_schema_version(this.ptr(), out, outErrValue), outErrValue);
    return out[0];
  }

  /** Return the schema version expected by the loaded Velr runtime. */
  currentSchemaVersion(): number {
    const out = outInt();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_current_schema_version(this.ptr(), out, outErrValue), outErrValue);
    return out[0];
  }

  /** Return `true` when the database schema is older than the runtime schema. */
  needsMigration(): boolean {
    const out = outInt();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_needs_migration(this.ptr(), out, outErrValue), outErrValue);
    return out[0] !== 0;
  }

  /** Run any pending Velr schema migrations for this database. */
  migrate(): MigrationReport {
    const report: MigrationReportRaw = {};
    const outErrValue = outPtr();
    const { lib } = getBindings();
    check(lib.velr_migrate(this.ptr(), report, outErrValue), outErrValue);
    try {
      const stepsText = cStringToString(report.steps ?? null, "migration steps");
      return {
        fromVersion: report.from_version ?? 0,
        toVersion: report.to_version ?? 0,
        status: report.status === 1 ? "migrated" : "already_current",
        steps: stepsText.length === 0 ? [] : stepsText.split(",").filter(Boolean)
      };
    } finally {
      lib.velr_migration_report_clear(report);
    }
  }

  /**
   * Register or replace a synchronous vector embedder.
   *
   * The `name` must match the embedder referenced by vector indexes or vector
   * search queries. The callback is invoked synchronously by the native runtime,
   * so it must not perform asynchronous work.
   */
  registerVectorEmbedder(name: string, embedder: VectorEmbedder): void {
    if (typeof name !== "string") throw new VelrTypeError("vector embedder name must be a string");
    if (name.length === 0) throw new VelrTypeError("vector embedder name cannot be empty");
    ensureNoNul(name, "vector embedder name");
    if (typeof embedder !== "function") throw new VelrTypeError("vector embedder must be a function");

    const { lib } = getBindings();
    if (!lib.velr_register_vector_embedder) {
      throw new VelrError("loaded Velr runtime does not expose velr_register_vector_embedder");
    }

    const callback = registerVectorCallback(embedder);
    const oldCallback = this.#vectorCallbacks.get(name);
    const outErrValue = outPtr();
    const nameView = makeStrView(name);
    try {
      check(
        lib.velr_register_vector_embedder(this.ptr(), nameView.view, callback, null, null, outErrValue),
        outErrValue
      );
      if (oldCallback) unregisterVectorCallback(oldCallback);
      this.#vectorCallbacks.set(name, callback);
    } catch (err) {
      unregisterVectorCallback(callback);
      throw err;
    }
  }

  /**
   * Bind an Arrow IPC file/Feather v2 payload as a logical table.
   *
   * The bytes are borrowed only for the duration of the call. IPC streams are
   * not accepted by the current ABI.
   */
  bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): void {
    ensureNoNul(logical, "logical table name");
    const buffer = arrowIpcBuffer(ipcBytes);
    const { lib } = getBindings();
    if (!lib.velr_bind_arrow_ipc) {
      throw new VelrError("loaded Velr runtime does not expose Arrow IPC bind");
    }
    const outErrValue = outPtr();
    check(
      lib.velr_bind_arrow_ipc(this.ptr(), logical, buffer, buffer.byteLength, outErrValue),
      outErrValue
    );
  }

  /**
   * Execute Cypher and return a stream of result tables.
   *
   * Close the returned stream when finished, or use `run()`/`query()` for common
   * one-shot workflows.
   */
  exec(cypher: string, options?: QueryOptions): Stream {
    ensureNoNul(cypher, "openCypher");
    const { lib } = getBindings();
    return withQueryOptions(options, (raw) => {
      const outStream = outPtr();
      const outErrValue = outPtr();
      if (raw) {
        if (!lib.velr_exec_start_with_options) {
          throw new VelrError("loaded Velr runtime does not expose velr_exec_start_with_options");
        }
        check(
          lib.velr_exec_start_with_options(this.ptr(), cypher, raw, outStream, outErrValue),
          outErrValue
        );
      } else {
        check(lib.velr_exec_start(this.ptr(), cypher, outStream, outErrValue), outErrValue);
      }
      if (isNullPointer(outStream[0])) throw new VelrError("velr_exec_start returned null stream");
      const stream = new Stream(outStream[0], this);
      this.registerChild(stream);
      return stream;
    });
  }

  /**
   * Execute Cypher and return exactly one result table.
   *
   * Throws when the statement produces no tables or multiple tables.
   */
  execOne(cypher: string, options?: QueryOptions): Table {
    ensureNoNul(cypher, "openCypher");
    const { lib } = getBindings();
    return withQueryOptions(options, (raw) => {
      const outTable = outPtr();
      const outErrValue = outPtr();
      if (raw) {
        if (!lib.velr_exec_one_with_options) {
          throw new VelrError("loaded Velr runtime does not expose velr_exec_one_with_options");
        }
        check(
          lib.velr_exec_one_with_options(this.ptr(), cypher, raw, outTable, outErrValue),
          outErrValue
        );
      } else {
        check(lib.velr_exec_one(this.ptr(), cypher, outTable, outErrValue), outErrValue);
      }
      if (isNullPointer(outTable[0])) throw new VelrError("velr_exec_one returned null table");
      const table = new Table(outTable[0], this);
      this.registerChild(table);
      return table;
    });
  }

  /**
   * Execute Cypher and discard all result tables.
   *
   * This is the preferred helper for DDL and writes where no rows are needed.
   */
  run(cypher: string, options?: QueryOptions): void {
    const stream = this.exec(cypher, options);
    try {
      for (;;) {
        const table = stream.nextTable();
        if (!table) break;
        table.close();
      }
    } finally {
      stream.close();
    }
  }

  /** Alias for `run()`. */
  execute(cypher: string, options?: QueryOptions): void {
    this.run(cypher, options);
  }

  /**
   * Run a function inside a transaction.
   *
   * The transaction commits when `fn` returns successfully and rolls back when
   * `fn` throws, unless the callback has already committed or rolled back.
   */
  transaction<T>(fn: (tx: VelrTx) => T): T {
    const tx = this.beginTx();
    let committed = false;
    try {
      const result = fn(tx);
      if (!tx.closed) tx.commit();
      committed = true;
      return result;
    } finally {
      if (!committed && !tx.closed) {
        tx.rollback();
      }
    }
  }

  /**
   * Execute Cypher and convert the single result table into objects.
   *
   * Column names become object keys and cell conversion follows `Cell.asJs()`.
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): T[] {
    const table = this.execOne(cypher, options);
    try {
      return table.toObjects<T>(options);
    } finally {
      table.close();
    }
  }

  /** Build an explain trace without executing the query. */
  explain(cypher: string): ExplainTrace {
    ensureNoNul(cypher, "openCypher");
    const outTrace = outPtr();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_explain(this.ptr(), cypher, outTrace, outErrValue), outErrValue);
    return this.adoptTrace(outTrace[0], "velr_explain");
  }

  /** Execute the query and return an analyzed explain trace. */
  explainAnalyze(cypher: string): ExplainTrace {
    ensureNoNul(cypher, "openCypher");
    const outTrace = outPtr();
    const outErrValue = outPtr();
    check(
      getBindings().lib.velr_explain_analyze(this.ptr(), cypher, outTrace, outErrValue),
      outErrValue
    );
    return this.adoptTrace(outTrace[0], "velr_explain_analyze");
  }

  /** Start an explicit transaction. Call `commit()` or `rollback()` when done. */
  beginTx(): VelrTx {
    const outTx = outPtr();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_tx_begin(this.ptr(), outTx, outErrValue), outErrValue);
    if (isNullPointer(outTx[0])) throw new VelrError("velr_tx_begin returned null transaction");
    const tx = new VelrTx(outTx[0], this);
    this.registerChild(tx);
    return tx;
  }

  /**
   * Close this connection and all open child handles.
   *
   * Calling `close()` more than once is safe.
   */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    closeChildren(this.#children);
    this.#ptr = null;
    getBindings().lib.velr_close(ptr);
    for (const callback of this.#vectorCallbacks.values()) {
      unregisterVectorCallback(callback);
    }
    this.#vectorCallbacks.clear();
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr connection");
  }

  private adoptTrace(ptr: NativePointer, source: string): ExplainTrace {
    if (isNullPointer(ptr)) throw new VelrError(`${source} returned null explain trace`);
    const trace = new ExplainTrace(ptr, this);
    this.registerChild(trace);
    return trace;
  }
}

/**
 * Synchronous stream of result tables returned by `Velr.exec()`.
 *
 * Most Cypher statements return one table, but multi-statement execution may
 * produce more. Close the stream to release native resources.
 */
export class Stream implements ChildHandle, Iterable<Table> {
  #ptr: NativePointer;
  #children = new Set<ChildHandle>();

  /** @internal Streams are created by `Velr.exec()`. */
  constructor(ptr: NativePointer, private parent: ParentHandle) {
    this.#ptr = ptr;
  }

  /** Return the next result table, or `null` when the stream is exhausted. */
  nextTable(): Table | null {
    const outTable = outPtr();
    const outHas = outInt();
    const outErrValue = outPtr();
    check(
      getBindings().lib.velr_stream_next_table(this.ptr(), outTable, outHas, outErrValue),
      outErrValue
    );
    if (outHas[0] === 0) return null;
    if (isNullPointer(outTable[0])) throw new VelrError("stream returned a null table");
    const table = new Table(outTable[0], this);
    this.registerChild(table);
    return table;
  }

  /** Iterate over result tables until the stream is exhausted. */
  *[Symbol.iterator](): Iterator<Table> {
    for (;;) {
      const table = this.nextTable();
      if (!table) return;
      yield table;
    }
  }

  /** @internal Register a child table owned by this stream. */
  registerChild(child: ChildHandle): void {
    this.#children.add(child);
  }

  /** @internal Unregister a child table owned by this stream. */
  unregisterChild(child: ChildHandle): void {
    this.#children.delete(child);
  }

  /** Close this stream and any tables still owned by it. */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    closeChildren(this.#children);
    this.#ptr = null;
    getBindings().lib.velr_exec_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr stream");
  }
}

/**
 * One result table returned by a query.
 *
 * A table exposes column metadata, row cursors, eager collection helpers, and
 * Arrow IPC export.
 */
export class Table implements ChildHandle {
  #ptr: NativePointer;
  #children = new Set<ChildHandle>();
  #columnNames: string[] | null = null;

  /** @internal Tables are created by query execution APIs. */
  constructor(ptr: NativePointer, private parent: ParentHandle) {
    this.#ptr = ptr;
  }

  /** Return the number of columns in this table. */
  columnCount(): number {
    return sizeToNumber(getBindings().lib.velr_table_column_count(this.ptr()), "column count");
  }

  /** Return column names in result order. */
  columnNames(): readonly string[] {
    if (this.#columnNames) return this.#columnNames;
    const names: string[] = [];
    const count = this.columnCount();
    const { lib } = getBindings();
    for (let i = 0; i < count; i += 1) {
      const outName = outPtr();
      const outLen = outInt();
      checkNoErr(lib.velr_table_column_name(this.ptr(), i, outName, outLen), "column name");
      names.push(pointerToBuffer(outName[0], outLen[0], "column name").toString("utf8"));
    }
    this.#columnNames = names;
    return names;
  }

  /** Open a streaming row cursor for this table. */
  rows(): Rows {
    const outRows = outPtr();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_table_rows_open(this.ptr(), outRows, outErrValue), outErrValue);
    if (isNullPointer(outRows[0])) throw new VelrError("velr_table_rows_open returned null rows");
    const rows = new Rows(outRows[0], this.columnCount(), this);
    this.registerChild(rows);
    return rows;
  }

  /** Visit every row in order and close the row cursor afterwards. */
  forEachRow(fn: (row: readonly Cell[], index: number) => void): void {
    const rows = this.rows();
    try {
      let index = 0;
      for (const row of rows) {
        fn(row, index);
        index += 1;
      }
    } finally {
      rows.close();
    }
  }

  /**
   * Collect all rows into an array.
   *
   * Without a mapper, each row is returned as a fresh `Cell[]`.
   */
  collect<T = Cell[]>(map?: RowMapper<T>): T[] {
    const out: T[] = [];
    this.forEachRow((row, index) => {
      out.push(map ? map(row, index) : ([...row] as T));
    });
    return out;
  }

  /**
   * Convert all rows into objects keyed by column name.
   *
   * Cell values are converted using `Cell.asJs(options)`.
   */
  toObjects<T extends Record<string, unknown> = Record<string, unknown>>(
    options: CellAsJsOptions = {}
  ): T[] {
    const names = this.columnNames();
    return this.collect((row) => {
      const object: Record<string, unknown> = {};
      row.forEach((cell, index) => {
        object[names[index] ?? String(index)] = cell.asJs(options);
      });
      return object as T;
    });
  }

  /** Export this table as an Arrow IPC file/Feather v2 buffer. */
  toArrowIpc(): Buffer {
    const { lib } = getBindings();
    if (!lib.velr_table_ipc_file_malloc) {
      throw new VelrError("loaded Velr runtime does not expose Arrow IPC export");
    }
    const outPtrValue = outPtr();
    const outLen = outInt();
    const outErrValue = outPtr();
    check(lib.velr_table_ipc_file_malloc(this.ptr(), outPtrValue, outLen, outErrValue), outErrValue);
    try {
      return pointerToBuffer(outPtrValue[0], outLen[0], "Arrow IPC buffer");
    } finally {
      if (!isNullPointer(outPtrValue[0])) {
        lib.velr_free(outPtrValue[0], outLen[0]);
      }
    }
  }

  /**
   * Convert this table to an Apache Arrow table.
   *
   * Requires the optional `apache-arrow` peer dependency.
   */
  async toArrowTable(): Promise<unknown> {
    const arrow = await import("apache-arrow");
    const tableFromIPC = (arrow as any).tableFromIPC;
    if (typeof tableFromIPC !== "function") {
      throw new VelrError("installed apache-arrow package does not expose tableFromIPC()");
    }
    return tableFromIPC(this.toArrowIpc());
  }

  /** @internal Register a row cursor owned by this table. */
  registerChild(child: ChildHandle): void {
    this.#children.add(child);
  }

  /** @internal Unregister a row cursor owned by this table. */
  unregisterChild(child: ChildHandle): void {
    this.#children.delete(child);
  }

  /** Close this table and any open row cursors. */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    closeChildren(this.#children);
    this.#ptr = null;
    getBindings().lib.velr_table_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** @internal Move this table to a different owning handle. */
  reparent(parent: ParentHandle): void {
    this.parent.unregisterChild(this);
    this.parent = parent;
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr table");
  }
}

/**
 * Streaming row cursor for a `Table`.
 *
 * Use `Table.collect()` or `Table.toObjects()` when eager collection is more
 * convenient.
 */
export class Rows implements ChildHandle, Iterable<Cell[]> {
  #ptr: NativePointer;
  #buffer: Buffer;

  /** @internal Row cursors are created by `Table.rows()`. */
  constructor(
    ptr: NativePointer,
    private readonly columnCountValue: number,
    private readonly parent: ParentHandle
  ) {
    this.#ptr = ptr;
    this.#buffer = Buffer.alloc(getBindings().cellSize * columnCountValue);
  }

  /** Return the next row, or `null` when the cursor is exhausted. */
  next(): Cell[] | null {
    const outWritten = outInt();
    const outErrValue = outPtr();
    const rc = getBindings().lib.velr_rows_next(
      this.ptr(),
      this.#buffer,
      this.columnCountValue,
      outWritten,
      outErrValue
    );
    if (rc === 0) return null;
    if (rc < 0) check(rc, outErrValue, "rows_next");
    const written = sizeToNumber(outWritten[0], "row cell count");
    const cells: Cell[] = [];
    for (let i = 0; i < written; i += 1) {
      cells.push(Cell.fromRaw(decodeCellAt(this.#buffer, i)));
    }
    return cells;
  }

  /** Iterate over rows until the cursor is exhausted. */
  *[Symbol.iterator](): Iterator<Cell[]> {
    for (;;) {
      const row = this.next();
      if (!row) return;
      yield row;
    }
  }

  /** Close this row cursor. Calling `close()` more than once is safe. */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    this.#ptr = null;
    getBindings().lib.velr_rows_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr rows");
  }
}

/**
 * Explain or explain-analyze trace returned by Velr.
 *
 * The indexed methods expose the native trace lazily. Use `snapshot()` to copy
 * the whole trace into plain JavaScript objects.
 */
export class ExplainTrace implements ChildHandle {
  #ptr: NativePointer;

  /** @internal Explain traces are created by `explain()` and `explainAnalyze()`. */
  constructor(ptr: NativePointer, private readonly parent: ParentHandle) {
    this.#ptr = ptr;
  }

  /** Return the number of plans in this trace. */
  planCount(): number {
    return sizeToNumber(
      getBindings().lib.velr_explain_trace_plan_count(this.ptr()),
      "explain plan count"
    );
  }

  /** Return metadata for a plan by zero-based plan index. */
  planMeta(planIdx: number): ExplainPlanMeta {
    const raw: ExplainPlanMetaRaw = {};
    checkNoErr(
      getBindings().lib.velr_explain_trace_plan_meta(this.ptr(), planIdx, raw),
      "explain plan metadata"
    );
    return {
      planId: strViewToString(raw.plan_id, "explain plan id"),
      cypher: strViewToString(raw.cypher, "explain plan Cypher"),
      stepCount: sizeToNumber(raw.step_count, "explain step count")
    };
  }

  /** Return the number of steps in a plan. */
  stepCount(planIdx: number): number {
    return sizeToNumber(
      getBindings().lib.velr_explain_trace_step_count(this.ptr(), planIdx),
      "explain step count"
    );
  }

  /** Return metadata for a step by zero-based plan and step indexes. */
  stepMeta(planIdx: number, stepIdx: number): ExplainStepMeta {
    const raw: ExplainStepMetaRaw = {};
    checkNoErr(
      getBindings().lib.velr_explain_trace_step_meta(this.ptr(), planIdx, stepIdx, raw),
      "explain step metadata"
    );
    return {
      stepNo: sizeToNumber(raw.step_no, "explain step number"),
      groupId: strViewToString(raw.group_id, "explain group id"),
      opIndex: strViewToString(raw.op_index, "explain op index"),
      phase: strViewToString(raw.phase, "explain phase"),
      title: strViewToString(raw.title, "explain title"),
      source: strViewToString(raw.source, "explain source"),
      note: optStrViewToString(raw.note, "explain note"),
      statementCount: sizeToNumber(raw.statement_count, "explain statement count")
    };
  }

  /** Return the number of SQL statements attached to a step. */
  statementCount(planIdx: number, stepIdx: number): number {
    return sizeToNumber(
      getBindings().lib.velr_explain_trace_statement_count(this.ptr(), planIdx, stepIdx),
      "explain statement count"
    );
  }

  /** Return metadata for a SQL statement by zero-based indexes. */
  statementMeta(planIdx: number, stepIdx: number, stmtIdx: number): ExplainStatementMeta {
    const raw: ExplainStatementMetaRaw = {};
    checkNoErr(
      getBindings().lib.velr_explain_trace_statement_meta(
        this.ptr(),
        planIdx,
        stepIdx,
        stmtIdx,
        raw
      ),
      "explain statement metadata"
    );
    return {
      stmtId: strViewToString(raw.stmt_id, "explain statement id"),
      kind: strViewToString(raw.kind, "explain statement kind"),
      sql: strViewToString(raw.sql, "explain SQL"),
      note: optStrViewToString(raw.note, "explain statement note"),
      sqlitePlanCount: sizeToNumber(raw.sqlite_plan_count, "sqlite plan count")
    };
  }

  /** Return one SQLite plan-detail row for a SQL statement. */
  sqlitePlanDetail(planIdx: number, stepIdx: number, stmtIdx: number, detailIdx: number): string {
    const raw = { ptr: null, len: 0 };
    checkNoErr(
      getBindings().lib.velr_explain_trace_sqlite_plan_detail(
        this.ptr(),
        planIdx,
        stepIdx,
        stmtIdx,
        detailIdx,
        raw
      ),
      "sqlite plan detail"
    );
    return strViewToString(raw, "sqlite plan detail");
  }

  /** Copy the full trace into plain JavaScript objects. */
  snapshot(): ExplainPlan[] {
    const plans: ExplainPlan[] = [];
    for (let planIdx = 0; planIdx < this.planCount(); planIdx += 1) {
      const planMeta = this.planMeta(planIdx);
      const steps: ExplainStep[] = [];
      for (let stepIdx = 0; stepIdx < this.stepCount(planIdx); stepIdx += 1) {
        const stepMeta = this.stepMeta(planIdx, stepIdx);
        const statements: ExplainStatement[] = [];
        for (
          let stmtIdx = 0;
          stmtIdx < this.statementCount(planIdx, stepIdx);
          stmtIdx += 1
        ) {
          const stmtMeta = this.statementMeta(planIdx, stepIdx, stmtIdx);
          const sqlitePlan: string[] = [];
          for (let detailIdx = 0; detailIdx < stmtMeta.sqlitePlanCount; detailIdx += 1) {
            sqlitePlan.push(this.sqlitePlanDetail(planIdx, stepIdx, stmtIdx, detailIdx));
          }
          statements.push({ ...stmtMeta, sqlitePlan });
        }
        steps.push({ ...stepMeta, statements });
      }
      plans.push({ ...planMeta, steps });
    }
    return plans;
  }

  /** Render the trace using Velr's compact human-readable format. */
  toCompactString(): string {
    const { lib } = getBindings();
    if (!lib.velr_explain_trace_compact_malloc) {
      throw new VelrError("loaded Velr runtime does not expose explain compact rendering");
    }
    const outBuffer = outPtr();
    const outLen = outInt();
    const outErrValue = outPtr();
    check(
      lib.velr_explain_trace_compact_malloc(this.ptr(), outBuffer, outLen, outErrValue),
      outErrValue
    );
    try {
      return pointerToBuffer(outBuffer[0], outLen[0], "compact explain trace").toString("utf8");
    } finally {
      if (!isNullPointer(outBuffer[0])) lib.velr_free(outBuffer[0], outLen[0]);
    }
  }

  /** Close this explain trace. Calling `close()` more than once is safe. */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    this.#ptr = null;
    getBindings().lib.velr_explain_trace_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr explain trace");
  }
}

/**
 * Explicit synchronous transaction.
 *
 * Create transactions with `Velr.beginTx()` or `Velr.transaction()`. A
 * transaction must be committed, rolled back, or closed.
 */
export class VelrTx implements ParentHandle, ChildHandle {
  #ptr: NativePointer;
  #children = new Set<ChildHandle>();
  #namedSavepoints: NamedSavepointEntry[] = [];

  /** @internal Transactions are created by `Velr.beginTx()`. */
  constructor(ptr: NativePointer, private readonly parent: ParentHandle) {
    this.#ptr = ptr;
  }

  /** @internal Register a child handle owned by this transaction. */
  registerChild(child: ChildHandle): void {
    this.#children.add(child);
  }

  /** @internal Unregister a child handle owned by this transaction. */
  unregisterChild(child: ChildHandle): void {
    this.#children.delete(child);
  }

  /** Whether this transaction has already ended. */
  get closed(): boolean {
    return isNullPointer(this.#ptr);
  }

  /** Execute Cypher inside this transaction and return a stream of result tables. */
  exec(cypher: string, options?: QueryOptions): StreamTx {
    ensureNoNul(cypher, "openCypher");
    const { lib } = getBindings();
    return withQueryOptions(options, (raw) => {
      const outStream = outPtr();
      const outErrValue = outPtr();
      if (raw) {
        if (!lib.velr_tx_exec_start_with_options) {
          throw new VelrError("loaded Velr runtime does not expose velr_tx_exec_start_with_options");
        }
        check(
          lib.velr_tx_exec_start_with_options(this.ptr(), cypher, raw, outStream, outErrValue),
          outErrValue
        );
      } else {
        check(lib.velr_tx_exec_start(this.ptr(), cypher, outStream, outErrValue), outErrValue);
      }
      if (isNullPointer(outStream[0])) {
        throw new VelrError("velr_tx_exec_start returned null stream");
      }
      const stream = new StreamTx(outStream[0], this);
      this.registerChild(stream);
      return stream;
    });
  }

  /**
   * Execute Cypher inside this transaction and return exactly one result table.
   *
   * Throws when the statement produces no tables or multiple tables.
   */
  execOne(cypher: string, options?: QueryOptions): Table {
    const stream = this.exec(cypher, options);
    let table: Table | null = null;
    try {
      table = stream.nextTable();
      if (!table) throw new VelrError("query produced no result tables");
      stream.unregisterChild(table);
      table.reparent(this);
      this.registerChild(table);

      const extra = stream.nextTable();
      if (extra) {
        extra.close();
        table.close();
        throw new VelrError("query produced multiple tables; use exec() to stream them");
      }
      stream.close();
      return table;
    } catch (err) {
      stream.close();
      if (table) table.close();
      throw err;
    }
  }

  /** Execute Cypher inside this transaction and discard all result tables. */
  run(cypher: string, options?: QueryOptions): void {
    const stream = this.exec(cypher, options);
    try {
      for (;;) {
        const table = stream.nextTable();
        if (!table) break;
        table.close();
      }
    } finally {
      stream.close();
    }
  }

  /** Alias for `run()`. */
  execute(cypher: string, options?: QueryOptions): void {
    this.run(cypher, options);
  }

  /**
   * Bind an Arrow IPC file/Feather v2 payload for use inside this transaction.
   *
   * The binding follows transaction visibility and disappears when the
   * transaction ends.
   */
  bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): void {
    ensureNoNul(logical, "logical table name");
    const buffer = arrowIpcBuffer(ipcBytes);
    const { lib } = getBindings();
    if (!lib.velr_tx_bind_arrow_ipc) {
      throw new VelrError("loaded Velr runtime does not expose transaction Arrow IPC bind");
    }
    const outErrValue = outPtr();
    check(
      lib.velr_tx_bind_arrow_ipc(this.ptr(), logical, buffer, buffer.byteLength, outErrValue),
      outErrValue
    );
  }

  /**
   * Execute Cypher inside this transaction and convert one result table into objects.
   */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): T[] {
    const table = this.execOne(cypher, options);
    try {
      return table.toObjects<T>(options);
    } finally {
      table.close();
    }
  }

  /** Build an explain trace inside this transaction without executing the query. */
  explain(cypher: string): ExplainTrace {
    ensureNoNul(cypher, "openCypher");
    const outTrace = outPtr();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_tx_explain(this.ptr(), cypher, outTrace, outErrValue), outErrValue);
    return this.adoptTrace(outTrace[0], "velr_tx_explain");
  }

  /** Execute the query inside this transaction and return an analyzed explain trace. */
  explainAnalyze(cypher: string): ExplainTrace {
    ensureNoNul(cypher, "openCypher");
    const outTrace = outPtr();
    const outErrValue = outPtr();
    check(
      getBindings().lib.velr_tx_explain_analyze(this.ptr(), cypher, outTrace, outErrValue),
      outErrValue
    );
    return this.adoptTrace(outTrace[0], "velr_tx_explain_analyze");
  }

  /** Create an anonymous savepoint. */
  savepoint(): Savepoint {
    const outSavepoint = outPtr();
    const outErrValue = outPtr();
    check(getBindings().lib.velr_tx_savepoint(this.ptr(), outSavepoint, outErrValue), outErrValue);
    if (isNullPointer(outSavepoint[0])) throw new VelrError("velr_tx_savepoint returned null");
    const savepoint = new Savepoint(outSavepoint[0], this);
    this.registerChild(savepoint);
    return savepoint;
  }

  /**
   * Run a function inside an anonymous savepoint.
   *
   * The savepoint is released when `fn` returns successfully and rolled back
   * when `fn` throws, unless the callback already consumed it.
   */
  withSavepoint<T>(fn: (savepoint: Savepoint) => T): T {
    const savepoint = this.savepoint();
    let completed = false;
    try {
      const result = fn(savepoint);
      if (!savepoint.closed) savepoint.release();
      completed = true;
      return result;
    } finally {
      if (!completed && !savepoint.closed) savepoint.rollback();
    }
  }

  /**
   * Create a named savepoint.
   *
   * Named savepoints are stack-like: only the newest named savepoint can be
   * released directly. `rollbackTo(name)` retains the named target and removes
   * newer named savepoints.
   */
  savepointNamed(name: string): Savepoint {
    ensureNoNul(name, "savepoint name");
    const entry: NamedSavepointEntry = {
      name,
      ptr: this.#createNamedRuntimeSavepoint(name),
      active: true
    };
    this.#namedSavepoints.push(entry);
    const savepoint = new Savepoint(null, this, {
      name,
      isActive: () => entry.active && !isNullPointer(entry.ptr),
      release: () => this.#releaseNamedEntry(entry),
      rollback: () => this.#rollbackNamedEntry(entry, true)
    });
    this.registerChild(savepoint);
    return savepoint;
  }

  /**
   * Run a function inside a named savepoint.
   *
   * The savepoint is released on success and rolled back on failure, unless the
   * callback already consumed it.
   */
  withSavepointNamed<T>(name: string, fn: (savepoint: Savepoint) => T): T {
    const savepoint = this.savepointNamed(name);
    let completed = false;
    try {
      const result = fn(savepoint);
      if (!savepoint.closed) savepoint.release();
      completed = true;
      return result;
    } finally {
      if (!completed && !savepoint.closed) savepoint.rollback();
    }
  }

  /**
   * Roll back to a named savepoint and keep that savepoint active.
   *
   * Newer named savepoints are invalidated.
   */
  rollbackTo(name: string): void {
    ensureNoNul(name, "savepoint name");
    const idx = this.#findNamedIndex(name);
    if (idx < 0) throw new VelrError(`no such savepoint '${name}'`);
    this.#rollbackNamedEntry(this.#namedSavepoints[idx]!, false);
  }

  /** Release the newest active named savepoint with `name`. */
  releaseSavepoint(name: string): void {
    ensureNoNul(name, "savepoint name");
    const idx = this.#findNamedIndex(name);
    if (idx < 0) throw new VelrError(`no such savepoint '${name}'`);
    this.#releaseNamedEntry(this.#namedSavepoints[idx]!);
  }

  /** Commit the transaction and close all child handles. */
  commit(): void {
    const ptr = this.ptr();
    closeChildren(this.#children);
    this.#releaseNamedSavepointsForCommit();
    this.#ptr = null;
    try {
      const outErrValue = outPtr();
      check(getBindings().lib.velr_tx_commit(ptr, outErrValue), outErrValue);
    } finally {
      this.#invalidateNamedSavepoints();
      this.parent.unregisterChild(this);
    }
  }

  /** Roll back the transaction and close all child handles. */
  rollback(): void {
    const ptr = this.ptr();
    closeChildren(this.#children);
    this.#ptr = null;
    try {
      const outErrValue = outPtr();
      check(getBindings().lib.velr_tx_rollback(ptr, outErrValue), outErrValue);
    } finally {
      this.#invalidateNamedSavepoints();
      this.parent.unregisterChild(this);
    }
  }

  /**
   * Close the transaction without committing.
   *
   * This releases the native transaction handle. Prefer `rollback()` when you
   * want rollback errors to be surfaced.
   */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    closeChildren(this.#children);
    this.#ptr = null;
    try {
      getBindings().lib.velr_tx_close(ptr);
    } finally {
      this.#invalidateNamedSavepoints();
      this.parent.unregisterChild(this);
    }
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr transaction");
  }

  #createNamedRuntimeSavepoint(name: string): NativePointer {
    const { lib } = getBindings();
    if (!lib.velr_tx_savepoint_named) {
      throw new VelrError("loaded Velr runtime does not expose velr_tx_savepoint_named");
    }
    const outSavepoint = outPtr();
    const outErrValue = outPtr();
    check(lib.velr_tx_savepoint_named(this.ptr(), name, outSavepoint, outErrValue), outErrValue);
    if (isNullPointer(outSavepoint[0])) throw new VelrError("velr_tx_savepoint_named returned null");
    return outSavepoint[0];
  }

  #findNamedIndex(name: string): number {
    for (let i = this.#namedSavepoints.length - 1; i >= 0; i -= 1) {
      const entry = this.#namedSavepoints[i]!;
      if (entry.active && entry.name === name) return i;
    }
    return -1;
  }

  #findNamedEntryIndex(wanted: NamedSavepointEntry): number {
    for (let i = this.#namedSavepoints.length - 1; i >= 0; i -= 1) {
      const entry = this.#namedSavepoints[i]!;
      if (entry === wanted && wanted.active) return i;
    }
    return -1;
  }

  #invalidateNamedSavepoints(): void {
    for (const entry of this.#namedSavepoints) {
      entry.active = false;
      entry.ptr = null;
    }
    this.#namedSavepoints = [];
  }

  #pruneNamedAfter(idx: number): void {
    for (const newer of this.#namedSavepoints.slice(idx + 1)) {
      newer.active = false;
      newer.ptr = null;
    }
    this.#namedSavepoints.splice(idx + 1);
  }

  #retainNamedTargetAfterRollback(idx: number): void {
    const entry = this.#namedSavepoints[idx]!;
    try {
      entry.ptr = this.#createNamedRuntimeSavepoint(entry.name);
      entry.active = true;
    } catch (err) {
      entry.active = false;
      entry.ptr = null;
      for (const newer of this.#namedSavepoints.slice(idx + 1)) {
        newer.active = false;
        newer.ptr = null;
      }
      this.#namedSavepoints.splice(idx);
      throw new VelrError(
        `rollbackTo('${entry.name}') succeeded, but failed to recreate the named savepoint to preserve retained-target semantics: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    this.#pruneNamedAfter(idx);
  }

  #releaseNamedEntry(entry: NamedSavepointEntry): void {
    this.ptr();

    if (!entry.active || isNullPointer(entry.ptr)) {
      throw new VelrError(`no such savepoint '${entry.name}'`);
    }

    const idx = this.#findNamedEntryIndex(entry);
    if (idx < 0) throw new VelrError(`no such savepoint '${entry.name}'`);
    if (idx !== this.#namedSavepoints.length - 1) {
      throw new VelrError("named savepoint can only be released from the top of the stack");
    }

    const ptr = entry.ptr;
    entry.ptr = null;
    entry.active = false;
    this.#namedSavepoints.pop();

    const outErrValue = outPtr();
    check(getBindings().lib.velr_sp_release(ptr, outErrValue), outErrValue);
  }

  #rollbackNamedEntry(entry: NamedSavepointEntry, releaseTarget: boolean): void {
    this.ptr();

    if (!entry.active || isNullPointer(entry.ptr)) {
      throw new VelrError(`no such savepoint '${entry.name}'`);
    }

    const idx = this.#findNamedEntryIndex(entry);
    if (idx < 0) throw new VelrError(`no such savepoint '${entry.name}'`);

    if (releaseTarget) {
      const ptr = entry.ptr;
      for (const doomed of this.#namedSavepoints.slice(idx)) {
        doomed.active = false;
        doomed.ptr = null;
      }
      this.#namedSavepoints.splice(idx);

      const outErrValue = outPtr();
      check(getBindings().lib.velr_sp_rollback(ptr, outErrValue), outErrValue);
      return;
    }

    const { lib } = getBindings();
    if (!lib.velr_tx_rollback_to) {
      throw new VelrError("loaded Velr runtime does not expose velr_tx_rollback_to");
    }
    const outErrValue = outPtr();
    check(lib.velr_tx_rollback_to(this.ptr(), entry.name, outErrValue), outErrValue);
    this.#retainNamedTargetAfterRollback(idx);
  }

  #releaseNamedSavepointsForCommit(): void {
    while (this.#namedSavepoints.length > 0) {
      const entry = this.#namedSavepoints[this.#namedSavepoints.length - 1]!;
      if (!entry.active || isNullPointer(entry.ptr)) {
        this.#namedSavepoints.pop();
        continue;
      }
      this.#releaseNamedEntry(entry);
    }
  }

  private adoptTrace(ptr: NativePointer, source: string): ExplainTrace {
    if (isNullPointer(ptr)) throw new VelrError(`${source} returned null explain trace`);
    const trace = new ExplainTrace(ptr, this);
    this.registerChild(trace);
    return trace;
  }
}

/**
 * Synchronous stream of result tables returned by `VelrTx.exec()`.
 *
 * Close the stream to release transaction-scoped native resources.
 */
export class StreamTx implements ChildHandle, Iterable<Table>, ParentHandle {
  #ptr: NativePointer;
  #children = new Set<ChildHandle>();

  /** @internal Transaction streams are created by `VelrTx.exec()`. */
  constructor(ptr: NativePointer, private readonly parent: ParentHandle) {
    this.#ptr = ptr;
  }

  /** Return the next transaction result table, or `null` when exhausted. */
  nextTable(): Table | null {
    const outTable = outPtr();
    const outHas = outInt();
    const outErrValue = outPtr();
    check(
      getBindings().lib.velr_stream_tx_next_table(this.ptr(), outTable, outHas, outErrValue),
      outErrValue
    );
    if (outHas[0] === 0) return null;
    if (isNullPointer(outTable[0])) throw new VelrError("transaction stream returned a null table");
    const table = new Table(outTable[0], this);
    this.registerChild(table);
    return table;
  }

  /** Iterate over result tables until the stream is exhausted. */
  *[Symbol.iterator](): Iterator<Table> {
    for (;;) {
      const table = this.nextTable();
      if (!table) return;
      yield table;
    }
  }

  /** @internal Register a child table owned by this stream. */
  registerChild(child: ChildHandle): void {
    this.#children.add(child);
  }

  /** @internal Unregister a child table owned by this stream. */
  unregisterChild(child: ChildHandle): void {
    this.#children.delete(child);
  }

  /** Close this stream and any tables still owned by it. */
  close(): void {
    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    closeChildren(this.#children);
    this.#ptr = null;
    getBindings().lib.velr_exec_tx_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr transaction stream");
  }
}

/**
 * Transaction savepoint handle.
 *
 * Savepoints are created by `VelrTx.savepoint()` or `VelrTx.savepointNamed()`.
 * Release to keep changes after the savepoint, or roll back to undo them.
 */
export class Savepoint implements ChildHandle {
  #ptr: NativePointer;
  #closed = false;
  readonly #named: NamedSavepointController | null;

  /** @internal Savepoints are created by transaction methods. */
  constructor(
    ptr: NativePointer,
    private readonly parent: VelrTx,
    named: NamedSavepointController | null = null
  ) {
    this.#ptr = ptr;
    this.#named = named;
  }

  /** Savepoint name, or `null` for anonymous savepoints. */
  get name(): string | null {
    return this.#named?.name ?? null;
  }

  /** Whether this savepoint has already been released, rolled back, or closed. */
  get closed(): boolean {
    if (this.#named) return this.#closed || !this.#named.isActive();
    return isNullPointer(this.#ptr);
  }

  /** Release this savepoint and keep changes made after it. */
  release(): void {
    if (this.#named) {
      if (this.#closed) throw new VelrStateError("Velr savepoint is closed");
      this.#named.release();
      this.#closed = true;
      this.parent.unregisterChild(this);
      return;
    }

    const ptr = this.ptr();
    this.#ptr = null;
    const outErrValue = outPtr();
    check(getBindings().lib.velr_sp_release(ptr, outErrValue), outErrValue);
    this.parent.unregisterChild(this);
  }

  /** Roll back changes made after this savepoint and consume the handle. */
  rollback(): void {
    if (this.#named) {
      if (this.#closed) throw new VelrStateError("Velr savepoint is closed");
      this.#named.rollback();
      this.#closed = true;
      this.parent.unregisterChild(this);
      return;
    }

    const ptr = this.ptr();
    this.#ptr = null;
    const outErrValue = outPtr();
    check(getBindings().lib.velr_sp_rollback(ptr, outErrValue), outErrValue);
    this.parent.unregisterChild(this);
  }

  /**
   * Close the savepoint handle without releasing or rolling back it explicitly.
   *
   * Prefer `release()` or `rollback()` when the desired transaction behavior is
   * known.
   */
  close(): void {
    if (this.#named) {
      if (this.#closed) return;
      this.#closed = true;
      this.parent.unregisterChild(this);
      return;
    }

    const ptr = this.#ptr;
    if (isNullPointer(ptr)) return;
    this.#ptr = null;
    getBindings().lib.velr_sp_close(ptr);
    this.parent.unregisterChild(this);
  }

  /** @internal Mark this savepoint as consumed after a parent operation. */
  forgetConsumed(): void {
    this.#ptr = null;
    this.#closed = true;
    this.parent.unregisterChild(this);
  }

  /** Dispose hook for JavaScript explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  private ptr(): NativePointer {
    return requireOpen(this.#ptr, "Velr savepoint");
  }
}
