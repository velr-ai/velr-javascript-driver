import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Velr } from "@velr-ai/velr";
import { VelrWorker } from "@velr-ai/velr/worker";

// Run from a consumer directory with the packed driver and runtime installed.
for (const variable of ["VELR_NATIVE_LIBRARY", "VELR_LIB"]) {
  assert.equal(process.env[variable], undefined, `unexpected runtime override ${variable}`);
}

const slowQuery = "UNWIND range(1, 10000) AS a UNWIND range(1, 10000) AS b RETURN sum(a * b)";
const rowsQuery = "UNWIND [1, 2] AS n RETURN n";
const sync = Velr.open(null);
try {
  assert.throws(() => sync.run(slowQuery, { timeoutMs: 30 }), {
    stopReason: "deadline_exceeded",
  });
} finally {
  sync.close();
}

const worker = await VelrWorker.open(null);
try {
  const running = new AbortController();
  const interrupted = worker.run(slowQuery, { signal: running.signal });
  const timer = setTimeout(() => running.abort(), 30);
  try {
    await assert.rejects(interrupted, { stopReason: "cancelled" });
  } finally {
    clearTimeout(timer);
  }

  const controller = new AbortController();
  const table = await worker.execOne(rowsQuery, {
    signal: controller.signal,
  });
  try {
    const rows = await table.rows();
    assert.equal((await rows.next())?.[0]?.asJs(), 1);
    controller.abort();
    await assert.rejects(rows.next(), { stopReason: "cancelled" });
  } finally {
    await table.close();
  }

  const deadline = await worker.execOne(rowsQuery, { timeoutMs: 750 });
  try {
    const rows = await deadline.rows();
    assert.equal((await rows.next())?.[0]?.asJs(), 1);
    await delay(800);
    await assert.rejects(rows.next(), { stopReason: "deadline_exceeded" });
  } finally {
    await deadline.close();
  }
  assert.deepEqual(await worker.query("RETURN 42 AS n"), [{ n: 42 }]);
} finally {
  await worker.close();
}
