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
  EERR = -4,
  ECANCELLED = -5,
  EDEADLINE = -6
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
  readonly velr_query_control_new?: (timeoutNs: bigint) => NativePointer;
  readonly velr_query_control_cancel?: (control: NativePointer) => void;
  readonly velr_query_control_status?: (control: NativePointer) => number;
  readonly velr_query_control_free?: (control: NativePointer) => void;
  readonly velr_exec_start_with_control?: ControlledExec;
  readonly velr_exec_one_with_control?: ControlledExec;
  readonly velr_run_with_control?: ControlledRun;
  readonly velr_tx_exec_start_with_control?: ControlledExec;
  readonly velr_tx_run_with_control?: ControlledRun;
  readonly velr_string_free: (ptr: NativePointer) => void;
  readonly velr_free: (ptr: NativePointer, len: number | bigint) => void;
  readonly velr_open: (path: string | null, outDb: NativePointer[], outErr: NativePointer[]) => number;
  readonly velr_create?: (
    path: string | null,
    properties: readonly string[] | null,
    count: number,
    outDb: NativePointer[],
    outErr: NativePointer[]
  ) => number;
  readonly velr_inline_edge_properties_json?: (
    db: NativePointer,
    outJson: NativePointer[],
    outErr: NativePointer[]
  ) => number;
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
  readonly velr_query_param_row_map_required_columns: (
    cypher: StrView,
    paramName: StrView,
    outJson: NativePointer[],
    outErr: NativePointer[]
  ) => number;
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
  readonly velr_query_params_set_row_maps: (
    params: NativePointer,
    name: StrView,
    rowCount: number,
    entries: Buffer | null,
    entryCount: number,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_row_map_columns: (
    params: NativePointer,
    name: StrView,
    rowCount: number,
    colnames: Buffer | null,
    colCount: number,
    cells: Buffer | null,
    present: Buffer | null,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_row_map_packed_columns: (
    params: NativePointer,
    name: StrView,
    rowCount: number,
    colnames: Buffer | null,
    colCount: number,
    cellTypes: Buffer | null,
    i64Values: Buffer | null,
    f64Values: Buffer | null,
    bytesOffsets: Buffer | null,
    bytesLens: Buffer | null,
    bytes: Buffer | null,
    bytesLen: number,
    present: Buffer | null,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_row_map_packed_columns_u32: (
    params: NativePointer,
    name: StrView,
    rowCount: number,
    colnames: Buffer | null,
    colCount: number,
    cellTypes: Buffer | null,
    i64Values: Buffer | null,
    f64Values: Buffer | null,
    bytesOffsets: Buffer | null,
    bytesLens: Buffer | null,
    bytes: Buffer | null,
    bytesLen: number,
    present: Buffer | null,
    outErr: NativePointer[]
  ) => number;
  readonly velr_query_params_set_row_map_packed_columns_u8_u32: (
    params: NativePointer,
    name: StrView,
    rowCount: number,
    colnames: Buffer | null,
    colCount: number,
    cellTypes: Buffer | null,
    i64Values: Buffer | null,
    f64Values: Buffer | null,
    bytesOffsets: Buffer | null,
    bytesLens: Buffer | null,
    bytes: Buffer | null,
    bytesLen: number,
    present: Buffer | null,
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
  readonly velr_vacuum?: (db: NativePointer, outErr: NativePointer[]) => number;
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
  readonly velr_run: (
    db: NativePointer,
    cypher: string,
    outErr: NativePointer[]
  ) => number;
  readonly velr_run_with_options: (
    db: NativePointer,
    cypher: string,
    opts: QueryOptionsRaw,
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
  readonly velr_tx_run: (
    tx: NativePointer,
    cypher: string,
    outErr: NativePointer[]
  ) => number;
  readonly velr_tx_run_with_options: (
    tx: NativePointer,
    cypher: string,
    opts: QueryOptionsRaw,
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

type ControlledExec = (
  owner: NativePointer,
  cypher: string,
  options: QueryOptionsRaw | null,
  control: NativePointer,
  result: NativePointer[],
  error: NativePointer[]
) => number;

type ControlledRun = (
  owner: NativePointer,
  cypher: string,
  options: QueryOptionsRaw | null,
  control: NativePointer,
  error: NativePointer[]
) => number;

export interface NativeBindings {
  readonly lib: NativeLib;
  readonly resolution: RuntimeResolution;
  readonly types: {
    readonly cell: any;
    readonly paramMapEntry: any;
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
  readonly paramMapEntrySize: number;
}

export interface StrView {
  ptr?: Buffer | NativePointer;
  len: number | bigint;
}

interface CellRaw {
  ty: number;
  i64_: bigint;
  f64_: number;
  ptr: Buffer | NativePointer;
  len: number | bigint;
}

interface ParamMapEntryRaw {
  row_index: number | bigint;
  key: StrView;
  value: CellRaw;
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

// The direct and worker entry points can be separate bundles in the same isolate.
// Share their Koffi types and symbols because Koffi registers type names per isolate.
const bindingsKey = Symbol.for("@velr-ai/velr/native-bindings/v1");
const bindingStore = globalThis as { [bindingsKey]?: NativeBindings };

export function getBindings(): NativeBindings {
  return bindingStore[bindingsKey] ??= createBindings(resolveRuntime());
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
  koffi.opaque("velr_query_control");
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

  const paramMapEntry = koffi.struct("velr_param_map_entry", {
    row_index: "size_t",
    key: strView,
    value: cell
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
    velr_create: optional("velr_code velr_create(const char *path_or_null, const char **inline_edge_properties, size_t inline_edge_properties_count, _Out_ velr_db **out_db, _Out_ void **out_err)"),
    velr_inline_edge_properties_json: optional("velr_code velr_inline_edge_properties_json(velr_db *db, _Out_ void **out_json, _Out_ void **out_err)"),
    velr_open_existing_readonly: optional("velr_code velr_open_existing_readonly(const char *path, _Out_ velr_db **out_db, _Out_ void **out_err)"),
    velr_close: required("void velr_close(velr_db *db)"),
    velr_register_vector_embedder: optional("velr_code velr_register_vector_embedder(velr_db *db, velr_strview name, velr_vector_embedder_callback *callback, void *user_data, void *free_user_data, _Out_ void **out_err)"),
    velr_query_params_new: required("velr_query_params *velr_query_params_new(void)"),
    velr_query_params_free: required("void velr_query_params_free(velr_query_params *params)"),
    velr_query_param_row_map_required_columns: required("velr_code velr_query_param_row_map_required_columns(velr_strview cypher, velr_strview param_name, _Out_ void **out_json, _Out_ void **out_err)"),
    velr_query_params_set_null: required("velr_code velr_query_params_set_null(velr_query_params *params, velr_strview name, _Out_ void **out_err)"),
    velr_query_params_set_bool: required("velr_code velr_query_params_set_bool(velr_query_params *params, velr_strview name, int value, _Out_ void **out_err)"),
    velr_query_params_set_i64: required("velr_code velr_query_params_set_i64(velr_query_params *params, velr_strview name, int64_t value, _Out_ void **out_err)"),
    velr_query_params_set_f64: required("velr_code velr_query_params_set_f64(velr_query_params *params, velr_strview name, double value, _Out_ void **out_err)"),
    velr_query_params_set_text: required("velr_code velr_query_params_set_text(velr_query_params *params, velr_strview name, velr_strview value, _Out_ void **out_err)"),
    velr_query_params_set_json: required("velr_code velr_query_params_set_json(velr_query_params *params, velr_strview name, velr_strview json_value, _Out_ void **out_err)"),
    velr_query_params_set_row_maps: required("velr_code velr_query_params_set_row_maps(velr_query_params *params, velr_strview name, size_t row_count, const velr_param_map_entry *entries, size_t entry_count, _Out_ void **out_err)"),
    velr_query_params_set_row_map_columns: required("velr_code velr_query_params_set_row_map_columns(velr_query_params *params, velr_strview name, size_t row_count, const velr_strview *colnames, size_t col_count, const velr_cell *cells, const uint8_t *present, _Out_ void **out_err)"),
    velr_query_params_set_row_map_packed_columns: required("velr_code velr_query_params_set_row_map_packed_columns(velr_query_params *params, velr_strview name, size_t row_count, const velr_strview *colnames, size_t col_count, const int *cell_types, const int64_t *i64_values, const double *f64_values, const size_t *bytes_offsets, const size_t *bytes_lens, const uint8_t *bytes, size_t bytes_len, const uint8_t *present, _Out_ void **out_err)"),
    velr_query_params_set_row_map_packed_columns_u32: required("velr_code velr_query_params_set_row_map_packed_columns_u32(velr_query_params *params, velr_strview name, size_t row_count, const velr_strview *colnames, size_t col_count, const int *cell_types, const int64_t *i64_values, const double *f64_values, const uint32_t *bytes_offsets, const uint32_t *bytes_lens, const uint8_t *bytes, size_t bytes_len, const uint8_t *present, _Out_ void **out_err)"),
    velr_query_params_set_row_map_packed_columns_u8_u32: required("velr_code velr_query_params_set_row_map_packed_columns_u8_u32(velr_query_params *params, velr_strview name, size_t row_count, const velr_strview *colnames, size_t col_count, const uint8_t *cell_types, const int64_t *i64_values, const double *f64_values, const uint32_t *bytes_offsets, const uint32_t *bytes_lens, const uint8_t *bytes, size_t bytes_len, const uint8_t *present, _Out_ void **out_err)"),
    velr_schema_version: required("velr_code velr_schema_version(velr_db *db, _Out_ int32_t *out_version, _Out_ void **out_err)"),
    velr_current_schema_version: required("velr_code velr_current_schema_version(velr_db *db, _Out_ int32_t *out_version, _Out_ void **out_err)"),
    velr_needs_migration: required("velr_code velr_needs_migration(velr_db *db, _Out_ int *out_needs_migration, _Out_ void **out_err)"),
    velr_migrate: required("velr_code velr_migrate(velr_db *db, _Out_ velr_migration_report *out_report, _Out_ void **out_err)"),
    velr_vacuum: optional("velr_code velr_vacuum(velr_db *db, _Out_ void **out_err)"),
    velr_migration_report_clear: required("void velr_migration_report_clear(_Inout_ velr_migration_report *report)"),
    velr_exec_start: required("velr_code velr_exec_start(velr_db *db, const char *cypher, _Out_ velr_stream **out_stream, _Out_ void **out_err)"),
    velr_exec_start_with_options: optional("velr_code velr_exec_start_with_options(velr_db *db, const char *cypher, const velr_query_options *opts, _Out_ velr_stream **out_stream, _Out_ void **out_err)"),
    velr_query_control_new: optional("velr_query_control *velr_query_control_new(uint64_t timeout_ns)"),
    velr_query_control_cancel: optional("void velr_query_control_cancel(velr_query_control *control)"),
    velr_query_control_status: optional("velr_code velr_query_control_status(const velr_query_control *control)"),
    velr_query_control_free: optional("void velr_query_control_free(velr_query_control *control)"),
    velr_exec_start_with_control: optional("velr_code velr_exec_start_with_control(velr_db *db, const char *cypher, const velr_query_options *opts, const velr_query_control *control, _Out_ velr_stream **out_stream, _Out_ void **out_err)"),
    velr_exec_one_with_control: optional("velr_code velr_exec_one_with_control(velr_db *db, const char *cypher, const velr_query_options *opts, const velr_query_control *control, _Out_ velr_table **out_table, _Out_ void **out_err)"),
    velr_run_with_control: optional("velr_code velr_run_with_control(velr_db *db, const char *cypher, const velr_query_options *opts, const velr_query_control *control, _Out_ void **out_err)"),
    velr_tx_exec_start_with_control: optional("velr_code velr_tx_exec_start_with_control(velr_tx *tx, const char *cypher, const velr_query_options *opts, const velr_query_control *control, _Out_ velr_stream_tx **out_stream, _Out_ void **out_err)"),
    velr_tx_run_with_control: optional("velr_code velr_tx_run_with_control(velr_tx *tx, const char *cypher, const velr_query_options *opts, const velr_query_control *control, _Out_ void **out_err)"),
    velr_run: required("velr_code velr_run(velr_db *db, const char *cypher, _Out_ void **out_err)"),
    velr_run_with_options: required("velr_code velr_run_with_options(velr_db *db, const char *cypher, const velr_query_options *opts, _Out_ void **out_err)"),
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
    velr_tx_run: required("velr_code velr_tx_run(velr_tx *tx, const char *cypher, _Out_ void **out_err)"),
    velr_tx_run_with_options: required("velr_code velr_tx_run_with_options(velr_tx *tx, const char *cypher, const velr_query_options *opts, _Out_ void **out_err)"),
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
      paramMapEntry,
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
    cellSize: koffi.sizeof(cell),
    paramMapEntrySize: koffi.sizeof(paramMapEntry)
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

export function queryControlAddress(control: NativePointer): bigint {
  return typeof control === "bigint" ? control : koffi.address(control);
}

export function queryControlFromAddress(address: bigint): NativePointer {
  const pointer = Buffer.alloc(koffi.sizeof("uintptr_t"));
  koffi.encode(pointer, "uintptr_t", address);
  return koffi.decode(pointer, "velr_query_control *");
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

type RowMapColumnHints = ReadonlyMap<string, readonly string[]>;

const ROW_MAP_REQUIRED_COLUMNS_CACHE_MAX = 256;
const rowMapRequiredColumnsCache = new Map<string, readonly string[] | null>();

export function buildQueryParams(
  params: QueryParams | null | undefined,
  rowMapColumnHints?: RowMapColumnHints
): NativePointer {
  if (params == null) return null;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new VelrTypeError("query params must be an object");
  }

  const { lib } = getBindings();
  const handle = lib.velr_query_params_new();
  if (isNullPointer(handle)) throw new VelrError("velr_query_params_new returned null");

  try {
    for (const [name, value] of Object.entries(params)) {
      setQueryParam(handle, name, value, rowMapColumnHints?.get(name));
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

function setQueryParam(
  handle: NativePointer,
  name: string,
  value: QueryValue,
  rowMapColumns?: readonly string[]
): void {
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
  if (Array.isArray(value) && value.every(isQueryMap)) {
    setQueryParamRowMaps(handle, nameView.view, value, rowMapColumns);
    return;
  }

  const jsonView = makeStrView(queryValueToJson(value, `parameter ${name}`));
  check(lib.velr_query_params_set_json(handle, nameView.view, jsonView.view, outErrValue), outErrValue);
}

function isQueryMap(value: QueryValue): value is { readonly [key: string]: QueryValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function queryParamRowMapRequiredColumns(cypher: string, paramName: string): readonly string[] | null {
  const { lib } = getBindings();

  const cacheKey = `${paramName}\0${cypher}`;
  if (rowMapRequiredColumnsCache.has(cacheKey)) {
    return rowMapRequiredColumnsCache.get(cacheKey) ?? null;
  }

  const cypherView = makeStrView(cypher);
  const paramNameView = makeStrView(paramName);
  const outJson = outPtr();
  const outErrValue = outPtr();
  check(
    lib.velr_query_param_row_map_required_columns(
      cypherView.view,
      paramNameView.view,
      outJson,
      outErrValue
    ),
    outErrValue
  );

  let columns: readonly string[] | null = null;
  if (!isNullPointer(outJson[0])) {
    try {
      const decoded = JSON.parse(cStringToString(outJson[0], "row-map required columns"));
      if (!Array.isArray(decoded) || !decoded.every((value) => typeof value === "string")) {
        throw new VelrError("row-map required columns did not decode to a string array");
      }
      columns = decoded;
    } finally {
      lib.velr_string_free(outJson[0]);
    }
  }

  rowMapRequiredColumnsCache.set(cacheKey, columns);
  if (rowMapRequiredColumnsCache.size > ROW_MAP_REQUIRED_COLUMNS_CACHE_MAX) {
    const firstKey = rowMapRequiredColumnsCache.keys().next().value;
    if (firstKey !== undefined) rowMapRequiredColumnsCache.delete(firstKey);
  }
  return columns;
}

function setQueryParamRowMaps(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[],
  projectedColumns?: readonly string[]
): void {
  const { lib, types, paramMapEntrySize } = getBindings();

  if (projectedColumns && trySetQueryParamProjectedRowMapColumns(handle, name, rows, projectedColumns)) {
    return;
  }

  if (trySetQueryParamDenseRowMapColumns(handle, name, rows)) {
    return;
  }

  const columns: string[] = [];
  let entryCount = 0;
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      entryCount += 1;
      if (!columns.includes(key)) columns.push(key);
    }
  }
  if (trySetQueryParamRowMapColumns(handle, name, rows, columns, entryCount)) {
    return;
  }

  const keepAlive: Buffer[] = [];
  const entries: ParamMapEntryRaw[] = [];
  rows.forEach((row, rowIndex) => {
    for (const [key, value] of Object.entries(row)) {
      const keyView = makeStrView(key);
      keepAlive.push(keyView.backing);
      entries.push({
        row_index: rowIndex,
        key: keyView.view,
        value: queryValueToParamCell(value, keepAlive, null, rowIndex, key)
      });
    }
  });

  const entryBuffer = entries.length === 0 ? null : Buffer.alloc(paramMapEntrySize * entries.length);
  if (entryBuffer) koffi.encode(entryBuffer, types.paramMapEntry, entries, entries.length);

  const outErrValue = outPtr();
  check(
    lib.velr_query_params_set_row_maps(handle, name, rows.length, entryBuffer, entries.length, outErrValue),
    outErrValue
  );
}

function trySetQueryParamProjectedRowMapColumns(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[],
  columns: readonly string[]
): boolean {
  if (trySetQueryParamPackedRowMapColumns(handle, name, rows, columns, true)) {
    return true;
  }

  return trySetQueryParamRowMapColumns(handle, name, rows, columns, rows.length * columns.length);
}

function trySetQueryParamDenseRowMapColumns(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[]
): boolean {
  const { lib, types, cellSize } = getBindings();

  const columns = rows.length === 0 ? [] : Object.keys(rows[0]!);

  if (trySetQueryParamPackedRowMapColumns(handle, name, rows, columns, false)) {
    return true;
  }

  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length) return false;
    for (const column of columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) return false;
    }
  }

  const keepAlive: Buffer[] = [];
  const colViews = columns.map((column) => {
    const view = makeStrView(column);
    keepAlive.push(view.backing);
    return view.view;
  });
  const strViewSize = koffi.sizeof(types.strView);
  const colBuffer = colViews.length === 0 ? null : Buffer.alloc(strViewSize * colViews.length);
  if (colBuffer) koffi.encode(colBuffer, types.strView, colViews, colViews.length);

  const cells = new Array<CellRaw>(rows.length * columns.length);
  let cellIndex = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    for (const column of columns) {
      cells[cellIndex++] = queryValueToParamCell(row[column], keepAlive, null, rowIndex, column);
    }
  }

  const cellBuffer = cells.length === 0 ? null : Buffer.alloc(cellSize * cells.length);
  if (cellBuffer) koffi.encode(cellBuffer, types.cell, cells, cells.length);

  const outErrValue = outPtr();
  check(
    lib.velr_query_params_set_row_map_columns(
      handle,
      name,
      rows.length,
      colBuffer,
      columns.length,
      cellBuffer,
      null,
      outErrValue
    ),
    outErrValue
  );
  return true;
}

function trySetQueryParamRowMapColumns(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[],
  columns: readonly string[],
  entryCount: number
): boolean {
  const { lib, types, cellSize } = getBindings();

  const totalCells = rows.length * columns.length;
  if (totalCells > entryCount * 2) return false;

  if (trySetQueryParamPackedRowMapColumns(handle, name, rows, columns, true)) {
    return true;
  }

  const keepAlive: Buffer[] = [];
  const colViews = columns.map((column) => {
    const view = makeStrView(column);
    keepAlive.push(view.backing);
    return view.view;
  });
  const strViewSize = koffi.sizeof(types.strView);
  const colBuffer = colViews.length === 0 ? null : Buffer.alloc(strViewSize * colViews.length);
  if (colBuffer) koffi.encode(colBuffer, types.strView, colViews, colViews.length);

  const cells = new Array<CellRaw>(totalCells);
  const present = Buffer.alloc(totalCells);
  let allPresent = true;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex]!;
      const cellIndex = rowIndex * columns.length + columnIndex;
      if (Object.prototype.hasOwnProperty.call(row, column)) {
        present[cellIndex] = 1;
        cells[cellIndex] = queryValueToParamCell(row[column], keepAlive, null, rowIndex, column);
      } else {
        allPresent = false;
        cells[cellIndex] = nullParamCell();
      }
    }
  }

  const cellBuffer = cells.length === 0 ? null : Buffer.alloc(cellSize * cells.length);
  if (cellBuffer) koffi.encode(cellBuffer, types.cell, cells, cells.length);

  const outErrValue = outPtr();
  check(
    lib.velr_query_params_set_row_map_columns(
      handle,
      name,
      rows.length,
      colBuffer,
      columns.length,
      cellBuffer,
      allPresent ? null : present,
      outErrValue
    ),
    outErrValue
  );
  return true;
}

function trySetQueryParamPackedRowMapColumns(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[],
  columns: readonly string[],
  preserveMissing: boolean
): boolean {
  const result = trySetQueryParamPackedRowMapColumnsWithLayout(
    handle,
    name,
    rows,
    columns,
    preserveMissing,
    "u8_u32"
  );
  if (result === "set") return true;
  if (result === "shape-mismatch") return false;
  return (
    trySetQueryParamPackedRowMapColumnsWithLayout(
      handle,
      name,
      rows,
      columns,
      preserveMissing,
      "usize"
    ) === "set"
  );
}

type PackedLayout = "u8_u32" | "u32" | "usize";
type PackedOffsetWidth = "u32" | "usize";
type PackedRowMapSetResult = "set" | "shape-mismatch" | "offset-overflow";
const PACKED_U32_MAX = 0xffffffff;
const PACKED_BYTES_MIN_INITIAL_CAPACITY = 1024;
const PACKED_BYTES_MAX_INITIAL_CAPACITY = 1024 * 1024;
const PACKED_BYTES_CELL_CAPACITY_HINT = 32;

function trySetQueryParamPackedRowMapColumnsWithLayout(
  handle: NativePointer,
  name: StrView,
  rows: readonly { readonly [key: string]: QueryValue }[],
  columns: readonly string[],
  preserveMissing: boolean,
  layout: PackedLayout
): PackedRowMapSetResult {
  const { lib, types } = getBindings();
  const compactCellTypes = layout === "u8_u32";
  const offsetWidth: PackedOffsetWidth = layout === "usize" ? "usize" : "u32";
  const setPackedRowMapColumns =
    layout === "u8_u32"
      ? lib.velr_query_params_set_row_map_packed_columns_u8_u32
      : layout === "u32"
      ? lib.velr_query_params_set_row_map_packed_columns_u32
      : lib.velr_query_params_set_row_map_packed_columns;

  const keepAlive: Buffer[] = [];
  const colViews = columns.map((column) => {
    const view = makeStrView(column);
    keepAlive.push(view.backing);
    return view.view;
  });
  const strViewSize = koffi.sizeof(types.strView);
  const colBuffer = colViews.length === 0 ? null : Buffer.alloc(strViewSize * colViews.length);
  if (colBuffer) koffi.encode(colBuffer, types.strView, colViews, colViews.length);

  const totalCells = rows.length * columns.length;
  const offsetStride = offsetWidth === "u32" ? 4 : 8;
  const cellTypeStride = compactCellTypes ? 1 : 4;
  const cellTypes = totalCells === 0 ? null : Buffer.allocUnsafe(cellTypeStride * totalCells);
  const i64Values = totalCells === 0 ? null : Buffer.allocUnsafe(8 * totalCells);
  const f64Values = totalCells === 0 ? null : Buffer.allocUnsafe(8 * totalCells);
  const bytesOffsets = totalCells === 0 ? null : Buffer.allocUnsafe(offsetStride * totalCells);
  const bytesLens = totalCells === 0 ? null : Buffer.allocUnsafe(offsetStride * totalCells);
  const present = preserveMissing && totalCells > 0 ? Buffer.alloc(totalCells) : null;
  const bytesWriter = new PackedBytesWriter(packedBytesInitialCapacity(totalCells));

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    if (!preserveMissing && Object.keys(row).length !== columns.length) {
      return "shape-mismatch";
    }
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex]!;
      const cellIndex = rowIndex * columns.length + columnIndex;
      if (preserveMissing && !Object.prototype.hasOwnProperty.call(row, column)) {
        writePackedCellType(cellTypes!, cellIndex, CellKind.Null, compactCellTypes);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        return "shape-mismatch";
      }
      if (present) present[cellIndex] = 1;
      if (!writePackedParamCell(
        row[column],
        cellIndex,
        cellTypes!,
        i64Values!,
        f64Values!,
        bytesOffsets!,
        bytesLens!,
        bytesWriter,
        null,
        rowIndex,
        column,
        offsetWidth,
        compactCellTypes
      )) {
        return "offset-overflow";
      }
    }
  }

  const bytes = bytesWriter.toBuffer();
  const outErrValue = outPtr();
  check(
    setPackedRowMapColumns(
      handle,
      name,
      rows.length,
      colBuffer,
      columns.length,
      cellTypes,
      i64Values,
      f64Values,
      bytesOffsets,
      bytesLens,
      bytes,
      bytesWriter.length,
      present,
      outErrValue
    ),
    outErrValue
  );
  return "set";
}

function nullParamCell(): CellRaw {
  return { ty: CellKind.Null, i64_: 0n, f64_: 0, ptr: null, len: 0 };
}

class PackedBytesWriter {
  private buffer: Buffer;
  public length = 0;

  constructor(initialCapacity: number) {
    this.buffer = Buffer.allocUnsafe(Math.max(PACKED_BYTES_MIN_INITIAL_CAPACITY, initialCapacity));
  }

  appendUtf8(value: string): { offset: number; length: number } {
    const byteLength = Buffer.byteLength(value, "utf8");
    const offset = this.length;
    this.ensure(byteLength);
    this.buffer.write(value, offset, byteLength, "utf8");
    this.length += byteLength;
    return { offset, length: byteLength };
  }

  toBuffer(): Buffer | null {
    return this.length === 0 ? null : this.buffer.subarray(0, this.length);
  }

  private ensure(extra: number): void {
    const required = this.length + extra;
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < required) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }
}

function packedBytesInitialCapacity(totalCells: number): number {
  return Math.min(
    PACKED_BYTES_MAX_INITIAL_CAPACITY,
    Math.max(PACKED_BYTES_MIN_INITIAL_CAPACITY, totalCells * PACKED_BYTES_CELL_CAPACITY_HINT)
  );
}

function writePackedParamCell(
  value: QueryValue,
  cellIndex: number,
  cellTypes: Buffer,
  i64Values: Buffer,
  f64Values: Buffer,
  bytesOffsets: Buffer,
  bytesLens: Buffer,
  bytesWriter: PackedBytesWriter,
  what: string | null,
  rowIndex: number,
  column: string,
  offsetWidth: PackedOffsetWidth,
  compactCellTypes: boolean
): boolean {
  if (value === null) {
    writePackedCellType(cellTypes, cellIndex, CellKind.Null, compactCellTypes);
    return true;
  }
  if (typeof value === "boolean") {
    writePackedCellType(cellTypes, cellIndex, CellKind.Bool, compactCellTypes);
    i64Values.writeBigInt64LE(value ? 1n : 0n, cellIndex * 8);
    return true;
  }
  if (typeof value === "bigint") {
    checkParamCellI64Range(value, what, rowIndex, column);
    writePackedCellType(cellTypes, cellIndex, CellKind.Int64, compactCellTypes);
    i64Values.writeBigInt64LE(value, cellIndex * 8);
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new VelrTypeError(`${paramCellWhat(what, rowIndex, column)} must be finite`);
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new VelrTypeError(
          `${paramCellWhat(what, rowIndex, column)} integer is not safely representable; pass a bigint`
        );
      }
      writePackedCellType(cellTypes, cellIndex, CellKind.Int64, compactCellTypes);
      i64Values.writeBigInt64LE(BigInt(value), cellIndex * 8);
      return true;
    }
    writePackedCellType(cellTypes, cellIndex, CellKind.Double, compactCellTypes);
    f64Values.writeDoubleLE(value, cellIndex * 8);
    return true;
  }
  if (typeof value === "string") {
    return writePackedUtf8(
      cellTypes,
      bytesOffsets,
      bytesLens,
      bytesWriter,
      cellIndex,
      CellKind.Text,
      value,
      offsetWidth,
      compactCellTypes
    );
  }

  return writePackedUtf8(
    cellTypes,
    bytesOffsets,
    bytesLens,
    bytesWriter,
    cellIndex,
    CellKind.Json,
    queryValueToJson(value, paramCellWhat(what, rowIndex, column)),
    offsetWidth,
    compactCellTypes
  );
}

