import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
const sources = ["src/driver.ts", "src/errors.ts", "src/types.ts", "src/worker/index.ts"];
const exported = (node) => node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hidden = (node) => node.modifiers?.some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))
  || (node.name && ts.isPrivateIdentifier(node.name))
  || node.jsDoc?.some((doc) => doc.tags?.some((tag) => tag.tagName.text === "internal"));
const documentation = (node) => (node.jsDoc ?? []).map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "").filter(Boolean).join("\n\n");
let output = `# JavaScript and TypeScript API reference

The root module exports the synchronous API; import \`@velr-ai/velr/worker\`
for the async worker API. This reference is generated from the same API comments
included in the published type declarations and editor help.

Start with the [README](README.md), see [task guides](GUIDE.md) for workflows, and
use the [query language reference](QUERY_LANGUAGE.md) for Cypher.

All result handles require their parents to remain open. Close cursors, tables,
streams, traces, and transactions when finished; connection close invalidates its
children. Close is idempotent. Database operations can fail both at query start
and during result reads. Direct operations throw \`VelrError\` for runtime/query
failures, \`VelrStateError\` for closed handles, or \`VelrTypeError\` for invalid
arguments/conversions. Worker operations reject promises. A worker child
invalidated through a parent can reject with an ordinary \`Error\`; its
\`closed\` flag records closure of that individual handle and can remain false
after parent closure. Keep parents open until their children are finished.
In-memory databases
cannot create fulltext or vector indexes. Use a file path for those features.

Direct callbacks are synchronous: returned promises are not awaited. This applies
to transactions, savepoint scopes, row visitors, and row mappers. The worker
counterparts await supported callbacks. Explicit transaction cancellation may end
the transaction; start a new one after it ends. Generic result types assert the
caller's expected shape and do not validate returned data.

`;
// Backticks in the prologue are escaped above to keep this source readable.
output = output.replaceAll("\`", "`");
const missing = [];
let documented = 0;
for (const file of sources) {
  const source = ts.createSourceFile(file, readText(resolve(root, file)), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).map((n) => [n.name?.text, n]));
  for (const node of source.statements) {
    if (!exported(node) || hidden(node)) continue;
    if (!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
    const name = node.name.text;
    const comment = documentation(node);
    if (!comment) missing.push(name);
    output += `## ${name}\n\n${comment}\n\n`;
    if (!ts.isClassDeclaration(node)) {
      output += `\`\`\`ts\n${node.getText(source)}\n\`\`\`\n\n`;
      if (ts.isInterfaceDeclaration(node)) {
        for (const member of node.members) {
          if (!documentation(member)) missing.push(`${name}.${member.name?.getText(source)}`);
          documented++;
        }
      }
      documented++;
      continue;
    }
    const baseName = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText(source);
    const inherited = classes.get(baseName)?.members ?? [];
    const names = new Set(node.members.map((n) => n.name?.getText(source)));
    const members = [...node.members, ...inherited.filter((n) => !names.has(n.name?.getText(source)) && !ts.isConstructorDeclaration(n))];
    for (const member of members) {
      if (hidden(member) || !member.name && !ts.isConstructorDeclaration(member)) continue;
      const memberName = member.name?.getText(source) ?? "constructor";
      const docs = documentation(member);
      if (!docs) missing.push(`${name}.${memberName}`);
      const signature = member.body ? member.getText(source).slice(0, member.body.pos - member.getStart(source)).trim() : member.getText(source).trim();
      output += `### ${name}.${memberName}\n\n${docs}\n\n\`\`\`ts\n${signature}\n\`\`\`\n\n`;
      documented++;
    }
  }
}
if (missing.length) throw new Error(`Missing public API comments: ${missing.join(", ")}`);
output = output.trimEnd() + "\n";
const outputPath = resolve(root, "API.md");
if (process.argv.includes("--check")) {
  if (readText(outputPath) !== output) throw new Error("API.md is stale; run npm run docs:api");
} else {
  writeFileSync(outputPath, output);
}
console.log(`Verified ${documented} public API declarations and fields; internal members are excluded.`);
