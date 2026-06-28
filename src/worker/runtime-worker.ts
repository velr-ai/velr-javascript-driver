import { parentPort } from "node:worker_threads";

import {
  Cell,
  ExplainTrace,
  Rows,
  Savepoint,
  Stream,
  StreamTx,
  Table,
  Velr,
  VelrTx
} from "../driver.js";
import type { VectorEmbedder, VectorEmbedding } from "../types.js";

type HandleKind = "stream" | "streamTx" | "table" | "rows" | "trace" | "tx" | "savepoint";
type HandleValue = Stream | StreamTx | Table | Rows | ExplainTrace | VelrTx | Savepoint;

interface HandleEntry {
  readonly id: string;
  readonly kind: HandleKind;
  readonly value: HandleValue;
  readonly parent: string | null;
  readonly children: Set<string>;
}

interface RequestMessage {
  readonly id: string;
  readonly op: string;
  readonly payload?: any;
}

let db: Velr | null = null;
let nextHandleId = 0;
let nextEmbedRequestId = 0;
const handles = new Map<string, HandleEntry>();

if (!parentPort) {
  throw new Error("Velr worker must be started as a worker thread");
}

function requireDb(): Velr {
  if (!db) throw new Error("Velr worker database is not open");
  return db;
}

function addHandle(kind: HandleKind, value: HandleValue, parent: string | null = null) {
  const id = `${kind}:${(nextHandleId += 1).toString(36)}`;
  const entry: HandleEntry = { id, kind, value, parent, children: new Set() };
  handles.set(id, entry);
  if (parent) handles.get(parent)?.children.add(id);
  return handleRef(entry);
}

function handleRef(entry: HandleEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.value instanceof Savepoint ? entry.value.name : undefined
  };
}

function getHandle<T extends HandleValue>(id: string, kind?: HandleKind): T {
  const entry = handles.get(id);
  if (!entry) throw new Error(`Velr worker handle '${id}' is closed or unknown`);
  if (kind && entry.kind !== kind) {
    throw new Error(`Velr worker handle '${id}' is ${entry.kind}, not ${kind}`);
  }
  return entry.value as T;
}

function getEntry(id: string): HandleEntry {
  const entry = handles.get(id);
  if (!entry) throw new Error(`Velr worker handle '${id}' is closed or unknown`);
  return entry;
}

function removeTree(id: string): void {
  const entry = handles.get(id);
  if (!entry) return;
  for (const child of [...entry.children]) removeTree(child);
  if (entry.parent) handles.get(entry.parent)?.children.delete(id);
  handles.delete(id);
}

function closeHandle(id: string): void {
  const entry = handles.get(id);
  if (!entry) return;
  entry.value.close();
  removeTree(id);
}

function pruneClosedSavepoints(parent: string): void {
  const entry = handles.get(parent);
  if (!entry) return;
  for (const child of [...entry.children]) {
    const childEntry = handles.get(child);
    if (childEntry?.kind === "savepoint" && childEntry.value instanceof Savepoint) {
      if (childEntry.value.closed) removeTree(child);
    }
  }
}

function closeDb(): void {
  db?.close();
  db = null;
  handles.clear();
}

function cellToWire(cell: Cell) {
  return {
    type: cell.type,
    i64: cell.i64,
    f64: cell.f64,
    data: cell.asBuffer()
  };
}

function rowsToWire(rows: readonly (readonly Cell[])[]) {
  return rows.map((row) => row.map(cellToWire));
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: "code" in err && typeof err.code === "number" ? err.code : undefined,
      stack: err.stack
    };
  }
  return { name: "Error", message: String(err) };
}