function writePackedCellType(cellTypes: Buffer, cellIndex: number, kind: CellKind, compact: boolean): void {
  if (compact) {
    cellTypes[cellIndex] = kind;
  } else {
    cellTypes.writeInt32LE(kind, cellIndex * 4);
  }
}

function writePackedUtf8(
  cellTypes: Buffer,
  bytesOffsets: Buffer,
  bytesLens: Buffer,
  bytesWriter: PackedBytesWriter,
  cellIndex: number,
  kind: CellKind,
  value: string,
  offsetWidth: PackedOffsetWidth,
  compactCellTypes: boolean
): boolean {
  const bytes = bytesWriter.appendUtf8(value);
  writePackedCellType(cellTypes, cellIndex, kind, compactCellTypes);
  if (offsetWidth === "u32") {
    if (bytes.offset > PACKED_U32_MAX || bytes.length > PACKED_U32_MAX) return false;
    bytesOffsets.writeUInt32LE(bytes.offset, cellIndex * 4);
    bytesLens.writeUInt32LE(bytes.length, cellIndex * 4);
  } else {
    bytesOffsets.writeBigUInt64LE(BigInt(bytes.offset), cellIndex * 8);
    bytesLens.writeBigUInt64LE(BigInt(bytes.length), cellIndex * 8);
  }
  return true;
}

