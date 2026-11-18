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
 * `ParameterMissing`, and `ArithmeticError`.
 */
export class VelrError extends Error {
  /** Optional numeric operation status, separate from the Cypher error category. */
  readonly code?: number;

  /** Create an error with diagnostic `message`, optional numeric `code`, and underlying `cause`. */
  constructor(message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message, options);
    this.name = "VelrError";
    this.code = options.code;
  }

  /**
   * Returns `"cancelled"` for an aborted query and `"deadline_exceeded"` for
   * an expired query timeout. Returns `undefined` for other errors.
   * Query calls and result reads can both report these outcomes.
   */
  get stopReason(): "cancelled" | "deadline_exceeded" | undefined {
    if (this.code === -5) return "cancelled";
    if (this.code === -6) return "deadline_exceeded";
  }
}

/**
 * Error used by driver guards for closed or consumed handles.
 *
 * Worker handles invalidated by parent closure or another handle operation may
 * reject with an ordinary `Error` instead. A worker handle's local `closed`
 * property does not establish whether its parent and worker-side resource remain valid.
 */
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