function bridgeEmbedder(embedderId: string): VectorEmbedder {
  return (inputs) => {
    const inputCount = inputs.length;
    const dimensions = inputs[0]?.dimensions ?? 0;
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const output = new SharedArrayBuffer(
      Float32Array.BYTES_PER_ELEMENT * inputCount * dimensions
    );
    const error = new SharedArrayBuffer(8192);
    const status = new Int32Array(control);

    parentPort!.postMessage({
      type: "velr.embed",
      requestId: `embed:${(nextEmbedRequestId += 1).toString(36)}`,
      embedderId,
      inputs,
      dimensions,
      control,
      output,
      error
    });

    const waitResult = Atomics.wait(status, 0, 0);
    if (waitResult !== "ok" && waitResult !== "not-equal") {
      throw new Error(`worker vector embedder wait failed: ${waitResult}`);
    }
    if (Atomics.load(status, 0) !== 1) {
      throw new Error(readSharedError(new Uint8Array(error)));
    }

    const flat = new Float32Array(output);
    const vectors: VectorEmbedding[] = [];
    for (let row = 0; row < inputCount; row += 1) {
      const start = row * dimensions;
      const end = start + dimensions;
      vectors.push(new Float32Array(flat.slice(start, end)));
    }
    return vectors;
  };
}

function readSharedError(buffer: Uint8Array): string {
  const end = buffer.indexOf(0);
  const slice = end >= 0 ? buffer.subarray(0, end) : buffer;
  const message = Buffer.from(slice).toString("utf8");
  return message || "worker vector embedder failed";
}

function parentOf(handleId: string): string {
  getEntry(handleId);
  return handleId;
}

function dispatch(op: string, payload: any): unknown {
  switch (op) {
    case "db.open":
      closeDb();
      db = Velr.open(payload.path ?? null);
      return null;
    case "db.openReadonly":
      closeDb();
      db = Velr.openReadonly(payload.path);
      return null;
    case "db.schemaVersion":
      return requireDb().schemaVersion();
    case "db.currentSchemaVersion":
      return requireDb().currentSchemaVersion();
    case "db.needsMigration":
      return requireDb().needsMigration();
    case "db.migrate":
      return requireDb().migrate();
    case "db.registerVectorEmbedderBridge":
      requireDb().registerVectorEmbedder(payload.name, bridgeEmbedder(payload.embedderId));
      return null;
    case "db.exec":
      return addHandle("stream", requireDb().exec(payload.cypher, payload.options));
    case "db.execOne":
      return addHandle("table", requireDb().execOne(payload.cypher, payload.options));
    case "db.run":
      requireDb().run(payload.cypher, payload.options);
      return null;
    case "db.bindArrowIpc":
      requireDb().bindArrowIpc(payload.logical, payload.ipcBytes);
      return null;
    case "db.query":
      return requireDb().query(payload.cypher, payload.options);
    case "db.explain":
      return addHandle("trace", requireDb().explain(payload.cypher));
    case "db.explainAnalyze":
      return addHandle("trace", requireDb().explainAnalyze(payload.cypher));
    case "db.beginTx":
      return addHandle("tx", requireDb().beginTx());
    case "db.close":
      closeDb();
      return null;
    case "handle.close":
      closeHandle(payload.handle);
      return null;
    default:
      return dispatchHandle(op, payload);
  }
}