function queryValueToParamCell(
  value: QueryValue,
  keepAlive: Buffer[],
  what: string | null,
  rowIndex = -1,
  column = ""
): CellRaw {
  if (value === null) return nullParamCell();
  if (typeof value === "boolean") {
    return { ty: CellKind.Bool, i64_: value ? 1n : 0n, f64_: 0, ptr: null, len: 0 };
  }
  if (typeof value === "bigint") {
    checkParamCellI64Range(value, what, rowIndex, column);
    return { ty: CellKind.Int64, i64_: value, f64_: 0, ptr: null, len: 0 };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new VelrTypeError(`${paramCellWhat(what, rowIndex, column)} must be finite`);
    }
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new VelrTypeError(
          `${paramCellWhat(what, rowIndex, column)} integer is not safely representable; pass a bigint`
        );
      }
      return { ty: CellKind.Int64, i64_: BigInt(value), f64_: 0, ptr: null, len: 0 };
    }
    return { ty: CellKind.Double, i64_: 0n, f64_: value, ptr: null, len: 0 };
  }
  if (typeof value === "string") {
    const valueView = makeStrView(value);
    keepAlive.push(valueView.backing);
    return { ty: CellKind.Text, i64_: 0n, f64_: 0, ptr: valueView.backing, len: valueView.backing.length };
  }

  const json = Buffer.from(queryValueToJson(value, paramCellWhat(what, rowIndex, column)), "utf8");
  keepAlive.push(json);
  return { ty: CellKind.Json, i64_: 0n, f64_: 0, ptr: json, len: json.length };
}

