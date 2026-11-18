import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// stripInternal removes native constructors. Keep these handles non-constructible
// in the public declarations rather than implying a default public constructor.
const handles = new Set([
  "Stream", "StreamTx", "Table", "Rows", "ExplainTrace", "VelrTx", "Savepoint",
  "VelrWorker", "VelrWorkerStream", "VelrWorkerStreamTx", "VelrWorkerTable",
  "VelrWorkerRows", "VelrWorkerExplainTrace", "VelrWorkerTx", "VelrWorkerSavepoint",
]);
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { visit(path); continue; }
    if (!entry.name.endsWith(".d.ts")) continue;
    let text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];
    for (const node of source.statements) {
      // Ownership interfaces describe internal methods removed by stripInternal.
      // Remove them only from declarations; preserve the original source types.
      if (ts.isInterfaceDeclaration(node)
        && ["ParentHandle", "ChildHandle"].includes(node.name.text)) {
        edits.push([node.getFullStart(), node.end, ""]);
      }
      if (ts.isClassDeclaration(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          const visible = clause.types.filter((type) =>
            !["ParentHandle", "ChildHandle"].includes(type.expression.getText(source)));
          if (visible.length !== clause.types.length) {
            edits.push([clause.getStart(source), clause.end,
              visible.length ? "implements " + visible.map((type) => type.getText(source)).join(", ") : ""]);
          }
        }
      }
      if (ts.isClassDeclaration(node) && handles.has(node.name?.text)
        && !node.members.some(ts.isConstructorDeclaration)) {
        edits.push([node.members.pos, node.members.pos, "\n    private constructor();"]);
      }
    }
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
      text = text.slice(0, start) + replacement + text.slice(end);
    }
    writeFileSync(path, text);
  }
}
visit(dist);
