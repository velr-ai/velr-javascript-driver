import { Cell, Table, Velr, type CreateOptions } from "../dist/index.js";
import { VelrWorker, VelrWorkerTable } from "../dist/worker/index.js";

// Public value construction remains available.
new Cell("int64", 42n);

// Creation options remain public after internal declarations are filtered.
const creationOptions: CreateOptions = { inlineEdgeProperties: ["weight"] };
const configured = Velr.create(null, creationOptions);
const selected: string[] = configured.inlineEdgeProperties();
void selected;
void VelrWorker.create(null, creationOptions);

// Factory-created handles must not expose native constructors or ownership hooks.
// @ts-expect-error Tables are returned by query methods.
new Table();
// @ts-expect-error Worker tables are returned by query methods.
new VelrWorkerTable();
// @ts-expect-error Raw native cells are not part of the application API.
Cell.fromRaw({});
// @ts-expect-error Parent ownership is internal to the driver.
Velr.open().registerChild({ close() {} });
