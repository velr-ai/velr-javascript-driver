/**
 * Base error thrown for failures reported by the Velr runtime.
 *
 * For openCypher errors, `message` identifies the query error category and
 * compile-time or runtime phase, followed by diagnostic context. A numeric
 * operation status is exposed through `code` when available; it is separate
 * from the query error category.
 *
 * Query execution and result iteration can both throw this error.
 * Query categories include `SyntaxError`, `TypeError`, `ArgumentError`,
 * `EntityNotFound`, `ConstraintVerificationFailed`, `SemanticError`,
 * `ParameterMissing`, `ProcedureNotFound`, and `ArithmeticError`.
 */
export class VelrError extends Error {
  /** Optional numeric operation status, separate from the Cypher error category. */
  readonly code?: number;

  /** Create a Velr runtime error. */
  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options);
    this.name = "VelrError";
    this.code = options.code;
  }
}

/** Error thrown when an operation is attempted on a closed or consumed handle. */
export class VelrStateError extends VelrError {
  /** Create a Velr state error. */
  constructor(message: string) {
    super(message);
    this.name = "VelrStateError";
  }
}

/** Error thrown for invalid JavaScript arguments before calling the runtime. */
export class VelrTypeError extends TypeError {
  /** Create a Velr argument/type error. */
  constructor(message: string) {
    super(message);
    this.name = "VelrTypeError";
  }
}
