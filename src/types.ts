/** Primitive values accepted as query parameters. */
export type QueryScalar = null | boolean | number | bigint | string;

/**
 * A JSON-like value accepted by Velr query parameters.
 *
 * Parameters may be nested arrays or objects. JavaScript `bigint` values are
 * passed to Velr as signed 64-bit integers.
 */
export type QueryValue =
  | QueryScalar
  | readonly QueryValue[]
  | { readonly [key: string]: QueryValue };

/** Named query parameters passed to Cypher as `$name` values. */
export type QueryParams = Record<string, QueryValue>;

/** Options accepted by query execution helpers. */
export interface QueryOptions {
  /**
   * Maximum number of rows Velr should return.
   *
   * `null` or `undefined` leaves the runtime default unchanged.
   */
  readonly maxResultRows?: number | null;
  /** Named Cypher parameters available as `$name` in the query. */
  readonly params?: QueryParams | null;
}

/**
 * Controls how signed 64-bit integer cells are converted by `Cell.asJs()`.
 *
 * `"number-or-bigint"` returns a JavaScript `number` when the value is inside
 * the safe integer range and a `bigint` otherwise.
 */
export type Int64Mode = "number-or-bigint" | "number" | "bigint" | "string";

/** Cell conversion options used by `Cell.asJs()` and object helpers. */
export interface CellAsJsOptions {
  /** Integer conversion mode. Defaults to `"number-or-bigint"`. */
  readonly int64?: Int64Mode;
  /** Parse JSON cells into JavaScript values. Defaults to `true`. */
  readonly parseJson?: boolean;
  /** Decode text and JSON cells as UTF-8 strings. Defaults to `true`. */
  readonly decodeText?: boolean;
}

/** Runtime cell kind returned by Velr result tables. */
export type CellType = "null" | "bool" | "int64" | "double" | "text" | "json";

/** JSON value returned when JSON cells are parsed. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** JavaScript value returned from `Cell.asJs()`. */
export type CellValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Result returned by `migrate()`. */
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

/** Why Velr is requesting embeddings from a registered vector embedder. */
export type VectorEmbeddingPurpose = "index_entity" | "query";

/** Entity type being embedded for a vector index. */
export type VectorEntityKind = "node" | "relationship";

/** Velr property value type seen by a vector embedding callback. */
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

/** Single property field passed to a vector embedding callback. */
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

/** Batch input passed to a registered vector embedding callback. */
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

/**
 * One embedding vector returned by a vector embedder.
 *
 * The vector length must match `VectorEmbeddingInput.dimensions`.
 */
export type VectorEmbedding = readonly number[] | Float32Array;

/**
 * Synchronous vector embedding callback used by the direct driver.
 *
 * Return one embedding for each input in the same order. The worker driver uses
 * `VelrWorkerVectorEmbedder`, which may return a promise.
 */
export type VectorEmbedder = (
  inputs: readonly VectorEmbeddingInput[]
) => readonly VectorEmbedding[];

/** Top-level metadata for one explain plan. */
export interface ExplainPlanMeta {
  /** Stable plan identifier assigned by Velr. */
  readonly planId: string;
  /** Cypher statement explained by this plan. */
  readonly cypher: string;
  /** Number of execution steps in the plan. */
  readonly stepCount: number;
}

/** Metadata for one step in an explain plan. */
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

/** Metadata for one SQL statement inside an explain step. */
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

/** SQL statement plus SQLite plan details returned by `ExplainTrace.snapshot()`. */
export interface ExplainStatement extends ExplainStatementMeta {
  /** Raw SQLite `EXPLAIN QUERY PLAN` detail rows. */
  readonly sqlitePlan: readonly string[];
}

/** Explain step plus all SQL statements returned by `ExplainTrace.snapshot()`. */
export interface ExplainStep extends ExplainStepMeta {
  /** SQL statements emitted by this step. */
  readonly statements: readonly ExplainStatement[];
}

/** Full explain plan returned by `ExplainTrace.snapshot()`. */
export interface ExplainPlan extends ExplainPlanMeta {
  /** Execution steps in display order. */
  readonly steps: readonly ExplainStep[];
}
