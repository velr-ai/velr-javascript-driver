/**
 * Worker-thread async driver for Velr.
 *
 * This module mirrors the root `@velr-ai/velr` driver API while moving native execution
 * onto a Node.js worker thread.
 *
 * @packageDocumentation
 */
import { Worker } from "node:worker_threads";

import { Cell } from "../driver.js";
import { VelrError, VelrStateError, VelrTypeError } from "../errors.js";
import type {
  CellAsJsOptions,
  CellType,
  CellValue,
  ExplainPlan,
  ExplainPlanMeta,
  ExplainStatementMeta,
  ExplainStepMeta,
  MigrationReport,
  QueryOptions,
  VectorEmbedding,
  VectorEmbeddingInput
} from "../types.js";

/** Options used when spawning a Velr worker thread. */
export interface VelrWorkerOptions {
  /** Additional worker data passed to Node's `Worker` constructor. */
  readonly workerData?: unknown;
}

/**
 * Vector embedding callback used by `VelrWorker`.
 *
 * Unlike the direct driver's `VectorEmbedder`, the worker embedder may return a
 * promise because the callback runs on the main thread while database execution
 * happens in the worker.
 */
export type VelrWorkerVectorEmbedder = (
  inputs: readonly VectorEmbeddingInput[]
) => readonly VectorEmbedding[] | Promise<readonly VectorEmbedding[]>;

type WorkerHandleKind =
  | "stream"
  | "streamTx"
  | "table"
  | "rows"
  | "trace"
  | "tx"
  | "savepoint";

interface WorkerHandleRef {
  readonly id: string;
  readonly kind: WorkerHandleKind;
  readonly name?: string | null;
}

interface WorkerCell {
  readonly type: CellType;
  readonly i64: bigint;
  readonly f64: number;
  readonly data: Uint8Array;
}

interface WorkerError {
  readonly name?: string;
  readonly message: string;
  readonly code?: number;
  readonly stack?: string;
}

interface WorkerResponse {
  readonly id: string;
  readonly result?: unknown;
  readonly error?: WorkerError;
}

interface WorkerEmbedRequest {
  readonly type: "velr.embed";
  readonly requestId: string;
  readonly embedderId: string;
  readonly inputs: readonly VectorEmbeddingInput[];
  readonly dimensions: number;
  readonly control: SharedArrayBuffer;
  readonly output: SharedArrayBuffer;
  readonly error: SharedArrayBuffer;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

function workerCellToCell(raw: WorkerCell): Cell {
  return new Cell(raw.type, BigInt(raw.i64), raw.f64, Buffer.from(raw.data));
}

function workerRowsToCells(rows: readonly WorkerCell[][]): Cell[][] {
  return rows.map((row) => row.map(workerCellToCell));
}

function workerBufferToBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value);
}

function arrowIpcPayload(bytes: Buffer | Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new VelrTypeError("Arrow IPC bytes must be a Buffer or Uint8Array");
  }
  if (bytes.byteLength === 0) {
    throw new VelrTypeError("Arrow IPC bytes cannot be empty");
  }
  return bytes;
}

function deserializeError(error: WorkerError): Error {
  let out: Error;
  if (error.name === "VelrStateError") {
    out = new VelrStateError(error.message);
  } else if (error.name === "VelrTypeError") {
    out = new VelrTypeError(error.message);
  } else if (error.name === "VelrError") {
    out = new VelrError(error.message, { code: error.code });
  } else {
    out = new Error(error.message);
    out.name = error.name ?? "Error";
  }
  if (error.stack) out.stack = error.stack;
  return out;
}

