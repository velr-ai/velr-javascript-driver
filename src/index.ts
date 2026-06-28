/**
 * JavaScript and TypeScript bindings for Velr.
 *
 * The root module exports the synchronous driver. Import `@velr-ai/velr/worker`
 * for the worker-thread async driver with the same high-level API shape.
 *
 * @packageDocumentation
 */
export {
  Cell,
  ExplainTrace,
  Rows,
  Savepoint,
  Stream,
  StreamTx,
  Table,
  Velr,
  VelrTx
} from "./driver.js";
export { VelrError, VelrStateError, VelrTypeError } from "./errors.js";
export type {
  CellAsJsOptions,
  CellType,
  CellValue,
  ExplainPlan,
  ExplainPlanMeta,
  ExplainStatement,
  ExplainStatementMeta,
  ExplainStep,
  ExplainStepMeta,
  Int64Mode,
  JsonValue,
  MigrationReport,
  QueryOptions,
  QueryParams,
  QueryScalar,
  QueryValue,
  VectorEmbedder,
  VectorEmbedding,
  VectorEmbeddingField,
  VectorEmbeddingInput,
  VectorEmbeddingPurpose,
  VectorEntityKind,
  VectorPropertyValueType
} from "./types.js";
