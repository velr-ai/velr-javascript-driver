import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { Velr } from "../src/index.js";

const runNativeTests = process.env.VELR_JS_NATIVE_TESTS === "1";

describe.skipIf(!runNativeTests)("query cancellation and deadlines", () => {
  const seedCancellation = "UNWIND range(1, 220) AS i CREATE (:StopFixture {i: i})";
  const slowQuery = "MATCH (a:StopFixture), (b:StopFixture), (c:StopFixture) RETURN sum(a.i + b.i + c.i) AS total";

  it("enforces synchronous deadlines during execution and deferred fetch", async () => {
    const db = Velr.open(null);
    try {
      db.run(seedCancellation);
      expect(() => db.run(slowQuery, { timeoutMs: 20 })).toThrow(
        expect.objectContaining({ stopReason: "deadline_exceeded" })
      );
      const table = db.execOne("UNWIND range(1, 3) AS i RETURN i", { timeoutMs: 500 });
      try {
        const rows = table.rows();
        expect(rows.next()?.[0]?.asJs()).toBe(1);
        await delay(550);
        expect(() => rows.next()).toThrow(expect.objectContaining({ stopReason: "deadline_exceeded" }));
      } finally {
        table.close();
      }
      expect(db.query("RETURN 1 AS value")).toEqual([{ value: 1 }]);
    } finally {
      db.close();
    }
  });

  it("enforces worker cancellation and deadlines during execution and deferred fetch", async () => {
    const workerEntry = new URL("../dist/worker/index.js", import.meta.url);
    const worker = await import(workerEntry.href) as typeof import("../src/worker/index.js");
    const db = await worker.VelrWorker.open(null);
    try {
      await db.run(seedCancellation);
      await expect(db.run(slowQuery, { timeoutMs: 20 })).rejects.toMatchObject({
        stopReason: "deadline_exceeded"
      });
      const running = new AbortController();
      const query = db.run(slowQuery, { signal: running.signal });
      const timer = setTimeout(() => running.abort(), 25);
      try {
        await expect(query).rejects.toMatchObject({ stopReason: "cancelled" });
      } finally {
        clearTimeout(timer);
      }

      const stream = await db.exec("UNWIND range(1, 3) AS i RETURN i", { timeoutMs: 750 });
      try {
        const table = await stream.nextTable();
        if (!table) throw new Error("expected a result table");
        try {
          const rows = await table.rows();
          expect((await rows.next())?.[0]?.asJs()).toBe(1);
          await delay(800);
          await expect(rows.next()).rejects.toMatchObject({ stopReason: "deadline_exceeded" });
        } finally {
          await table.close();
        }
      } finally {
        await stream.close();
      }

      const tx = await db.beginTx();
      try {
        const fetching = new AbortController();
        const table = await tx.execOne("UNWIND range(1, 3) AS i RETURN i", { signal: fetching.signal });
        try {
          const rows = await table.rows();
          expect((await rows.next())?.[0]?.asJs()).toBe(1);
          fetching.abort();
          await expect(rows.next()).rejects.toMatchObject({ stopReason: "cancelled" });
        } finally {
          await table.close();
        }
        expect(await tx.query("RETURN 2 AS value")).toEqual([{ value: 2 }]);
      } finally {
        await tx.rollback();
      }
      expect(await db.query("RETURN 1 AS value")).toEqual([{ value: 1 }]);
    } finally {
      await db.close();
    }
  });
});