class WorkerRpc {
  readonly worker: Worker;
  onEmbedRequest?: (request: WorkerEmbedRequest) => void;
  #pending = new Map<string, PendingCall>();
  #closed = false;
  #nextId = 0;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.on("message", (message: WorkerResponse) => this.#onMessage(message));
    worker.on("error", (err) => this.#rejectAll(err));
    worker.on("exit", (code) => {
      this.#closed = true;
      if (code !== 0) {
        this.#rejectAll(new Error(`Velr worker exited with code ${code}`));
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new VelrStateError("Velr worker is closed"));
    const id = `${Date.now().toString(36)}-${(this.#nextId += 1).toString(36)}`;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.worker.postMessage({ id, op, payload });
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  async terminate(): Promise<void> {
    this.#closed = true;
    this.#rejectAll(new VelrStateError("Velr worker is closed"));
    await this.worker.terminate();
  }

  #onMessage(message: WorkerResponse | WorkerEmbedRequest): void {
    if (isEmbedRequest(message)) {
      this.onEmbedRequest?.(message);
      return;
    }
    if (!message || typeof message.id !== "string") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(deserializeError(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(err: unknown): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) call.reject(err);
  }
}

function isEmbedRequest(message: unknown): message is WorkerEmbedRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type?: unknown }).type === "velr.embed"
  );
}

abstract class WorkerHandle {
  #closed = false;

  constructor(
    protected readonly rpc: WorkerRpc,
    protected readonly ref: WorkerHandleRef
  ) {}

  /** Whether this worker-side handle has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  protected markClosed(): void {
    this.#closed = true;
  }

  protected call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new VelrStateError(`${this.ref.kind} handle is closed`));
    }
    return this.rpc.call<T>(op, { ...payload, handle: this.ref.id });
  }

  /** Close this handle in the worker. Calling `close()` more than once is safe. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.rpc.call("handle.close", { handle: this.ref.id });
  }

  /** Async dispose hook for JavaScript explicit resource management. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function tableFromRef(rpc: WorkerRpc, ref: WorkerHandleRef): VelrWorkerTable {
  return new VelrWorkerTable(rpc, ref);
}

function traceFromRef(rpc: WorkerRpc, ref: WorkerHandleRef): VelrWorkerExplainTrace {
  return new VelrWorkerExplainTrace(rpc, ref);
}

/**
 * Asynchronous Velr database connection backed by a Node.js worker thread.
 *
 * Import from the worker subpath:
 *
 * ```ts
 * import { VelrWorker } from "@velr-ai/velr/worker";
 * ```
 *
 * The worker API mirrors the direct `Velr` API, but methods return promises and
 * native execution happens away from the caller's event loop.
 */
export class VelrWorker {
  /** Underlying Node.js worker thread. */
  readonly worker: Worker;
  #rpc: WorkerRpc;
  #embedders = new Map<string, VelrWorkerVectorEmbedder>();
  #embedderNames = new Map<string, string>();
  #closed = false;

  private constructor(rpc: WorkerRpc) {
    this.#rpc = rpc;
    this.#rpc.onEmbedRequest = (request) => {
      this.#handleEmbedRequest(request);
    };
    this.worker = rpc.worker;
  }

  /**
   * Open a database for reading and writing in a worker thread.
   *
   * Pass `null` or omit `path` for an in-memory database. Sidecar-backed
   * features such as fulltext and vector indexes require a file-backed
   * database.
   */
  static async open(path: string | null = null, options: VelrWorkerOptions = {}): Promise<VelrWorker> {
    const client = VelrWorker.#spawn(options);
    await client.#rpc.call("db.open", { path });
    return client;
  }

  /** Open an existing database in read-only mode in a worker thread. */
  static async openReadonly(path: string, options: VelrWorkerOptions = {}): Promise<VelrWorker> {
    const client = VelrWorker.#spawn(options);
    await client.#rpc.call("db.openReadonly", { path });
    return client;
  }