function dispatchHandle(op: string, payload: any): unknown {
  const handle = String(payload.handle);

  switch (op) {
    case "stream.nextTable": {
      const table = getHandle<Stream>(handle, "stream").nextTable();
      return table ? addHandle("table", table, parentOf(handle)) : null;
    }
    case "streamTx.nextTable": {
      const table = getHandle<StreamTx>(handle, "streamTx").nextTable();
      return table ? addHandle("table", table, parentOf(handle)) : null;
    }
    case "table.columnCount":
      return getHandle<Table>(handle, "table").columnCount();
    case "table.columnNames":
      return getHandle<Table>(handle, "table").columnNames();
    case "table.rows":
      return addHandle("rows", getHandle<Table>(handle, "table").rows(), parentOf(handle));
    case "table.collect":
      return rowsToWire(getHandle<Table>(handle, "table").collect());
    case "table.toObjects":
      return getHandle<Table>(handle, "table").toObjects(payload.options);
    case "table.toArrowIpc":
      return getHandle<Table>(handle, "table").toArrowIpc();
    case "rows.next": {
      const row = getHandle<Rows>(handle, "rows").next();
      return row ? row.map(cellToWire) : null;
    }
    case "trace.planCount":
      return getHandle<ExplainTrace>(handle, "trace").planCount();
    case "trace.planMeta":
      return getHandle<ExplainTrace>(handle, "trace").planMeta(payload.planIdx);
    case "trace.stepCount":
      return getHandle<ExplainTrace>(handle, "trace").stepCount(payload.planIdx);
    case "trace.stepMeta":
      return getHandle<ExplainTrace>(handle, "trace").stepMeta(payload.planIdx, payload.stepIdx);
    case "trace.statementCount":
      return getHandle<ExplainTrace>(handle, "trace").statementCount(payload.planIdx, payload.stepIdx);
    case "trace.statementMeta":
      return getHandle<ExplainTrace>(handle, "trace").statementMeta(
        payload.planIdx,
        payload.stepIdx,
        payload.stmtIdx
      );
    case "trace.sqlitePlanDetail":
      return getHandle<ExplainTrace>(handle, "trace").sqlitePlanDetail(
        payload.planIdx,
        payload.stepIdx,
        payload.stmtIdx,
        payload.detailIdx
      );
    case "trace.snapshot":
      return getHandle<ExplainTrace>(handle, "trace").snapshot();
    case "trace.toCompactString":
      return getHandle<ExplainTrace>(handle, "trace").toCompactString();
    case "tx.exec":
      return addHandle("streamTx", getHandle<VelrTx>(handle, "tx").exec(payload.cypher, payload.options), parentOf(handle));
    case "tx.execOne":
      return addHandle("table", getHandle<VelrTx>(handle, "tx").execOne(payload.cypher, payload.options), parentOf(handle));
    case "tx.run":
      getHandle<VelrTx>(handle, "tx").run(payload.cypher, payload.options);
      return null;
    case "tx.bindArrowIpc":
      getHandle<VelrTx>(handle, "tx").bindArrowIpc(payload.logical, payload.ipcBytes);
      return null;
    case "tx.query":
      return getHandle<VelrTx>(handle, "tx").query(payload.cypher, payload.options);
    case "tx.explain":
      return addHandle("trace", getHandle<VelrTx>(handle, "tx").explain(payload.cypher), parentOf(handle));
    case "tx.explainAnalyze":
      return addHandle(
        "trace",
        getHandle<VelrTx>(handle, "tx").explainAnalyze(payload.cypher),
        parentOf(handle)
      );
    case "tx.savepoint":
      return addHandle("savepoint", getHandle<VelrTx>(handle, "tx").savepoint(), parentOf(handle));
    case "tx.savepointNamed":
      return addHandle("savepoint", getHandle<VelrTx>(handle, "tx").savepointNamed(payload.name), parentOf(handle));
    case "tx.rollbackTo":
      getHandle<VelrTx>(handle, "tx").rollbackTo(payload.name);
      pruneClosedSavepoints(handle);
      return null;
    case "tx.releaseSavepoint":
      getHandle<VelrTx>(handle, "tx").releaseSavepoint(payload.name);
      pruneClosedSavepoints(handle);
      return null;
    case "tx.commit":
      getHandle<VelrTx>(handle, "tx").commit();
      removeTree(handle);
      return null;
    case "tx.rollback":
      getHandle<VelrTx>(handle, "tx").rollback();
      removeTree(handle);
      return null;
    case "savepoint.release":
      getHandle<Savepoint>(handle, "savepoint").release();
      removeTree(handle);
      return null;
    case "savepoint.rollback":
      getHandle<Savepoint>(handle, "savepoint").rollback();
      removeTree(handle);
      return null;
    default:
      throw new Error(`Unknown Velr worker operation '${op}'`);
  }
}

parentPort.on("message", (message: RequestMessage) => {
  const { id, op, payload } = message;
  try {
    const result = dispatch(op, payload ?? {});
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: serializeError(err) });
  }
});
