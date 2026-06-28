import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Cell, Velr, type VectorEmbedder } from "../src/index.js";
import type { VelrWorker, VelrWorkerVectorEmbedder } from "../src/worker/index.js";

const runNativeTests = process.env.VELR_JS_NATIVE_TESTS === "1";
const runNativeFeatureTests = process.env.VELR_JS_NATIVE_FEATURE_TESTS === "1";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missingRuntime(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes("Unable to locate the Velr native runtime") ||
    message.includes("native library from VELR_NATIVE_LIBRARY/VELR_LIB does not exist") ||
    message.includes("does not expose")
  );
}

function vectorUnavailable(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes("vector-usearch") ||
    message.includes("no such procedure") ||
    message.includes("does not expose velr_register_vector_embedder")
  );
}

function openOrSkip(): Velr | null {
  if (!runNativeTests) return null;
  try {
    return Velr.open(null);
  } catch (err) {
    if (missingRuntime(err)) return null;
    throw err;
  }
}

function openFeatureDbOrSkip(): { db: Velr; [Symbol.dispose](): void } | null {
  if (!runNativeTests) return null;
  const dir = mkdtempSync(join(tmpdir(), "velr-js-feature-"));
  let db: Velr;
  try {
    db = Velr.open(join(dir, "graph.db"));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (missingRuntime(err)) return null;
    throw err;
  }

  return {
    db,
    [Symbol.dispose]() {
      try {
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

async function openWorkerOrSkip(): Promise<VelrWorker | null> {
  if (!runNativeTests) return null;
  const workerModule = await loadBuiltWorkerModuleOrSkip();
  if (!workerModule) return null;
  try {
    return await workerModule.VelrWorker.open(null);
  } catch (err) {
    if (missingRuntime(err)) return null;
    throw err;
  }
}

async function loadBuiltWorkerModuleOrSkip(): Promise<
  (typeof import("../src/worker/index.js")) | null
> {
  if (!runNativeTests) return null;
  const builtWorkerUrl = new URL("../dist/worker/index.js", import.meta.url);
  if (!existsSync(builtWorkerUrl)) return null;
  return import(builtWorkerUrl.href) as Promise<typeof import("../src/worker/index.js")>;
}

function directValues(db: Velr, label: string): string[] {
  return db
    .query<{ value: string }>(`MATCH (n:${label}) RETURN n.k AS value ORDER BY value`)
    .map((row) => row.value);
}

function directCount(db: Velr, label: string): number {
  return db.query<{ count: number }>(`MATCH (n:${label}) RETURN count(n) AS count`, {
    int64: "number"
  })[0]!.count;
}

function expectSidecarMemoryError(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    expect(errorMessage(err)).toContain("file-backed database");
    return err;
  }
  throw new Error("expected sidecar index creation to reject in-memory database");
}

async function workerValues(db: VelrWorker, label: string): Promise<string[]> {
  return (
    await db.query<{ value: string }>(`MATCH (n:${label}) RETURN n.k AS value ORDER BY value`)
  ).map((row) => row.value);
}

async function workerCount(db: VelrWorker, label: string): Promise<number> {
  return (
    await db.query<{ count: number }>(`MATCH (n:${label}) RETURN count(n) AS count`, {
      int64: "number"
    })
  )[0]!.count;
}

describe("Velr JavaScript driver", () => {
  it("converts cells to idiomatic JavaScript values", () => {
    expect(new Cell("null").asJs()).toBeNull();
    expect(new Cell("bool", 1n).asJs()).toBe(true);
    expect(new Cell("int64", 41n).asJs()).toBe(41);
    expect(new Cell("int64", 9_007_199_254_740_993n).asJs()).toBe(9_007_199_254_740_993n);
    expect(new Cell("json", 0n, 0, Buffer.from('{"ok":true}', "utf8")).asJs()).toEqual({
      ok: true
    });
  });

  it("runs a basic query with parameters", () => {
    using db = openOrSkip();
    if (!db) return;

    db.run(`
      CREATE (:Person {name: 'Ada', age: 37}),
             (:Person {name: 'Grace', age: 41})
    `);

    const rows = db.query<{ name: string; age: number }>(
      `
      MATCH (p:Person)
      WHERE p.age >= $minAge
      RETURN p.name AS name, p.age AS age
      ORDER BY age
      `,
      { params: { minAge: 38 }, int64: "number" }
    );

    expect(rows).toEqual([{ name: "Grace", age: 41 }]);
  });

  it("supports transaction helper rollback on throw", () => {
    using db = openOrSkip();
    if (!db) return;

    expect(() =>
      db.transaction((tx) => {
        tx.run("CREATE (:Temp {name: 'rolled back'})");
        throw new Error("stop");
      })
    ).toThrow("stop");

    const rows = db.query<{ count: number }>(
      "MATCH (n:Temp) RETURN count(n) AS count",
      { int64: "number" }
    );
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("matches Python transaction commit and rollback coverage in the direct driver", () => {
    using db = openOrSkip();
    if (!db) return;

    {
      using tx = db.beginTx();
      tx.run("CREATE (:TxDefaultRollback {k:'rolled_back'})");
    }
    expect(directCount(db, "TxDefaultRollback")).toBe(0);

    const rolledBack = db.beginTx();
    rolledBack.run("CREATE (:TxManualRollback {k:'rolled_back'})");
    rolledBack.rollback();
    expect(directCount(db, "TxManualRollback")).toBe(0);

    const committed = db.beginTx();
    committed.run("CREATE (:TxManualCommit {k:'committed'})");
    expect(committed.query<{ value: string }>(
      "MATCH (n:TxManualCommit) RETURN n.k AS value"
    )).toEqual([{ value: "committed" }]);
    committed.commit();
    expect(directValues(db, "TxManualCommit")).toEqual(["committed"]);

    db.transaction((tx) => {
      tx.run("CREATE (:TxHelperCommit {k:'auto_committed'})");
    });
    expect(directValues(db, "TxHelperCommit")).toEqual(["auto_committed"]);
  });

  it("matches Python scoped savepoint coverage in the direct driver", () => {
    using db = openOrSkip();
    if (!db) return;

    const rollbackTx = db.beginTx();
    rollbackTx.run("CREATE (:ScopedRollback {k:'outer'})");
    const rolledBack = rollbackTx.savepoint();
    rollbackTx.run("CREATE (:ScopedRollback {k:'inner'})");
    rolledBack.rollback();
    rollbackTx.run("CREATE (:ScopedRollback {k:'after'})");
    rollbackTx.commit();
    expect(directValues(db, "ScopedRollback")).toEqual(["after", "outer"]);

    const releaseTx = db.beginTx();
    releaseTx.run("CREATE (:ScopedRelease {k:'outer'})");
    const released = releaseTx.savepoint();
    releaseTx.run("CREATE (:ScopedRelease {k:'inner'})");
    released.release();
    releaseTx.commit();
    expect(directValues(db, "ScopedRelease")).toEqual(["inner", "outer"]);

    const helperSuccessTx = db.beginTx();
    helperSuccessTx.run("CREATE (:ScopedHelperSuccess {k:'outer'})");
    helperSuccessTx.withSavepoint(() => {
      helperSuccessTx.run("CREATE (:ScopedHelperSuccess {k:'inner'})");
    });
    helperSuccessTx.commit();
    expect(directValues(db, "ScopedHelperSuccess")).toEqual(["inner", "outer"]);

    const helperRollbackTx = db.beginTx();
    helperRollbackTx.run("CREATE (:ScopedHelperRollback {k:'outer'})");
    expect(() =>
      helperRollbackTx.withSavepoint(() => {
        helperRollbackTx.run("CREATE (:ScopedHelperRollback {k:'inner'})");
        throw new Error("boom");
      })
    ).toThrow("boom");
    helperRollbackTx.run("CREATE (:ScopedHelperRollback {k:'after'})");
    helperRollbackTx.commit();
    expect(directValues(db, "ScopedHelperRollback")).toEqual(["after", "outer"]);
  });

  it("matches Python named savepoint coverage in the direct driver", () => {
    using db = openOrSkip();
    if (!db) return;

    const handleRollbackTx = db.beginTx();
    handleRollbackTx.run("CREATE (:NamedHandleRollback {k:'outer'})");
    const rollbackHandle = handleRollbackTx.savepointNamed("sp1");
    handleRollbackTx.run("CREATE (:NamedHandleRollback {k:'inner'})");
    rollbackHandle.rollback();
    handleRollbackTx.run("CREATE (:NamedHandleRollback {k:'after'})");
    handleRollbackTx.commit();
    expect(directValues(db, "NamedHandleRollback")).toEqual(["after", "outer"]);

    const handleReleaseTx = db.beginTx();
    handleReleaseTx.run("CREATE (:NamedHandleRelease {k:'outer'})");
    const releaseHandle = handleReleaseTx.savepointNamed("sp1");
    handleReleaseTx.run("CREATE (:NamedHandleRelease {k:'inner'})");
    releaseHandle.release();
    handleReleaseTx.commit();
    expect(directValues(db, "NamedHandleRelease")).toEqual(["inner", "outer"]);

    const releaseByNameTx = db.beginTx();
    releaseByNameTx.run("CREATE (:NamedReleaseByName {k:'outer'})");
    releaseByNameTx.savepointNamed("sp1");
    releaseByNameTx.run("CREATE (:NamedReleaseByName {k:'inner'})");
    releaseByNameTx.releaseSavepoint("sp1");
    expect(() => releaseByNameTx.rollbackTo("sp1")).toThrow(/no such savepoint/);
    releaseByNameTx.commit();
    expect(directValues(db, "NamedReleaseByName")).toEqual(["inner", "outer"]);

    const helperSuccessTx = db.beginTx();
    helperSuccessTx.withSavepointNamed("sp1", () => {
      helperSuccessTx.run("CREATE (:NamedHelperSuccess {k:'inner'})");
    });
    expect(() => helperSuccessTx.rollbackTo("sp1")).toThrow(/no such savepoint/);
    helperSuccessTx.commit();
    expect(directValues(db, "NamedHelperSuccess")).toEqual(["inner"]);

    const helperRollbackTx = db.beginTx();
    helperRollbackTx.run("CREATE (:NamedHelperRollback {k:'outer'})");
    expect(() =>
      helperRollbackTx.withSavepointNamed("sp1", () => {
        helperRollbackTx.run("CREATE (:NamedHelperRollback {k:'inner'})");
        throw new Error("boom");
      })
    ).toThrow("boom");
    helperRollbackTx.run("CREATE (:NamedHelperRollback {k:'after'})");
    expect(() => helperRollbackTx.rollbackTo("sp1")).toThrow(/no such savepoint/);
    helperRollbackTx.commit();
    expect(directValues(db, "NamedHelperRollback")).toEqual(["after", "outer"]);

    const outOfOrderReleaseTx = db.beginTx();
    outOfOrderReleaseTx.savepointNamed("sp1");
    outOfOrderReleaseTx.savepointNamed("sp2");
    expect(() => outOfOrderReleaseTx.releaseSavepoint("sp1")).toThrow(/top of the stack/);
    outOfOrderReleaseTx.rollback();

    const retainedTx = db.beginTx();
    const retained = retainedTx.savepointNamed("sp1");
    retainedTx.run("CREATE (:NamedRetained {k:'a'})");
    retainedTx.savepointNamed("sp2");
    retainedTx.run("CREATE (:NamedRetained {k:'b'})");
    retainedTx.rollbackTo("sp1");
    retainedTx.run("CREATE (:NamedRetained {k:'c'})");
    retainedTx.rollbackTo("sp1");
    retainedTx.run("CREATE (:NamedRetained {k:'d'})");
    retained.release();
    retainedTx.commit();
    expect(directValues(db, "NamedRetained")).toEqual(["d"]);

    const discardTx = db.beginTx();
    discardTx.savepointNamed("sp1");
    discardTx.run("CREATE (:NamedDiscard {k:'a'})");
    discardTx.savepointNamed("sp2");
    discardTx.run("CREATE (:NamedDiscard {k:'b'})");
    discardTx.rollbackTo("sp1");
    expect(() => discardTx.rollbackTo("sp2")).toThrow(/no such savepoint/);
    discardTx.commit();

    const closedHandleTx = db.beginTx();
    const closedHandle = closedHandleTx.savepointNamed("sp1");
    closedHandle.close();
    closedHandleTx.run("CREATE (:NamedClosedHandle {k:'inner'})");
    closedHandleTx.rollbackTo("sp1");
    closedHandleTx.commit();
    expect(directCount(db, "NamedClosedHandle")).toBe(0);

    const releaseAfterRollbackTx = db.beginTx();
    const releaseAfterRollback = releaseAfterRollbackTx.savepointNamed("sp1");
    releaseAfterRollbackTx.run("CREATE (:NamedReleaseAfterRollback {k:'inner'})");
    releaseAfterRollbackTx.rollbackTo("sp1");
    releaseAfterRollback.release();
    expect(() => releaseAfterRollbackTx.rollbackTo("sp1")).toThrow(/no such savepoint/);
    releaseAfterRollbackTx.commit();
    expect(directCount(db, "NamedReleaseAfterRollback")).toBe(0);

    const commitRetainedTx = db.beginTx();
    commitRetainedTx.run("CREATE (:NamedCommitRetained {k:'outer'})");
    commitRetainedTx.savepointNamed("sp1");
    commitRetainedTx.run("CREATE (:NamedCommitRetained {k:'a'})");
    commitRetainedTx.rollbackTo("sp1");
    commitRetainedTx.run("CREATE (:NamedCommitRetained {k:'c'})");
    commitRetainedTx.commit();
    expect(directValues(db, "NamedCommitRetained")).toEqual(["c", "outer"]);
  });

  it("binds Arrow IPC bytes through the direct driver when the runtime supports it", () => {
    using db = openOrSkip();
    if (!db) return;

    try {
      const source = db.execOne("UNWIND [1,2,3] AS id RETURN id AS id ORDER BY id");
      let ipc: Buffer;
      try {
        ipc = source.toArrowIpc();
      } finally {
        source.close();
      }

      db.bindArrowIpc("_ids_ipc", ipc);
      const rows = db.query<{ id: number }>(
        "UNWIND BIND('_ids_ipc') AS row RETURN row.id AS id ORDER BY id",
        { int64: "number" }
      );
      expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    } catch (err) {
      if (missingRuntime(err)) return;
      throw err;
    }
  });

  it("can create and query a fulltext index when the runtime supports it", () => {
    if (!runNativeFeatureTests) return;
    using featureDb = openFeatureDbOrSkip();
    if (!featureDb) return;
    const { db } = featureDb;

    try {
      db.run(`
        CREATE (:Paper {title: 'Vector Search', abstract: 'graph retrieval'}),
               (:Paper {title: 'Planner Notes', abstract: 'query planning'})
      `);
      db.run(`
        CREATE FULLTEXT INDEX paperText IF NOT EXISTS
        FOR (n:Paper) ON EACH [n.title, n.abstract]
      `);

      const rows = db.query(
        `
        CALL db.index.fulltext.queryNodes('paperText', 'title:vector')
        YIELD node, score
        RETURN node, score
        `
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } catch (err) {
      if (missingRuntime(err)) return;
      throw err;
    }
  });

  it("rejects sidecar-backed indexes on in-memory databases", () => {
    if (!runNativeFeatureTests) return;
    using db = openOrSkip();
    if (!db) return;

    try {
      expectSidecarMemoryError(() => {
        db.run("CREATE FULLTEXT INDEX memoryText FOR (n:Paper) ON EACH [n.title]");
      });
    } catch (err) {
      if (missingRuntime(err)) return;
      throw err;
    }

    try {
      db.run(`
        CREATE VECTOR INDEX memoryEmbedding
        FOR (n:Paper)
        ON EACH [n.title]
        OPTIONS { indexConfig: { dimensions: 3, metric: 'cosine' } }
      `);
    } catch (err) {
      if (vectorUnavailable(err)) return;
      expect(errorMessage(err)).toContain("file-backed database");
      return;
    }

    throw new Error("expected vector sidecar index creation to reject in-memory database");
  });

  it("can register a vector embedder when the runtime supports vector indexes", () => {
    if (!runNativeFeatureTests) return;
    using featureDb = openFeatureDbOrSkip();
    if (!featureDb) return;
    const { db } = featureDb;

    const embedder: VectorEmbedder = (inputs) =>
      inputs.map((input) => new Float32Array(input.dimensions).fill(1 / input.dimensions));

    try {
      db.registerVectorEmbedder("toy", embedder);
      db.run("CREATE (:Paper {title: 'Alpha', abstract: 'graph search'})");
      db.run(`
        CREATE VECTOR INDEX paperEmbedding IF NOT EXISTS
        FOR (n:Paper)
        ON EACH [n.title, n.abstract]
        OPTIONS {
          indexConfig: {
            dimensions: 3,
            metric: 'cosine',
            embedder: 'toy'
          }
        }
      `);
    } catch (err) {
      if (vectorUnavailable(err)) return;
      throw err;
    }
  });

  it("exposes the synchronous driver shape through async worker methods", async () => {
    const db = await openWorkerOrSkip();
    if (!db) return;

    try {
      await db.run(`
        CREATE (:Job {name: 'background'}),
               (:Job {name: 'foreground'})
      `);

      const rows = await db.query<{ name: string }>(
        "MATCH (j:Job) RETURN j.name AS name ORDER BY name"
      );
      expect(rows).toEqual([{ name: "background" }, { name: "foreground" }]);

      const table = await db.execOne("MATCH (j:Job) RETURN j.name AS name ORDER BY name");
      try {
        expect(await table.columnNames()).toEqual(["name"]);
        const collected = await table.collect((row) => row[0]!.asJs());
        expect(collected).toEqual(["background", "foreground"]);
      } finally {
        await table.close();
      }

      const stream = await db.exec("RETURN 1 AS one; RETURN 2 AS two");
      try {
        const seen: string[] = [];
        for await (const streamedTable of stream) {
          seen.push((await streamedTable.columnNames())[0]!);
          await streamedTable.close();
        }
        expect(seen).toEqual(["one", "two"]);
      } finally {
        await stream.close();
      }

      await expect(
        db.transaction(async (tx) => {
          await tx.run("CREATE (:RolledBack {name: 'nope'})");
          throw new Error("rollback please");
        })
      ).rejects.toThrow("rollback please");

      expect(
        await db.query<{ count: number }>(
          "MATCH (n:RolledBack) RETURN count(n) AS count",
          { int64: "number" }
        )
      ).toEqual([{ count: 0 }]);

      try {
        const source = await db.execOne("UNWIND [4,5,6] AS id RETURN id AS id ORDER BY id");
        let ipc: Buffer;
        try {
          ipc = await source.toArrowIpc();
        } finally {
          await source.close();
        }

        await db.bindArrowIpc("_ids_ipc_worker", ipc);
        expect(
          await db.query<{ id: number }>(
            "UNWIND BIND('_ids_ipc_worker') AS row RETURN row.id AS id ORDER BY id",
            { int64: "number" }
          )
        ).toEqual([{ id: 4 }, { id: 5 }, { id: 6 }]);
      } catch (err) {
        if (!missingRuntime(err)) throw err;
      }

      const defaultRollbackTx = await db.beginTx();
      await defaultRollbackTx.run("CREATE (:WorkerDefaultRollback {k:'rolled_back'})");
      await defaultRollbackTx.close();
      expect(await workerCount(db, "WorkerDefaultRollback")).toBe(0);

      const manualRollbackTx = await db.beginTx();
      await manualRollbackTx.run("CREATE (:WorkerManualRollback {k:'rolled_back'})");
      await manualRollbackTx.rollback();
      expect(await workerCount(db, "WorkerManualRollback")).toBe(0);

      const manualCommitTx = await db.beginTx();
      await manualCommitTx.run("CREATE (:WorkerManualCommit {k:'committed'})");
      expect(
        await manualCommitTx.query<{ value: string }>(
          "MATCH (n:WorkerManualCommit) RETURN n.k AS value"
        )
      ).toEqual([{ value: "committed" }]);
      await manualCommitTx.commit();
      expect(await workerValues(db, "WorkerManualCommit")).toEqual(["committed"]);

      await db.transaction(async (tx) => {
        await tx.run("CREATE (:WorkerHelperCommit {k:'auto_committed'})");
      });
      expect(await workerValues(db, "WorkerHelperCommit")).toEqual(["auto_committed"]);

      const scopedRollbackTx = await db.beginTx();
      await scopedRollbackTx.run("CREATE (:WorkerScopedRollback {k:'outer'})");
      const workerRolledBack = await scopedRollbackTx.savepoint();
      await scopedRollbackTx.run("CREATE (:WorkerScopedRollback {k:'inner'})");
      await workerRolledBack.rollback();
      await scopedRollbackTx.run("CREATE (:WorkerScopedRollback {k:'after'})");
      await scopedRollbackTx.commit();
      expect(await workerValues(db, "WorkerScopedRollback")).toEqual(["after", "outer"]);

      const scopedReleaseTx = await db.beginTx();
      await scopedReleaseTx.run("CREATE (:WorkerScopedRelease {k:'outer'})");
      const workerReleased = await scopedReleaseTx.savepoint();
      await scopedReleaseTx.run("CREATE (:WorkerScopedRelease {k:'inner'})");
      await workerReleased.release();
      await scopedReleaseTx.commit();
      expect(await workerValues(db, "WorkerScopedRelease")).toEqual(["inner", "outer"]);

      const scopedHelperSuccessTx = await db.beginTx();
      await scopedHelperSuccessTx.run("CREATE (:WorkerScopedHelperSuccess {k:'outer'})");
      await scopedHelperSuccessTx.withSavepoint(async () => {
        await scopedHelperSuccessTx.run("CREATE (:WorkerScopedHelperSuccess {k:'inner'})");
      });
      await scopedHelperSuccessTx.commit();
      expect(await workerValues(db, "WorkerScopedHelperSuccess")).toEqual(["inner", "outer"]);

      const scopedHelperRollbackTx = await db.beginTx();
      await scopedHelperRollbackTx.run("CREATE (:WorkerScopedHelperRollback {k:'outer'})");
      await expect(
        scopedHelperRollbackTx.withSavepoint(async () => {
          await scopedHelperRollbackTx.run("CREATE (:WorkerScopedHelperRollback {k:'inner'})");
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      await scopedHelperRollbackTx.run("CREATE (:WorkerScopedHelperRollback {k:'after'})");
      await scopedHelperRollbackTx.commit();
      expect(await workerValues(db, "WorkerScopedHelperRollback")).toEqual(["after", "outer"]);

      const namedHandleRollbackTx = await db.beginTx();
      await namedHandleRollbackTx.run("CREATE (:WorkerNamedHandleRollback {k:'outer'})");
      const workerRollbackHandle = await namedHandleRollbackTx.savepointNamed("sp1");
      await namedHandleRollbackTx.run("CREATE (:WorkerNamedHandleRollback {k:'inner'})");
      await workerRollbackHandle.rollback();
      await namedHandleRollbackTx.run("CREATE (:WorkerNamedHandleRollback {k:'after'})");
      await namedHandleRollbackTx.commit();
      expect(await workerValues(db, "WorkerNamedHandleRollback")).toEqual(["after", "outer"]);

      const namedHandleReleaseTx = await db.beginTx();
      await namedHandleReleaseTx.run("CREATE (:WorkerNamedHandleRelease {k:'outer'})");
      const workerReleaseHandle = await namedHandleReleaseTx.savepointNamed("sp1");
      await namedHandleReleaseTx.run("CREATE (:WorkerNamedHandleRelease {k:'inner'})");
      await workerReleaseHandle.release();
      await namedHandleReleaseTx.commit();
      expect(await workerValues(db, "WorkerNamedHandleRelease")).toEqual(["inner", "outer"]);

      const namedReleaseByNameTx = await db.beginTx();
      await namedReleaseByNameTx.run("CREATE (:WorkerNamedReleaseByName {k:'outer'})");
      await namedReleaseByNameTx.savepointNamed("sp1");
      await namedReleaseByNameTx.run("CREATE (:WorkerNamedReleaseByName {k:'inner'})");
      await namedReleaseByNameTx.releaseSavepoint("sp1");
      await expect(namedReleaseByNameTx.rollbackTo("sp1")).rejects.toThrow(/no such savepoint/);
      await namedReleaseByNameTx.commit();
      expect(await workerValues(db, "WorkerNamedReleaseByName")).toEqual(["inner", "outer"]);

      const namedHelperSuccessTx = await db.beginTx();
      await namedHelperSuccessTx.withSavepointNamed("sp1", async () => {
        await namedHelperSuccessTx.run("CREATE (:WorkerNamedHelperSuccess {k:'inner'})");
      });
      await expect(namedHelperSuccessTx.rollbackTo("sp1")).rejects.toThrow(/no such savepoint/);
      await namedHelperSuccessTx.commit();
      expect(await workerValues(db, "WorkerNamedHelperSuccess")).toEqual(["inner"]);

      const namedHelperRollbackTx = await db.beginTx();
      await namedHelperRollbackTx.run("CREATE (:WorkerNamedHelperRollback {k:'outer'})");
      await expect(
        namedHelperRollbackTx.withSavepointNamed("sp1", async () => {
          await namedHelperRollbackTx.run("CREATE (:WorkerNamedHelperRollback {k:'inner'})");
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      await namedHelperRollbackTx.run("CREATE (:WorkerNamedHelperRollback {k:'after'})");
      await expect(namedHelperRollbackTx.rollbackTo("sp1")).rejects.toThrow(/no such savepoint/);
      await namedHelperRollbackTx.commit();
      expect(await workerValues(db, "WorkerNamedHelperRollback")).toEqual(["after", "outer"]);

      const namedOutOfOrderReleaseTx = await db.beginTx();
      await namedOutOfOrderReleaseTx.savepointNamed("sp1");
      await namedOutOfOrderReleaseTx.savepointNamed("sp2");
      await expect(namedOutOfOrderReleaseTx.releaseSavepoint("sp1")).rejects.toThrow(
        /top of the stack/
      );
      await namedOutOfOrderReleaseTx.rollback();

      const namedRetainedTx = await db.beginTx();
      const workerRetained = await namedRetainedTx.savepointNamed("sp1");
      await namedRetainedTx.run("CREATE (:WorkerNamedRetained {k:'a'})");
      await namedRetainedTx.savepointNamed("sp2");
      await namedRetainedTx.run("CREATE (:WorkerNamedRetained {k:'b'})");
      await namedRetainedTx.rollbackTo("sp1");
      await namedRetainedTx.run("CREATE (:WorkerNamedRetained {k:'c'})");
      await namedRetainedTx.rollbackTo("sp1");
      await namedRetainedTx.run("CREATE (:WorkerNamedRetained {k:'d'})");
      await workerRetained.release();
      await namedRetainedTx.commit();
      expect(await workerValues(db, "WorkerNamedRetained")).toEqual(["d"]);

      const namedDiscardTx = await db.beginTx();
      await namedDiscardTx.savepointNamed("sp1");
      await namedDiscardTx.run("CREATE (:WorkerNamedDiscard {k:'a'})");
      await namedDiscardTx.savepointNamed("sp2");
      await namedDiscardTx.run("CREATE (:WorkerNamedDiscard {k:'b'})");
      await namedDiscardTx.rollbackTo("sp1");
      await expect(namedDiscardTx.rollbackTo("sp2")).rejects.toThrow(/no such savepoint/);
      await namedDiscardTx.commit();

      const namedClosedHandleTx = await db.beginTx();
      const workerClosedHandle = await namedClosedHandleTx.savepointNamed("sp1");
      await workerClosedHandle.close();
      await namedClosedHandleTx.run("CREATE (:WorkerNamedClosedHandle {k:'inner'})");
      await namedClosedHandleTx.rollbackTo("sp1");
      await namedClosedHandleTx.commit();
      expect(await workerCount(db, "WorkerNamedClosedHandle")).toBe(0);

      const namedReleaseAfterRollbackTx = await db.beginTx();
      const workerReleaseAfterRollback =
        await namedReleaseAfterRollbackTx.savepointNamed("sp1");
      await namedReleaseAfterRollbackTx.run(
        "CREATE (:WorkerNamedReleaseAfterRollback {k:'inner'})"
      );
      await namedReleaseAfterRollbackTx.rollbackTo("sp1");
      await workerReleaseAfterRollback.release();
      await expect(namedReleaseAfterRollbackTx.rollbackTo("sp1")).rejects.toThrow(
        /no such savepoint/
      );
      await namedReleaseAfterRollbackTx.commit();
      expect(await workerCount(db, "WorkerNamedReleaseAfterRollback")).toBe(0);

      const namedCommitRetainedTx = await db.beginTx();
      await namedCommitRetainedTx.run("CREATE (:WorkerNamedCommitRetained {k:'outer'})");
      await namedCommitRetainedTx.savepointNamed("sp1");
      await namedCommitRetainedTx.run("CREATE (:WorkerNamedCommitRetained {k:'a'})");
      await namedCommitRetainedTx.rollbackTo("sp1");
      await namedCommitRetainedTx.run("CREATE (:WorkerNamedCommitRetained {k:'c'})");
      await namedCommitRetainedTx.commit();
      expect(await workerValues(db, "WorkerNamedCommitRetained")).toEqual(["c", "outer"]);
    } finally {
      await db.close();
    }
  });

  it("accepts worker-local vector embedder callbacks at the type level", async () => {
    const embedder: VelrWorkerVectorEmbedder = async (inputs) =>
      inputs.map((input) => new Float32Array(input.dimensions).fill(0));

    expect(typeof embedder).toBe("function");
  });
});