  static #spawn(options: VelrWorkerOptions): VelrWorker {
    const extraWorkerData =
      options.workerData && typeof options.workerData === "object" ? options.workerData : {};
    const worker = new Worker(new URL("./runtime-worker.js", import.meta.url), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: extraWorkerData
    });
    return new VelrWorker(new WorkerRpc(worker));
  }

  /** Whether this worker connection has already been closed. */
  get closed(): boolean {
    return this.#closed || this.#rpc.closed;
  }

  /** Return the schema version stored in the opened database. */
  async schemaVersion(): Promise<number> {
    return this.#rpc.call("db.schemaVersion");
  }

  /** Return the schema version expected by the loaded Velr runtime. */
  async currentSchemaVersion(): Promise<number> {
    return this.#rpc.call("db.currentSchemaVersion");
  }

  /** Return `true` when the database schema is older than the runtime schema. */
  async needsMigration(): Promise<boolean> {
    return this.#rpc.call("db.needsMigration");
  }

  /** Run any pending Velr schema migrations for this database. */
  async migrate(): Promise<MigrationReport> {
    return this.#rpc.call("db.migrate");
  }

  /**
   * Register or replace a vector embedder for worker-side vector indexes.
   *
   * The callback runs on the parent thread and may be asynchronous. Return one
   * embedding for each input in the same order.
   */
  async registerVectorEmbedder(name: string, embedder: VelrWorkerVectorEmbedder): Promise<void> {
    if (typeof name !== "string") throw new VelrTypeError("vector embedder name must be a string");
    if (name.length === 0) throw new VelrTypeError("vector embedder name cannot be empty");
    if (typeof embedder !== "function") throw new VelrTypeError("vector embedder must be a function");

    const embedderId = `${name}:${Date.now().toString(36)}:${Math.random()
      .toString(36)
      .slice(2)}`;
    const previous = this.#embedderNames.get(name);
    this.#embedders.set(embedderId, embedder);
    try {
      await this.#rpc.call("db.registerVectorEmbedderBridge", { name, embedderId });
      if (previous) this.#embedders.delete(previous);
      this.#embedderNames.set(name, embedderId);
    } catch (err) {
      this.#embedders.delete(embedderId);
      throw err;
    }
  }

  /** Execute Cypher and return an async stream of result tables. */
  async exec(cypher: string, options?: QueryOptions): Promise<VelrWorkerStream> {
    const ref = await this.#rpc.call<WorkerHandleRef>("db.exec", { cypher, options });
    return new VelrWorkerStream(this.#rpc, ref);
  }

  /**
   * Execute Cypher and return exactly one result table.
   *
   * The promise rejects when the statement produces no tables or multiple
   * tables.
   */
  async execOne(cypher: string, options?: QueryOptions): Promise<VelrWorkerTable> {
    const ref = await this.#rpc.call<WorkerHandleRef>("db.execOne", { cypher, options });
    return tableFromRef(this.#rpc, ref);
  }

  /** Execute Cypher and discard all result tables. */
  async run(cypher: string, options?: QueryOptions): Promise<void> {
    await this.#rpc.call("db.run", { cypher, options });
  }

  /** Alias for `run()`. */
  async execute(cypher: string, options?: QueryOptions): Promise<void> {
    await this.run(cypher, options);
  }

  /**
   * Bind an Arrow IPC file/Feather v2 payload as a logical table.
   *
   * IPC streams are not accepted by the current ABI.
   */
  async bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): Promise<void> {
    await this.#rpc.call("db.bindArrowIpc", {
      logical,
      ipcBytes: arrowIpcPayload(ipcBytes)
    });
  }

  /**
   * Run a function inside a worker transaction.
   *
   * The transaction commits when `fn` resolves and rolls back when `fn` rejects,
   * unless the callback has already committed or rolled back.
   */
  async transaction<T>(fn: (tx: VelrWorkerTx) => T | Promise<T>): Promise<T> {
    const tx = await this.beginTx();
    let committed = false;
    try {
      const result = await fn(tx);
      if (!tx.closed) await tx.commit();
      committed = true;
      return result;
    } finally {
      if (!committed && !tx.closed) {
        await tx.rollback();
      }
    }
  }

  /**
   * Execute Cypher and convert the single result table into objects.
   *
   * Column names become object keys and cell conversion follows `Cell.asJs()`.
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): Promise<T[]> {
    return this.#rpc.call<T[]>("db.query", { cypher, options });
  }

  /** Build an explain trace without executing the query. */
  async explain(cypher: string): Promise<VelrWorkerExplainTrace> {
    const ref = await this.#rpc.call<WorkerHandleRef>("db.explain", { cypher });
    return traceFromRef(this.#rpc, ref);
  }

  /** Execute the query and return an analyzed explain trace. */
  async explainAnalyze(cypher: string): Promise<VelrWorkerExplainTrace> {
    const ref = await this.#rpc.call<WorkerHandleRef>("db.explainAnalyze", { cypher });
    return traceFromRef(this.#rpc, ref);
  }

  /** Start an explicit transaction in the worker. */
  async beginTx(): Promise<VelrWorkerTx> {
    const ref = await this.#rpc.call<WorkerHandleRef>("db.beginTx");
    return new VelrWorkerTx(this.#rpc, ref);
  }

  /**
   * Close the database connection and terminate the worker thread.
   *
   * Calling `close()` more than once is safe.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#rpc.call("db.close");
    } finally {
      this.#embedders.clear();
      this.#embedderNames.clear();
      await this.#rpc.terminate();
    }
  }

  /** Async dispose hook for JavaScript explicit resource management. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #handleEmbedRequest(request: WorkerEmbedRequest): void {
    void (async () => {
      const control = new Int32Array(request.control);
      const output = new Float32Array(request.output);
      const error = new Uint8Array(request.error);
      try {
        const embedder = this.#embedders.get(request.embedderId);
        if (!embedder) throw new VelrError("worker vector embedder is not registered");

        const vectors = await embedder(request.inputs);
        if (vectors.length !== request.inputs.length) {
          throw new VelrError(
            `vector embedder returned ${vectors.length} embeddings for ${request.inputs.length} inputs`
          );
        }

        let offset = 0;
        vectors.forEach((vector, rowIdx) => {
          if (vector.length !== request.dimensions) {
            throw new VelrError(
              `vector embedder returned ${vector.length} dimensions for input ${rowIdx}; expected ${request.dimensions}`
            );
          }
          for (let dimIdx = 0; dimIdx < vector.length; dimIdx += 1) {
            const value = Number(vector[dimIdx]);
            if (!Number.isFinite(value)) {
              throw new VelrError(
                `vector embedder returned a non-finite value for input ${rowIdx} at dimension ${dimIdx}`
              );
            }
            output[offset] = value;
            offset += 1;
          }
        });
        Atomics.store(control, 0, 1);
      } catch (err) {
        writeSharedError(error, err instanceof Error ? err.message : String(err));
        Atomics.store(control, 0, -1);
      } finally {
        Atomics.notify(control, 0, 1);
      }
    })();
  }
}

function writeSharedError(buffer: Uint8Array, message: string): void {
  if (buffer.length === 0) return;
  buffer.fill(0);
  const bytes = Buffer.from(message, "utf8").subarray(0, Math.max(0, buffer.length - 1));
  buffer.set(bytes, 0);
}

/**
 * Async stream of result tables returned by `VelrWorker.exec()`.
 *
 * Close the stream when finished to release worker-side native resources.
 */
export class VelrWorkerStream extends WorkerHandle implements AsyncIterable<VelrWorkerTable> {
  /** Return the next result table, or `null` when the stream is exhausted. */
  async nextTable(): Promise<VelrWorkerTable | null> {
    const ref = await this.call<WorkerHandleRef | null>("stream.nextTable");
    return ref ? tableFromRef(this.rpc, ref) : null;
  }

  /** Iterate over result tables until the stream is exhausted. */
  async *[Symbol.asyncIterator](): AsyncIterator<VelrWorkerTable> {
    for (;;) {
      const table = await this.nextTable();
      if (!table) return;
      yield table;
    }
  }
}

/**
 * Async stream of result tables returned by `VelrWorkerTx.exec()`.
 *
 * Close the stream when finished to release transaction-scoped resources.
 */
export class VelrWorkerStreamTx extends WorkerHandle implements AsyncIterable<VelrWorkerTable> {
  /** Return the next transaction result table, or `null` when exhausted. */
  async nextTable(): Promise<VelrWorkerTable | null> {
    const ref = await this.call<WorkerHandleRef | null>("streamTx.nextTable");
    return ref ? tableFromRef(this.rpc, ref) : null;
  }

  /** Iterate over result tables until the stream is exhausted. */
  async *[Symbol.asyncIterator](): AsyncIterator<VelrWorkerTable> {
    for (;;) {
      const table = await this.nextTable();
      if (!table) return;
      yield table;
    }
  }
}

/**
 * Result table handle returned by worker query APIs.
 *
 * The methods mirror `Table`, but every operation crosses the worker boundary
 * and therefore returns a promise.
 */
export class VelrWorkerTable extends WorkerHandle {
  /** Return the number of columns in this table. */
  async columnCount(): Promise<number> {
    return this.call("table.columnCount");
  }

  /** Return column names in result order. */
  async columnNames(): Promise<readonly string[]> {
    return this.call("table.columnNames");
  }

  /** Open an async streaming row cursor for this table. */
  async rows(): Promise<VelrWorkerRows> {
    const ref = await this.call<WorkerHandleRef>("table.rows");
    return new VelrWorkerRows(this.rpc, ref);
  }

  /** Visit every row in order and close the row cursor afterwards. */
  async forEachRow(fn: (row: readonly Cell[], index: number) => void | Promise<void>): Promise<void> {
    const rows = await this.rows();
    try {
      let index = 0;
      for await (const row of rows) {
        await fn(row, index);
        index += 1;
      }
    } finally {
      await rows.close();
    }
  }

  /**
   * Collect all rows into an array.
   *
   * Without a mapper, each row is returned as a fresh `Cell[]`.
   */
  async collect<T = Cell[]>(map?: (row: readonly Cell[], index: number) => T | Promise<T>): Promise<T[]> {
    const rawRows = await this.call<WorkerCell[][]>("table.collect");
    const rows = workerRowsToCells(rawRows);
    const out: T[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      out.push(map ? await map(rows[i]!, i) : ([...rows[i]!] as T));
    }
    return out;
  }

  /**
   * Convert all rows into objects keyed by column name.
   *
   * Cell values are converted using `Cell.asJs(options)` in the worker.
   */
  async toObjects<T extends Record<string, unknown> = Record<string, unknown>>(
    options: CellAsJsOptions = {}
  ): Promise<T[]> {
    return this.call<T[]>("table.toObjects", { options });
  }

  /** Export this table as an Arrow IPC file/Feather v2 buffer. */
  async toArrowIpc(): Promise<Buffer> {
    return workerBufferToBuffer(await this.call<Uint8Array>("table.toArrowIpc"));
  }

  /**
   * Convert this table to an Apache Arrow table.
   *
   * Requires the optional `apache-arrow` peer dependency in the caller process.
   */
  async toArrowTable(): Promise<unknown> {
    const arrow = await import("apache-arrow");
    const tableFromIPC = (arrow as any).tableFromIPC;
    if (typeof tableFromIPC !== "function") {
      throw new VelrError("installed apache-arrow package does not expose tableFromIPC()");
    }
    return tableFromIPC(await this.toArrowIpc());
  }
}

/** Async row cursor for a `VelrWorkerTable`. */
export class VelrWorkerRows extends WorkerHandle implements AsyncIterable<Cell[]> {
  /** Return the next row, or `null` when the cursor is exhausted. */
  async next(): Promise<Cell[] | null> {
    const row = await this.call<WorkerCell[] | null>("rows.next");
    return row ? row.map(workerCellToCell) : null;
  }

  /** Iterate over rows until the cursor is exhausted. */
  async *[Symbol.asyncIterator](): AsyncIterator<Cell[]> {
    for (;;) {
      const row = await this.next();
      if (!row) return;
      yield row;
    }
  }
}

/**
 * Worker-backed explain or explain-analyze trace.
 *
 * Use indexed methods for lazy access or `snapshot()` to copy the full trace
 * into plain JavaScript objects.
 */
export class VelrWorkerExplainTrace extends WorkerHandle {
  /** Return the number of plans in this trace. */
  async planCount(): Promise<number> {
    return this.call("trace.planCount");
  }

  /** Return metadata for a plan by zero-based plan index. */
  async planMeta(planIdx: number): Promise<ExplainPlanMeta> {
    return this.call("trace.planMeta", { planIdx });
  }

  /** Return the number of steps in a plan. */
  async stepCount(planIdx: number): Promise<number> {
    return this.call("trace.stepCount", { planIdx });
  }

  /** Return metadata for a step by zero-based plan and step indexes. */
  async stepMeta(planIdx: number, stepIdx: number): Promise<ExplainStepMeta> {
    return this.call("trace.stepMeta", { planIdx, stepIdx });
  }

  /** Return the number of SQL statements attached to a step. */
  async statementCount(planIdx: number, stepIdx: number): Promise<number> {
    return this.call("trace.statementCount", { planIdx, stepIdx });
  }

  /** Return metadata for a SQL statement by zero-based indexes. */
  async statementMeta(
    planIdx: number,
    stepIdx: number,
    stmtIdx: number
  ): Promise<ExplainStatementMeta> {
    return this.call("trace.statementMeta", { planIdx, stepIdx, stmtIdx });
  }

  /** Return one SQLite plan-detail row for a SQL statement. */
  async sqlitePlanDetail(
    planIdx: number,
    stepIdx: number,
    stmtIdx: number,
    detailIdx: number
  ): Promise<string> {
    return this.call("trace.sqlitePlanDetail", { planIdx, stepIdx, stmtIdx, detailIdx });
  }

  /** Copy the full trace into plain JavaScript objects. */
  async snapshot(): Promise<ExplainPlan[]> {
    return this.call("trace.snapshot");
  }

  /** Render the trace using Velr's compact human-readable format. */
  async toCompactString(): Promise<string> {
    return this.call("trace.toCompactString");
  }
}

/**
 * Explicit transaction running inside a Velr worker.
 *
 * Create transactions with `VelrWorker.beginTx()` or `VelrWorker.transaction()`.
 */
export class VelrWorkerTx extends WorkerHandle {
  /** Execute Cypher inside this transaction and return an async stream of result tables. */
  async exec(cypher: string, options?: QueryOptions): Promise<VelrWorkerStreamTx> {
    const ref = await this.call<WorkerHandleRef>("tx.exec", { cypher, options });
    return new VelrWorkerStreamTx(this.rpc, ref);
  }

  /**
   * Execute Cypher inside this transaction and return exactly one result table.
   *
   * The promise rejects when the statement produces no tables or multiple
   * tables.
   */
  async execOne(cypher: string, options?: QueryOptions): Promise<VelrWorkerTable> {
    const ref = await this.call<WorkerHandleRef>("tx.execOne", { cypher, options });
    return tableFromRef(this.rpc, ref);
  }

  /** Execute Cypher inside this transaction and discard all result tables. */
  async run(cypher: string, options?: QueryOptions): Promise<void> {
    await this.call("tx.run", { cypher, options });
  }

  /** Alias for `run()`. */
  async execute(cypher: string, options?: QueryOptions): Promise<void> {
    await this.run(cypher, options);
  }

  /**
   * Bind an Arrow IPC file/Feather v2 payload for use inside this transaction.
   *
   * The binding follows transaction visibility and disappears when the
   * transaction ends.
   */
  async bindArrowIpc(logical: string, ipcBytes: Buffer | Uint8Array): Promise<void> {
    await this.call("tx.bindArrowIpc", {
      logical,
      ipcBytes: arrowIpcPayload(ipcBytes)
    });
  }

  /**
   * Execute Cypher inside this transaction and convert one result table into objects.
   */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    cypher: string,
    options?: QueryOptions & CellAsJsOptions
  ): Promise<T[]> {
    return this.call<T[]>("tx.query", { cypher, options });
  }

  /** Build an explain trace inside this transaction without executing the query. */
  async explain(cypher: string): Promise<VelrWorkerExplainTrace> {
    const ref = await this.call<WorkerHandleRef>("tx.explain", { cypher });
    return traceFromRef(this.rpc, ref);
  }

  /** Execute the query inside this transaction and return an analyzed explain trace. */
  async explainAnalyze(cypher: string): Promise<VelrWorkerExplainTrace> {
    const ref = await this.call<WorkerHandleRef>("tx.explainAnalyze", { cypher });
    return traceFromRef(this.rpc, ref);
  }

  /** Create an anonymous savepoint. */
  async savepoint(): Promise<VelrWorkerSavepoint> {
    const ref = await this.call<WorkerHandleRef>("tx.savepoint");
    return new VelrWorkerSavepoint(this.rpc, ref);
  }

  /**
   * Run a function inside an anonymous savepoint.
   *
   * The savepoint is released when `fn` resolves and rolled back when `fn`
   * rejects, unless the callback already consumed it.
   */
  async withSavepoint<T>(
    fn: (savepoint: VelrWorkerSavepoint) => T | Promise<T>
  ): Promise<T> {
    const savepoint = await this.savepoint();
    let completed = false;
    try {
      const result = await fn(savepoint);
      if (!savepoint.closed) await savepoint.release();
      completed = true;
      return result;
    } finally {
      if (!completed && !savepoint.closed) await savepoint.rollback();
    }
  }

  /**
   * Create a named savepoint.
   *
   * Named savepoints are stack-like: only the newest named savepoint can be
   * released directly. `rollbackTo(name)` retains the named target and removes
   * newer named savepoints.
   */
  async savepointNamed(name: string): Promise<VelrWorkerSavepoint> {
    const ref = await this.call<WorkerHandleRef>("tx.savepointNamed", { name });
    return new VelrWorkerSavepoint(this.rpc, ref);
  }

  /**
   * Run a function inside a named savepoint.
   *
   * The savepoint is released on success and rolled back on failure, unless the
   * callback already consumed it.
   */
  async withSavepointNamed<T>(
    name: string,
    fn: (savepoint: VelrWorkerSavepoint) => T | Promise<T>
  ): Promise<T> {
    const savepoint = await this.savepointNamed(name);
    let completed = false;
    try {
      const result = await fn(savepoint);
      if (!savepoint.closed) await savepoint.release();
      completed = true;
      return result;
    } finally {
      if (!completed && !savepoint.closed) await savepoint.rollback();
    }
  }

  /**
   * Roll back to a named savepoint and keep that savepoint active.
   *
   * Newer named savepoints are invalidated.
   */
  async rollbackTo(name: string): Promise<void> {
    await this.call("tx.rollbackTo", { name });
  }

  /** Release the newest active named savepoint with `name`. */
  async releaseSavepoint(name: string): Promise<void> {
    await this.call("tx.releaseSavepoint", { name });
  }

  /** Commit the transaction and close the transaction handle. */
  async commit(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.rpc.call("tx.commit", { handle: this.ref.id });
  }

  /** Roll back the transaction and close the transaction handle. */
  async rollback(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.rpc.call("tx.rollback", { handle: this.ref.id });
  }
}

/**
 * Worker-backed transaction savepoint handle.
 *
 * Release to keep changes after the savepoint, or roll back to undo them.
 */
export class VelrWorkerSavepoint extends WorkerHandle {
  /** Savepoint name, or `null` for anonymous savepoints. */
  readonly name: string | null;

  /** @internal Savepoints are created by transaction methods. */
  constructor(rpc: WorkerRpc, ref: WorkerHandleRef) {
    super(rpc, ref);
    this.name = ref.name ?? null;
  }

  /** Release this savepoint and keep changes made after it. */
  async release(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.rpc.call("savepoint.release", { handle: this.ref.id });
  }

  /** Roll back changes made after this savepoint and consume the handle. */
  async rollback(): Promise<void> {
    if (this.closed) return;
    this.markClosed();
    await this.rpc.call("savepoint.rollback", { handle: this.ref.id });
  }
}
