import koffi from "koffi";

import { VelrError, VelrTypeError } from "../errors.js";
import { resolveRuntime, type RuntimeResolution } from "../runtime/resolve.js";
import type {
  QueryParams,
  QueryValue,
  VectorEmbedder,
  VectorEmbeddingField,
  VectorEmbeddingInput,
  VectorPropertyValueType
} from "../types.js";

export type NativePointer = bigint | null;

export const enum VelrCode {
  OK = 0,
  EARG = -1,
  EUTF = -2,
  ESTATE = -3,
  EERR = -4
}

export const enum CellKind {
  Null = 0,
  Bool = 1,
  Int64 = 2,
  Double = 3,
  Text = 4,
  Json = 5
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

const enum StorageValueKind {
  Null = 0,
  Int64 = 1,
  Double = 2,
  Text = 3,
  Blob = 4
}

interface NativeLib {
  readonly velr_string_free: (ptr: NativePointer) => void;
  readonly velr_free: (ptr: NativePointer, len: number | bigint) => void;
  readonly velr_open: (path: string | null, outDb: NativePointer[], outErr: NativePointer[]) => number;
  readonly velr_open_existing_readonly?: (
    path: string,
    outDb: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_close: (db: NativePointer) => void;
  readonly velr_register_vector_embedder?: (
    db: NativePointer,
    name: StrView,
    callback: NativePointer,
    userData: NativePointer,
    freeUserData: NativePointer,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_new: () => NativePointer;
  readonly velr_query_params_free: (params: NativePointer) => void;
  readonly velr_query_params_set_null: (
    params: NativePointer,
    name: StrView,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_bool: (
    params: NativePointer,
    name: StrView,
    value: number,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_i64: (
    params: NativePointer,
    name: StrView,
    value: bigint,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_f64: (
    params: NativePointer,
    name: StrView,
    value: number,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_text: (
    params: NativePointer,
    name: StrView,
    value: StrView,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_json: (
    params: NativePointer,
    name: StrView,
    json: StrView,
    outErr: NativePointer[]
  ) => number;
  readonly velr_schema_version: (
    db: NativePointer,
    outVersion: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_current_schema_version: (
    db: NativePointer,
    outVersion: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_needs_migration: (
    db: NativePointer,
    outNeedsMigration: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_migrate: (
    db: NativePointer,
    outReport: MigrationReportRaw,
    outErr: NativePointer[]
  ) => number;
  readonly velr_migration_report_clear: (report: MigrationReportRaw) => void;
  readonly velr_exec_start: (
    db: NativePointer,
    cypher: string,
    outStream: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_exec_start_with_options?: (
    db: NativePointer,
    cypher: string,
    opts: QueryOptionsRaw,
    outStream: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_exec_one: (
    db: NativePointer,
    cypher: string,
    outTable: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_exec_one_with_options?: (
    db: NativePointer,
    cypher: string,
    opts: QueryOptionsRaw,
    outTable: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_stream_next_table: (
    stream: NativePointer,
    outTable: NativePointer[],
    outHas: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_exec_close: (stream: NativePointer) => void;
  readonly velr_explain: (
    db: NativePointer,
    cypher: string,
    outExplain: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_explain_analyze: (
    db: NativePointer,
    cypher: string,
    outExplain: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_explain: (
    tx: NativePointer,
    cypher: string,
    outExplain: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_explain_analyze: (
    tx: NativePointer,
    cypher: string,
    outExplain: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_explain_trace_close: (trace: NativePointer) => void;
  readonly velr_explain_trace_plan_count: (trace: NativePointer) => number | bigint;
  readonly velr_explain_trace_plan_meta: (
    trace: NativePointer,
    planIdx: number,
    outMeta: ExplainPlanMetaRaw
  ) => number;
  readonly velr_explain_trace_step_count: (
    trace: NativePointer,
    planIdx: number
  ) => number | bigint;
  readonly velr_explain_trace_step_meta: (
    trace: NativePointer,
    planIdx: number,
    stepIdx: number,
    outMeta: ExplainStepMetaRaw
  ) => number;
  readonly velr_explain_trace_statement_count: (
    trace: NativePointer,
    planIdx: number,
    stepIdx: number
  ) => number | bigint;
  readonly velr_explain_trace_statement_meta: (
    trace: NativePointer,
    planIdx: number,
    stepIdx: number,
    stmtIdx: number,
    outMeta: ExplainStatementMetaRaw
  ) => number;
  readonly velr_explain_trace_sqlite_plan_count: (
    trace: NativePointer,
    planIdx: number,
    stepIdx: number,
    stmtIdx: number
  ) => number | bigint;
  readonly velr_explain_trace_sqlite_plan_detail: (
    trace: NativePointer,
    planIdx: number,
    stepIdx: number,
    stmtIdx: number,
    detailIdx: number,
    outDetail: StrView
  ) => number;
  readonly velr_explain_trace_compact_malloc?: (
    trace: NativePointer,
    outPtr: NativePointer[],
    outLen: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_table_close: (table: NativePointer) => void;
  readonly velr_table_column_count: (table: NativePointer) => number | bigint;
  readonly velr_table_column_name: (
    table: NativePointer,
    index: number,
    outPtr: NativePointer[],
    outLen: number[],
  ) => number;
  readonly velr_table_rows_open: (
    table: NativePointer,
    outRows: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_rows_next: (
    rows: NativePointer,
    cells: Buffer,
    cellCount: number,
    outWritten: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_rows_close: (rows: NativePointer) => void;
  readonly velr_tx_begin: (
    db: NativePointer,
    outTx: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_commit: (tx: NativePointer, outErr: NativePointer[]) => number;
  readonly velr_tx_rollback: (tx: NativePointer, outErr: NativePointer[]) => number;
  readonly velr_tx_close: (tx: NativePointer) => void;
  readonly velr_tx_exec_start: (
    tx: NativePointer,
    cypher: string,
    outStream: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_exec_start_with_options?: (
    tx: NativePointer,
    cypher: string,
    opts: QueryOptionsRaw,
    outStream: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_stream_tx_next_table: (
    stream: NativePointer,
    outTable: NativePointer[],
    outHas: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_exec_tx_close: (stream: NativePointer) => void;
  readonly velr_tx_savepoint: (
    tx: NativePointer,
    outSavepoint: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_sp_release: (savepoint: NativePointer, outErr: NativePointer[]) => number;
  readonly velr_sp_rollback: (savepoint: NativePointer, outErr: NativePointer[]) => number;
  readonly velr_sp_close: (savepoint: NativePointer) => void;
  readonly velr_tx_savepoint_named?: (
    tx: NativePointer,
    name: string,
    outSavepoint: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_rollback_to?: (
    tx: NativePointer,
    name: string,
    outErr: NativePointer[]
  ) => number;
  readonly velr_table_ipc_file_malloc?: (
    table: NativePointer,
    outPtr: NativePointer[],
    outLen: number[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_bind_arrow_ipc?: (
    db: NativePointer,
    logical: string,
    ipcPtr: Buffer,
    ipcLen: number,
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_bind_arrow_ipc?: (
    tx: NativePointer,
    logical: string,
    ipcPtr: Buffer,
    ipcLen: number,
    outErr: NativePointer[]
  ) => number;
}

export interface NativeBindings {
  readonly lib: NativeLib;
  readonly resolution: RuntimeResolution;
  readonly types: {
    readonly cell: any;
    readonly queryOptions: any;
    readonly migrationReport: any;
    readonly explainPlanMeta: any;
    readonly explainStepMeta: any;
    readonly explainStatementMeta: any;
    readonly strView: any;
    readonly vectorEmbeddingField: any;
    readonly vectorEmbeddingInput: any;
    readonly vectorEmbedderCallback: any;
  };
  readonly cellSize: number;
}

export interface StrView {
  ptr?: Buffer | NativePointer;
  len: number | bigint;
}

export interface QueryOptionsRaw {
  has_max_result_rows: number;
  max_result_rows: number;
  params: NativePointer;
}

export interface MigrationReportRaw {
  from_version?: number;
  to_version?: number;
  status?: number;
  step_count?: number | bigint;
  steps?: NativePointer;
}

export interface ExplainPlanMetaRaw {
  plan_id?: StrView;
  cypher?: StrView;
  step_count?: number | bigint;
}

export interface ExplainStepMetaRaw {
  step_no?: number | bigint;
  group_id?: StrView;
  op_index?: StrView;
  phase?: StrView;
  title?: StrView;
  source?: StrView;
  note?: StrView;
  statement_count?: number | bigint;
}

export interface ExplainStatementMetaRaw {
  stmt_id?: StrView;
  kind?: StrView;
  sql?: StrView;
  note?: StrView;
  sqlite_plan_count?: number | bigint;
}

let bindings: NativeBindings | null = null;

export function getBindings(): NativeBindings {
  bindings ??= createBindings(resolveRuntime());
  return bindings;
}

function createBindings(resolution: RuntimeResolution): NativeBindings {
  const native = koffi.load(resolution.libraryPath);

  koffi.alias("velr_code", "int");
  koffi.alias("velr_cell_type", "int");
  koffi.alias("velr_migration_status", "int");
  koffi.alias("velr_vector_embedding_purpose", "int");
  koffi.alias("velr_vector_entity_kind", "int");
  koffi.alias("velr_property_value_type", "int");
  koffi.alias("velr_storage_value_type", "int");

  const velrDb = koffi.opaque("velr_db");
  const velrStream = koffi.opaque("velr_stream");
  const velrTable = koffi.opaque("velr_table");
  const velrRows = koffi.opaque("velr_rows");
  const velrTx = koffi.opaque("velr_tx");
  const velrSavepoint = koffi.opaque("velr_sp");
  const velrStreamTx = koffi.opaque("velr_stream_tx");
  const velrExplainTrace = koffi.opaque("velr_explain_trace");
  const velrQueryParams = koffi.opaque("velr_query_params");

  void velrDb;
  void velrStream;
  void velrTable;
  void velrRows;
  void velrTx;
  void velrSavepoint;
  void velrStreamTx;
  void velrExplainTrace;
  void velrQueryParams;

  const strView = koffi.struct("velr_strview", {
    ptr: "void *",
    len: "size_t"
  });

  const cell = koffi.struct("velr_cell", {
    ty: "int",
    i64_: "int64_t",
    f64_: "double",
    ptr: "void *",
    len: "size_t"
  });

  const queryOptions = koffi.struct("velr_query_options", {
    has_max_result_rows: "int",
    max_result_rows: "size_t",
    params: "velr_query_params *"
  });

  const migrationReport = koffi.struct("velr_migration_report", {
    from_version: "int32_t",
    to_version: "int32_t",
    status: "int",
    step_count: "size_t",
    steps: "void *"
  });

  const vectorEmbeddingField = koffi.struct("velr_vector_embedding_field", {
    has_name: "int",
    name: strView,
    value_type: "int",
    storage_type: "int",
    i64_: "int64_t",
    f64_: "double",
    bytes: strView,
    json: strView,
    display: strView
  });

  const vectorEmbeddingInput = koffi.struct("velr_vector_embedding_input", {
    index_name: strView,
    dimensions: "size_t",
    purpose: "int",
    entity_kind: "int",
    has_entity_id: "int",
    entity_id: "int64_t",
    fields: "velr_vector_embedding_field *",
    field_count: "size_t"
  });

  const explainPlanMeta = koffi.struct("velr_explain_plan_meta", {
    plan_id: strView,
    cypher: strView,
    step_count: "size_t"
  });

  const explainStepMeta = koffi.struct("velr_explain_step_meta", {
    step_no: "size_t",
    group_id: strView,
    op_index: strView,
    phase: strView,
    title: strView,
    source: strView,
    note: strView,
    statement_count: "size_t"
  });

  const explainStatementMeta = koffi.struct("velr_explain_stmt_meta", {
    stmt_id: strView,
    kind: strView,
    sql: strView,
    note: strView,
    sqlite_plan_count: "size_t"
  });

  const vectorEmbedderCallback = koffi.proto(
    "velr_code velr_vector_embedder_callback(void *user_data, const velr_vector_embedding_input *inputs, size_t input_count, size_t dimensions, float *out_vectors, char *err_buf, size_t err_buf_len)"
  );

  const required = (prototype: string) => native.func(prototype);
  const optional = (prototype: string) => {
    try {
      return native.func(prototype);
    } catch {
      return undefined;
    }
  };

  const lib: NativeLib = {
    velr_string_free: required("void velr_string_free(void *s)"),
    velr_free: required("void velr_free(void *p, size_t len)"),
    velr_open: required("velr_code velr_open(const char *path_or_null, _Out_ velr_db **out_db, _Out_ void **out_err)"),
    velr_open_existing_readonly: optional("velr_code velr_open_existing_readonly(const char *path, _Out_ velr_db **out_db, _Out_ void **out_err)"),
    velr_close: required("void velr_close(velr_db *db)"),
    velr_register_vector_embedder: optional("velr_code velr_register_vector_embedder(velr_db *db, velr_strview name, velr_vector_embedder_callback *callback, void *user_data, void *free_user_data, _Out_ void **out_err)"),
    velr_query_params_new: required("velr_query_params *velr_query_params_new(void)"),
    velr_query_params_free: required("void velr_query_params_free(velr_query_params *params)"),
    velr_query_params_set_null: required("velr_code velr_query_params_set_null(velr_query_params *params, velr_strview name, _Out_ void **out_err)"),
    velr_query_params_set_bool: required("velr_code velr_query_params_set_bool(velr_query_params *params, velr_strview name, int value, _Out_ void **out_err)"),
    velr_query_params_set_i64: required("velr_code velr_query_params_set_i64(velr_query_params *params, velr_strview name, int64_t value, _Out_ void **out_err)"),
    velr_query_params_set_f64: required("velr_code velr_query_params_set_f64(velr_query_params *params, velr_strview name, double value, _Out_ void **out_err)"),
    velr_query_params_set_text: required("velr_code velr_query_params_set_text(velr_query_params *params, velr_strview name, velr_strview value, _Out_ void **out_err)"),
    velr_query_params_set_json: required("velr_code velr_query_params_set_json(velr_query_params *params, velr_strview name, velr_strview json_value, _Out_ void **out_err)"),
    velr_schema_version: required("velr_code velr_schema_version(velr_db *db, _Out_ int32_t *out_version, _Out_ void **out_err)"),
    velr_current_schema_version: required("velr_code velr_current_schema_version(velr_db *db, _Out_ int32_t *out_version, _Out_ void **out_err)"),
    velr_needs_migration: required("velr_code velr_needs_migration(velr_db *db, _Out_ int *out_needs_migration, _Out_ void **out_err)"),
    velr_migrate: required("velr_code velr_migrate(velr_db *db, _Out_ velr_migration_report *out_report, _Out_ void **out_err)"),
    velr_migration_report_clear: required("void velr_migration_report_clear(_Inout_ velr_migration_report *report)"),
    velr_exec_start: required("velr_code velr_exec_start(velr_db *db, const char *cypher, _Out_ velr_stream **out_stream, _Out_ void **out_err)"),
    velr_exec_start_with_options: optional("velr_code velr_exec_start_with_options(velr_db *db, const char *cypher, const velr_query_options *opts, _Out_ velr_stream **out_stream, _Out_ void **out_err)"),
    velr_exec_one: required("velr_code velr_exec_one(velr_db *db, const char *cypher, _Out_ velr_table **out_table, _Out_ void **out_err)"),
    velr_exec_one_with_options: optional("velr_code velr_exec_one_with_options(velr_db *db, const char *cypher, const velr_query_options *opts, _Out_ velr_table **out_table, _Out_ void **out_err)"),
    velr_stream_next_table: required("velr_code velr_stream_next_table(velr_stream *stream, _Out_ velr_table **out_table, _Out_ int *out_has, _Out_ void **out_err)"),
    velr_exec_close: required("void velr_exec_close(velr_stream *stream)"),
    velr_explain: required("velr_code velr_explain(velr_db *db, const char *cypher, _Out_ velr_explain_trace **out_explain, _Out_ void **out_err)"),
    velr_explain_analyze: required("velr_code velr_explain_analyze(velr_db *db, const char *cypher, _Out_ velr_explain_trace **out_explain, _Out_ void **out_err)"),
    velr_tx_explain: required("velr_code velr_tx_explain(velr_tx *tx, const char *cypher, _Out_ velr_explain_trace **out_explain, _Out_ void **out_err)"),
    velr_tx_explain_analyze: required("velr_code velr_tx_explain_analyze(velr_tx *tx, const char *cypher, _Out_ velr_explain_trace **out_explain, _Out_ void **out_err)"),
    velr_explain_trace_close: required("void velr_explain_trace_close(velr_explain_trace *xp)"),
    velr_explain_trace_plan_count: required("size_t velr_explain_trace_plan_count(velr_explain_trace *xp)"),
    velr_explain_trace_plan_meta: required("velr_code velr_explain_trace_plan_meta(velr_explain_trace *xp, size_t plan_idx, _Out_ velr_explain_plan_meta *out_meta)"),
    velr_explain_trace_step_count: required("size_t velr_explain_trace_step_count(velr_explain_trace *xp, size_t plan_idx)"),
    velr_explain_trace_step_meta: required("velr_code velr_explain_trace_step_meta(velr_explain_trace *xp, size_t plan_idx, size_t step_idx, _Out_ velr_explain_step_meta *out_meta)"),
    velr_explain_trace_statement_count: required("size_t velr_explain_trace_statement_count(velr_explain_trace *xp, size_t plan_idx, size_t step_idx)"),
    velr_explain_trace_statement_meta: required("velr_code velr_explain_trace_statement_meta(velr_explain_trace *xp, size_t plan_idx, size_t step_idx, size_t stmt_idx, _Out_ velr_explain_stmt_meta *out_meta)"),
    velr_explain_trace_sqlite_plan_count: required("size_t velr_explain_trace_sqlite_plan_count(velr_explain_trace *xp, size_t plan_idx, size_t step_idx, size_t stmt_idx)"),
    velr_explain_trace_sqlite_plan_detail: required("velr_code velr_explain_trace_sqlite_plan_detail(velr_explain_trace *xp, size_t plan_idx, size_t step_idx, size_t stmt_idx, size_t detail_idx, _Out_ velr_strview *out_detail)"),
    velr_explain_trace_compact_malloc: optional("velr_code velr_explain_trace_compact_malloc(velr_explain_trace *xp, _Out_ void **out_ptr, _Out_ size_t *out_len, _Out_ void **out_err)"),
    velr_table_close: required("void velr_table_close(velr_table *table)"),
    velr_table_column_count: required("size_t velr_table_column_count(velr_table *table)"),
    velr_table_column_name: required("velr_code velr_table_column_name(velr_table *table, size_t idx, _Out_ void **out_ptr, _Out_ size_t *out_len)"),
    velr_table_rows_open: required("velr_code velr_table_rows_open(velr_table *table, _Out_ velr_rows **out_rows, _Out_ void **out_err)"),
    velr_rows_next: required("int velr_rows_next(velr_rows *rows, _Out_ velr_cell *buf, size_t buf_len, _Out_ size_t *out_written, _Out_ void **out_err)"),
    velr_rows_close: required("void velr_rows_close(velr_rows *rows)"),
    velr_tx_begin: required("velr_code velr_tx_begin(velr_db *db, _Out_ velr_tx **out_tx, _Out_ void **out_err)"),
    velr_tx_commit: required("velr_code velr_tx_commit(velr_tx *tx, _Out_ void **out_err)"),
    velr_tx_rollback: required("velr_code velr_tx_rollback(velr_tx *tx, _Out_ void **out_err)"),
    velr_tx_close: required("void velr_tx_close(velr_tx *tx)"),
    velr_tx_exec_start: required("velr_code velr_tx_exec_start(velr_tx *tx, const char *cypher, _Out_ velr_stream_tx **out_stream, _Out_ void **out_err)"),
    velr_tx_exec_start_with_options: optional("velr_code velr_tx_exec_start_with_options(velr_tx *tx, const char *cypher, const velr_query_options *opts, _Out_ velr_stream_tx **out_stream, _Out_ void **out_err)"),
    velr_stream_tx_next_table: required("velr_code velr_stream_tx_next_table(velr_stream_tx *stream, _Out_ velr_table **out_table, _Out_ int *out_has, _Out_ void **out_err)"),
    velr_exec_tx_close: required("void velr_exec_tx_close(velr_stream_tx *stream)"),
    velr_tx_savepoint: required("velr_code velr_tx_savepoint(velr_tx *tx, _Out_ velr_sp **out_sp, _Out_ void **out_err)"),
    velr_sp_release: required("velr_code velr_sp_release(velr_sp *sp, _Out_ void **out_err)"),
    velr_sp_rollback: required("velr_code velr_sp_rollback(velr_sp *sp, _Out_ void **out_err)"),
    velr_sp_close: required("void velr_sp_close(velr_sp *sp)"),
    velr_tx_savepoint_named: optional("velr_code velr_tx_savepoint_named(velr_tx *tx, const char *name_utf8, _Out_ velr_sp **out_sp, _Out_ void **out_err)"),
    velr_tx_rollback_to: optional("velr_code velr_tx_rollback_to(velr_tx *tx, const char *name_utf8, _Out_ void **out_err)"),
    velr_table_ipc_file_malloc: optional("velr_code velr_table_ipc_file_malloc(velr_table *table, _Out_ void **out_ptr, _Out_ size_t *out_len, _Out_ void **out_err)"),
    velr_bind_arrow_ipc: optional("velr_code velr_bind_arrow_ipc(velr_db *db, const char *logical_utf8, const void *ipc_ptr, size_t ipc_len, _Out_ void **out_err)"),
    velr_tx_bind_arrow_ipc: optional("velr_code velr_tx_bind_arrow_ipc(velr_tx *tx, const char *logical_utf8, const void *ipc_ptr, size_t ipc_len, _Out_ void **out_err)")
  };

  return {
    lib,
    resolution,
    types: {
      cell,
      queryOptions,
      migrationReport,
      explainPlanMeta,
      explainStepMeta,
      explainStatementMeta,
      strView,
      vectorEmbeddingField,
      vectorEmbeddingInput,
      vectorEmbedderCallback
    },
    cellSize: koffi.sizeof(cell)
  };
}

export function ensureNoNul(value: string, what: string): void {
  if (value.includes("\0")) {
    throw new VelrTypeError(`${what} contains NUL`);
  }
}

export function outPtr(): NativePointer[] {
  return [null];
}

export function outInt(initial = 0): number[] {
  return [initial];
}

export function check(rc: number, outErr: NativePointer[], context = "Velr runtime call"): void {
  if (rc === VelrCode.OK) {
    freeUnexpectedErr(outErr);
    return;
  }
  throw new VelrError(takeErr(outErr), { code: rc });
}

export function checkNoErr(rc: number, context: string): void {
  if (rc !== VelrCode.OK) {
    throw new VelrError(`${context} failed with code ${rc}`, { code: rc });
  }
}

export function takeErr(outErr: NativePointer[]): string {
  const ptr = outErr[0];
  outErr[0] = null;
  if (isNullPointer(ptr)) return "unknown Velr runtime error";

  try {
    return cStringToString(ptr, "Velr runtime error");
  } finally {
    getBindings().lib.velr_string_free(ptr);
  }
}

export function cStringToString(ptr: NativePointer, what: string): string {
  if (isNullPointer(ptr)) return "";
  const value = koffi.decode(ptr, "char", -1);
  if (typeof value !== "string") throw new VelrError(`${what} did not decode to a string`);
  return value;
}

function freeUnexpectedErr(outErr: NativePointer[]): void {
  const ptr = outErr[0];
  outErr[0] = null;
  if (!isNullPointer(ptr)) {
    getBindings().lib.velr_string_free(ptr);
  }
}

export function makeStrView(value: string | Buffer): { view: StrView; backing: Buffer } {
  const backing = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return { view: { ptr: backing, len: backing.length }, backing };
}

export function strViewToBuffer(view: StrView | undefined, what: string): Buffer {
  if (!view) return Buffer.alloc(0);
  const len = sizeToNumber(view.len, `${what} length`);
  if (len === 0) return Buffer.alloc(0);
  if (isNullPointer(view.ptr as NativePointer)) {
    throw new VelrError(`${what} has a null pointer with non-zero length`);
  }
  return Buffer.from(new Uint8Array(koffi.view(view.ptr, len)));
}

export function strViewToString(view: StrView | undefined, what: string): string {
  return strViewToBuffer(view, what).toString("utf8");
}

export function optStrViewToString(view: StrView | undefined, what: string): string | null {
  if (!view || (isNullPointer(view.ptr as NativePointer) && sizeToNumber(view.len, what) === 0)) {
    return null;
  }
  return strViewToString(view, what);
}

export function pointerToBuffer(ptr: NativePointer, lenValue: number | bigint, what: string): Buffer {
  const len = sizeToNumber(lenValue, `${what} length`);
  if (len === 0) return Buffer.alloc(0);
  if (isNullPointer(ptr)) throw new VelrError(`${what} has a null pointer with non-zero length`);
  return Buffer.from(new Uint8Array(koffi.view(ptr, len)));
}

export function sizeToNumber(value: number | bigint | undefined, what: string): number {
  if (value == null) return 0;
  const n = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new VelrError(`${what} is outside JavaScript's safe integer range`);
  }
  return n;
}

export function decodeCellAt(buffer: Buffer, index: number): any {
  const { types, cellSize } = getBindings();
  return koffi.decode(buffer.subarray(index * cellSize), types.cell);
}

export function encodeVectorOutput(ptr: NativePointer, values: readonly number[]): void {
  if (values.length === 0) return;
  if (isNullPointer(ptr)) throw new VelrError("vector output pointer is null");
  koffi.encode(ptr, "float", values, values.length);
}

export function writeCallbackError(ptr: NativePointer, lenValue: number | bigint, message: string): void {
  const len = sizeToNumber(lenValue, "vector callback error buffer length");
  if (len === 0 || isNullPointer(ptr)) return;
  const bytes = Buffer.from(message, "utf8").subarray(0, Math.max(0, len - 1));
  koffi.encode(ptr, "uint8_t", [...bytes, 0], bytes.length + 1);
}

export function isNullPointer(ptr: NativePointer | Buffer | undefined): boolean {
  return ptr == null || ptr === 0n;
}

export function buildQueryParams(params: QueryParams | null | undefined): NativePointer {
  if (params == null) return null;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new VelrTypeError("query params must be an object");
  }

  const { lib } = getBindings();
  const handle = lib.velr_query_params_new();
  if (isNullPointer(handle)) throw new VelrError("velr_query_params_new returned null");

  try {
    for (const [name, value] of Object.entries(params)) {
      setQueryParam(handle, name, value);
    }
    return handle;
  } catch (err) {
    lib.velr_query_params_free(handle);
    throw err;
  }
}

export function freeQueryParams(handle: NativePointer): void {
  if (!isNullPointer(handle)) getBindings().lib.velr_query_params_free(handle);
}

function setQueryParam(handle: NativePointer, name: string, value: QueryValue): void {
  validateParamName(name);
  const { lib } = getBindings();
  const nameView = makeStrView(name);
  const outErrValue = outPtr();

  if (value === null) {
    check(lib.velr_query_params_set_null(handle, nameView.view, outErrValue), outErrValue);
    return;
  }
  if (typeof value === "boolean") {
    check(lib.velr_query_params_set_bool(handle, nameView.view, value ? 1 : 0, outErrValue), outErrValue);
    return;
  }
  if (typeof value === "bigint") {
    checkI64Range(value, `parameter ${name}`);
    check(lib.velr_query_params_set_i64(handle, nameView.view, value, outErrValue), outErrValue);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VelrTypeError(`parameter ${name} must be finite`);
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new VelrTypeError(`integer parameter ${name} is not safely representable; pass a bigint`);
      }
      check(lib.velr_query_params_set_i64(handle, nameView.view, BigInt(value), outErrValue), outErrValue);
    } else {
      check(lib.velr_query_params_set_f64(handle, nameView.view, value, outErrValue), outErrValue);
    }
    return;
  }
  if (typeof value === "string") {
    const valueView = makeStrView(value);
    check(lib.velr_query_params_set_text(handle, nameView.view, valueView.view, outErrValue), outErrValue);
    return;
  }

  const jsonView = makeStrView(queryValueToJson(value, `parameter ${name}`));
  check(lib.velr_query_params_set_json(handle, nameView.view, jsonView.view, outErrValue), outErrValue);
}

function validateParamName(name: string): void {
  if (typeof name !== "string") throw new VelrTypeError("query parameter names must be strings");
  if (name.length === 0) throw new VelrTypeError("query parameter names cannot be empty");
  if (name.startsWith("$")) throw new VelrTypeError("query parameter names omit the leading '$'");
  ensureNoNul(name, "query parameter name");
}

function queryValueToJson(value: QueryValue, what: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") {
    checkI64Range(value, what);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VelrTypeError(`${what} must be finite`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new VelrTypeError(`${what} integer is not safely representable; pass a bigint`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => queryValueToJson(item, `${what}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, nested]) => {
        if (typeof key !== "string") throw new VelrTypeError(`${what} map keys must be strings`);
        return `${JSON.stringify(key)}:${queryValueToJson(nested, `${what}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new VelrTypeError(`${what} has unsupported value type`);
}

function checkI64Range(value: bigint, what: string): void {
  if (value < I64_MIN || value > I64_MAX) {
    throw new VelrTypeError(`${what} is outside signed 64-bit integer range`);
  }
}

export function buildQueryOptions(
  maxResultRows: number | null | undefined,
  params: QueryParams | null | undefined
): { raw: QueryOptionsRaw | null; paramsHandle: NativePointer } {
  const hasMax = maxResultRows != null;
  if (hasMax) {
    if (!Number.isSafeInteger(maxResultRows) || maxResultRows < 0) {
      throw new VelrTypeError("maxResultRows must be a non-negative safe integer");
    }
  }
  const paramsHandle = buildQueryParams(params);
  if (!hasMax && isNullPointer(paramsHandle)) return { raw: null, paramsHandle: null };

  return {
    raw: {
      has_max_result_rows: hasMax ? 1 : 0,
      max_result_rows: hasMax ? maxResultRows : 0,
      params: paramsHandle
    },
    paramsHandle
  };
}

export function registerVectorCallback(embedder: VectorEmbedder): NativePointer {
  const { types } = getBindings();
  const callback = (
    _userData: NativePointer,
    rawInputs: NativePointer,
    inputCountValue: number | bigint,
    dimensionsValue: number | bigint,
    outVectors: NativePointer,
    errBuf: NativePointer,
    errBufLen: number | bigint
  ) => {
    try {
      const inputCount = sizeToNumber(inputCountValue, "vector callback input count");
      const dimensions = sizeToNumber(dimensionsValue, "vector callback dimensions");
      const inputs = decodeVectorInputs(rawInputs, inputCount);
      const vectors = embedder(inputs);
      if (vectors.length !== inputCount) {
        throw new VelrError(
          `vector embedder returned ${vectors.length} embeddings for ${inputCount} inputs`
        );
      }

      const flat: number[] = [];
      vectors.forEach((vector, rowIdx) => {
        if (vector.length !== dimensions) {
          throw new VelrError(
            `vector embedder returned ${vector.length} dimensions for input ${rowIdx}; expected ${dimensions}`
          );
        }
        for (let dimIdx = 0; dimIdx < vector.length; dimIdx += 1) {
          const value = Number(vector[dimIdx]);
          if (!Number.isFinite(value)) {
            throw new VelrError(
              `vector embedder returned a non-finite value for input ${rowIdx} at dimension ${dimIdx}`
            );
          }
          flat.push(value);
        }
      });
      encodeVectorOutput(outVectors, flat);
      return VelrCode.OK;
    } catch (err) {
      writeCallbackError(errBuf, errBufLen, err instanceof Error ? err.message : String(err));
      return VelrCode.EERR;
    }
  };

  return koffi.register(callback, koffi.pointer(types.vectorEmbedderCallback));
}

export function unregisterVectorCallback(ptr: NativePointer): void {
  if (!isNullPointer(ptr)) koffi.unregister(ptr);
}

function decodeVectorInputs(ptr: NativePointer, count: number): VectorEmbeddingInput[] {
  if (count === 0) return [];
  if (isNullPointer(ptr)) throw new VelrError("vector inputs pointer is null");
  const { types } = getBindings();
  const rawInputs = koffi.decode(ptr, types.vectorEmbeddingInput, count) as any[];
  return rawInputs.map((raw) => {
    const fieldCount = sizeToNumber(raw.field_count, "vector field count");
    if (fieldCount > 0 && isNullPointer(raw.fields)) {
      throw new VelrError("vector input fields pointer is null");
    }
    const rawFields =
      fieldCount === 0
        ? []
        : (koffi.decode(raw.fields, types.vectorEmbeddingField, fieldCount) as any[]);
    return {
      indexName: strViewToString(raw.index_name, "vector index name"),
      dimensions: sizeToNumber(raw.dimensions, "vector dimensions"),
      purpose: vectorPurposeName(raw.purpose),
      entityKind: vectorEntityKindName(raw.entity_kind),
      entityId: raw.has_entity_id ? BigInt(raw.entity_id) : null,
      fields: rawFields.map(decodeVectorField)
    };
  });
}

function decodeVectorField(raw: any): VectorEmbeddingField {
  const valueType = vectorValueTypeName(raw.value_type);
  const valueJsonText = strViewToString(raw.json, "vector field JSON");
  const valueJson = valueJsonText.length === 0 ? null : JSON.parse(valueJsonText);
  const storageType = Number(raw.storage_type);
  const bytes = strViewToBuffer(raw.bytes, "vector field bytes");
  let value: unknown = valueJson;
  if (valueType === "null" || storageType === StorageValueKind.Null) value = null;
  if (valueType === "bool" && storageType === StorageValueKind.Int64) {
    value = BigInt(raw.i64_) !== 0n;
  }
  if (valueType === "int64" && storageType === StorageValueKind.Int64) {
    value = BigInt(raw.i64_);
  }
  if (valueType === "double" && storageType === StorageValueKind.Double) {
    value = Number(raw.f64_);
  }
  if (valueType === "string" && storageType === StorageValueKind.Text) {
    value = bytes.toString("utf8");
  }
  if (valueType === "bytes" || storageType === StorageValueKind.Blob) value = bytes;

  return {
    name: raw.has_name ? strViewToString(raw.name, "vector field name") : null,
    value,
    valueType,
    valueJson,
    display: strViewToString(raw.display, "vector field display")
  };
}

function vectorPurposeName(value: number): "index_entity" | "query" {
  if (value === 0) return "index_entity";
  if (value === 1) return "query";
  throw new VelrError(`unknown vector embedding purpose ${value}`);
}

function vectorEntityKindName(value: number): "node" | "relationship" | null {
  if (value === 0) return null;
  if (value === 1) return "node";
  if (value === 2) return "relationship";
  throw new VelrError(`unknown vector entity kind ${value}`);
}

function vectorValueTypeName(value: number): VectorPropertyValueType {
  const names: Record<number, VectorPropertyValueType> = {
    0: "null",
    1: "bool",
    2: "int64",
    3: "double",
    4: "string",
    5: "date",
    6: "local_time",
    7: "zoned_time",
    8: "local_datetime",
    9: "zoned_datetime",
    10: "duration",
    11: "point",
    12: "geometry",
    13: "geography",
    14: "list",
    15: "vector",
    16: "bytes"
  };
  const name = names[value];
  if (!name) throw new VelrError(`unknown vector property value type ${value}`);
  return name;
}