function paramCellWhat(what: string | null, rowIndex: number, column: string): string {
  if (what !== null) return what;
  if (rowIndex >= 0) return `parameter row ${rowIndex}.${column}`;
  return "parameter value";
}

function checkParamCellI64Range(
  value: bigint,
  what: string | null,
  rowIndex: number,
  column: string
): void {
  if (value < I64_MIN || value > I64_MAX) {
    throw new VelrTypeError(`${paramCellWhat(what, rowIndex, column)} is outside signed 64-bit range`);
  }
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
  params: QueryParams | null | undefined,
  cypher?: string
): { raw: QueryOptionsRaw | null; paramsHandle: NativePointer } {
  const hasMax = maxResultRows != null;
  if (hasMax) {
    if (!Number.isSafeInteger(maxResultRows) || maxResultRows < 0) {
      throw new VelrTypeError("maxResultRows must be a non-negative safe integer");
    }
  }
  const paramsHandle = buildQueryParams(params, cypher ? rowMapColumnHintsForCypher(cypher, params) : undefined);
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

function rowMapColumnHintsForCypher(
  cypher: string,
  params: QueryParams | null | undefined
): RowMapColumnHints | undefined {
  if (params == null) return undefined;
  if (typeof params !== "object" || Array.isArray(params)) return undefined;

  let hints: Map<string, readonly string[]> | undefined;
  for (const [name, value] of Object.entries(params)) {
    if (!Array.isArray(value) || !value.every(isQueryMap)) continue;
    const columns = queryParamRowMapRequiredColumns(cypher, name);
    if (columns == null) continue;
    if (!hints) hints = new Map();
    hints.set(name, columns);
  }
  return hints;
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
  if (!isNullPointer(ptr)) koffi.unregister(ptr as bigint);
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
