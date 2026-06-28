/**
 * Base error thrown for failures reported by the Velr runtime.
 *
 * Native C ABI status codes are exposed through `code` when the runtime
 * provides one.
 */
export class VelrError extends Error {
  /** Optional numeric status code returned by the Velr C ABI. */
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
