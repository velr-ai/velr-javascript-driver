import { realpathSync } from "node:fs";

import { VelrError, VelrTypeError } from "./errors.js";
import { getBindings, isNullPointer, queryControlAddress, queryControlFromAddress, type NativePointer } from "./ffi/koffi.js";
import type { QueryOptions } from "./types.js";

const MAX_TIMEOUT_NS = (1n << 64n) - 1n;

export const workerQueryControl = Symbol("worker query control");
export type InternalQueryOptions = QueryOptions & { [workerQueryControl]?: NativePointer };

export interface QueryControlRef {
  readonly address: bigint;
  readonly libraryPath: string;
}

/** An owning native reference. A query or result has its own copy of the control. */
export function createQueryControl(timeoutMs?: number) {
  let timeoutNs = 0n;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new VelrTypeError("timeoutMs must be a finite non-negative number");
    }
    const scaled = Math.ceil(timeoutMs * 1_000_000);
    if (scaled > Number(MAX_TIMEOUT_NS)) {
      throw new VelrTypeError("timeoutMs is outside the supported range");
    }
    timeoutNs = scaled === 0 ? 1n : BigInt(scaled);
    if (timeoutNs > MAX_TIMEOUT_NS) timeoutNs = MAX_TIMEOUT_NS;
  }

  const { lib, resolution } = getBindings();
  const { velr_query_control_new: create, velr_query_control_cancel: cancel, velr_query_control_free: free } = lib;
  if (!create || !cancel || !free) {
    throw new VelrError("loaded Velr runtime does not support query cancellation or deadlines");
  }
  const ptr = create(timeoutNs);
  if (isNullPointer(ptr)) throw new VelrError("the runtime could not create query cancellation control");

  return {
    ptr,
    cancel: () => cancel(ptr),
    free: () => free(ptr),
    ref: (): QueryControlRef => ({ address: queryControlAddress(ptr), libraryPath: resolution.libraryPath })
  };
}

/** Reconstruct a borrowed reference while the caller's owning reference is active. */
export function borrowQueryControl(ref: QueryControlRef): NativePointer {
  const { resolution } = getBindings();
  if (realpathSync(ref.libraryPath) !== realpathSync(resolution.libraryPath)) {
    throw new VelrError("the Velr worker and caller must use the same runtime for query cancellation");
  }
  return queryControlFromAddress(ref.address);
}
