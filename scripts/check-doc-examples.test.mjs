import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverExamplePrograms, documentedTypeScriptConfig, extractFences, generatedApiSignatures, matches, validateInventory, verifyChecks } from "./check-doc-examples.mjs";

const fixtureSource = `/** Options for a query. */
export interface Options {
  /** Maximum result rows. */
  readonly limit?: number;
}
/** A connection.
 * Keep it open while reading results.
 */
export class Example {
  /** Execute a query. */
  run(
    query: string,
  ): void {}
}
`;

function withApiReferenceFixture(check) {
  // Keep the fixture under the package so the generator resolves its real TypeScript dependency.
  const root = mkdtempSync(fileURLToPath(new URL("../.api-reference-test-", import.meta.url)));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "src/worker"), { recursive: true });
    const generator = join(root, "scripts/api-reference.mjs");
    copyFileSync(fileURLToPath(new URL("./api-reference.mjs", import.meta.url)), generator);
    const sources = ["src/driver.ts", "src/errors.ts", "src/types.ts", "src/worker/index.ts"];
    for (const source of sources) writeFileSync(join(root, source), source === "src/driver.ts" ? fixtureSource : "");
    const run = (...args) => spawnSync(process.execPath, [generator, ...args], { cwd: root, encoding: "utf8" });
    check({ root, generator, sources, run, api: join(root, "API.md") });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("API reference generation and checks work with LF, CRLF, and mixed checkouts", () => {
  withApiReferenceFixture(({ root, generator, sources, run, api }) => {
    const initial = run();
    assert.equal(initial.status, 0, initial.stderr);
    const canonical = readFileSync(api, "utf8");
    assert.ok(!canonical.includes("\r"));
    for (const sourceEnding of ["\n", "\r\n"]) {
      for (const file of [...sources.map((source) => join(root, source)), generator]) {
        writeFileSync(file, readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n/g, sourceEnding));
      }
      for (const documentEnding of ["\n", "\r\n"]) {
        const checkedIn = canonical.replace(/\n/g, documentEnding);
        writeFileSync(api, checkedIn);
        const checked = run("--check");
        assert.equal(checked.status, 0, `${JSON.stringify({ sourceEnding, documentEnding })}: ${checked.stderr}`);
        assert.equal(readFileSync(api, "utf8"), checkedIn, "checks must not rewrite API.md");
      }
    }
    const regenerated = run();
    assert.equal(regenerated.status, 0, regenerated.stderr);
    assert.equal(readFileSync(api, "utf8"), canonical, "CRLF sources must generate canonical LF output");
  });
});

test("API reference checks still reject stale prose, changed contracts, and missing comments", () => {
  withApiReferenceFixture(({ root, run, api }) => {
    assert.equal(run().status, 0);
    const canonical = readFileSync(api, "utf8");
    writeFileSync(api, canonical.replace("Execute a query.", "Stale documentation."));
    const stale = run("--check");
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /API\.md is stale/);
    writeFileSync(api, canonical);
    writeFileSync(join(root, "src/driver.ts"), fixtureSource.replace("Execute a query.", "Execute a changed query."));
    const changed = run("--check");
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /API\.md is stale/);
    writeFileSync(join(root, "src/driver.ts"), fixtureSource.replace("  /** Execute a query. */\n", ""));
    const missing = run("--check");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing public API comments: Example\.run/);
  });
});

test("every shipped source program is discovered and new unclassified files fail coverage", () => {
  const directory = mkdtempSync(join(tmpdir(), "velr-doc-discovery-test-"));
  try {
    mkdirSync(join(directory, "nested"));
    for (const name of ["basic.ts", "extra.mts", "plain.js", "nested/module.mjs", "nested/common.cjs"]) {
      writeFileSync(join(directory, name), "console.log(1);\n");
    }
    writeFileSync(join(directory, "README.md"), "not a program\n");
    const programs = discoverExamplePrograms(directory);
    assert.deepEqual(programs.map((program) => program.id), ["examples/basic.ts", "examples/extra.mts", "examples/nested/common.cjs", "examples/nested/module.mjs", "examples/plain.js"]);
    assert.ok(programs.every((program) => program.sourceKind === "file" && program.sha256.length === 64));
    const fences = Object.fromEntries(programs.map((program) => [program.id, {
      language: program.language, kind: "run", checks: [{ kind: "output", match: [1] }]
    }]));
    validateInventory(programs, { version: 1, fences });
    writeFileSync(join(directory, "new.ts"), "console.log(2);\n");
    assert.throws(() => validateInventory(discoverExamplePrograms(directory), { version: 1, fences }), /unclassified.*examples\/new.ts/);
    fences[programs[0].id].kind = "typecheck";
    assert.throws(() => validateInventory(programs, { version: 1, fences }), /shipped source examples must execute/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("inventory includes installation, runnable modules, and Cypher with stable heading IDs", () => {
  const text = "# Intro\n```sh\nnpm install example\n```\n## **Query** values\n```ts\nimport { x } from 'example';\nconsole.log(x);\n```\n```cypher\nRETURN 1 AS value\n```\n";
  const fences = extractFences(text, "README.md");
  assert.deepEqual(fences.map(({ id, language, line }) => ({ id, language, line })), [
    { id: "README.md#intro:1", language: "sh", line: 2 },
    { id: "README.md#query-values:1", language: "ts", line: 6 },
    { id: "README.md#query-values:2", language: "cypher", line: 10 }
  ]);
  assert.equal(extractFences(`Preface\n\n${text}`, "README.md")[1].id, fences[1].id);
});

test("fences preserve exact source and ignore Markdown headings inside a program", () => {
  const fences = extractFences("## Example\n~~~~ts\n// # not a heading\nconst value = `a`;\n~~~~\n", "GUIDE.md");
  assert.equal(fences[0].code, "// # not a heading\nconst value = `a`;\n");
  assert.equal(fences[0].language, "ts");
  assert.equal(fences[0].sha256.length, 64);
});

test("unterminated fences fail the inventory", () => {
  assert.throws(() => extractFences("```js\nconsole.log(1)\n", "README.md"), /unterminated/);
});

test("every executable fence needs an explicit classification and a behavior assertion", () => {
  const fences = extractFences("## Query\n```js\nconsole.log(1);\n```\n", "README.md");
  assert.throws(() => validateInventory(fences, { version: 1, fences: {} }), /unclassified/);
  const manifest = { version: 1, fences: { [fences[0].id]: { language: "js", kind: "reference", reason: "skip" } } };
  assert.throws(() => validateInventory(fences, manifest), /cannot be skipped/);
  manifest.fences[fences[0].id].kind = "run";
  assert.throws(() => validateInventory(fences, manifest), /behavior assertions/);
  manifest.fences[fences[0].id].checks = [{ kind: "output", match: [1] }];
  validateInventory(fences, manifest);
});

test("new, removed, and relabeled examples cannot silently escape coverage", () => {
  const fences = extractFences("```ts\nconsole.log(1);\n```\n", "README.md");
  const entry = { language: "ts", kind: "run", checks: [{ kind: "output", match: [1] }] };
  assert.throws(() => validateInventory(fences, { version: 1, fences: { old: entry } }), /unclassified/);
  assert.throws(() => validateInventory([], { version: 1, fences: { old: entry } }), /stale/);
  assert.throws(() => validateInventory(fences, { version: 1, fences: { [fences[0].id]: { ...entry, language: "js" } } }), /language changed/);
});

test("Cypher and type-only examples are accounted for rather than skipped", () => {
  const fences = extractFences("```cypher\nRETURN 1 AS value\n```\n```ts\nexport type Name = string;\n```\n", "GUIDE.md");
  const manifest = { version: 1, fences: {
    [fences[0].id]: { language: "cypher", kind: "cypher", checks: [{ kind: "output", match: [[{ value: 1 }]] }] },
    [fences[1].id]: { language: "ts", kind: "typecheck", reason: "Public type reference" }
  } };
  validateInventory(fences, manifest);
  manifest.fences[fences[0].id].kind = "reference";
  assert.throws(() => validateInventory(fences, manifest), /cannot be skipped/);
});

test("executable TypeScript cannot be mislabeled as a type-only reference", () => {
  const fences = extractFences("```ts\nconsole.log('must run');\n```\n", "GUIDE.md");
  assert.throws(() => validateInventory(fences, { version: 1, fences: {
    [fences[0].id]: { language: "ts", kind: "typecheck", reason: "This is not a signature" }
  } }), /cannot hide an executable program/);
});

test("inline assertions require an actual Node assert import and call", () => {
  const fences = extractFences("```js\nconsole.log('assert');\n```\n", "README.md");
  const manifest = { version: 1, fences: { [fences[0].id]: { language: "js", kind: "run", inlineAssertions: true } } };
  assert.throws(() => validateInventory(fences, manifest), /requires Node assert/);
});

test("import-only reference examples preserve actual public value imports", () => {
  const fences = extractFences("## Velr\n```ts\nimport { Velr } from '@velr-ai/velr';\n```\n", "API.md");
  const manifest = { version: 1, fences: { [fences[0].id]: { language: "ts", kind: "import", reason: "Load the public module" } } };
  validateInventory(fences, manifest);
  fences[0].code += "console.log('unexpected program');\n";
  assert.throws(() => validateInventory(fences, manifest), /exactly one public value import/);
});

test("generated API signatures are recognized without hiding new comment examples", () => {
  const source = "## Velr\n```ts\nimport { Velr } from '@velr-ai/velr';\n```\n### Velr.open\n```ts\nconsole.log('new usage example');\n```\n```ts\nstatic open(path: string | null = null): Velr\n```\n## QueryOptions\n```ts\nexport interface QueryOptions { readonly timeoutMs?: number; }\n```\n";
  const fences = extractFences(source, "API.md");
  const signatures = generatedApiSignatures(fences);
  assert.deepEqual(Object.keys(signatures), ["API.md#velropen:2", "API.md#queryoptions:1"]);
  assert.throws(() => validateInventory(fences, { version: 1, fences: signatures }, new Set(Object.keys(signatures))), /unclassified/);
  assert.throws(() => validateInventory([fences[2]], { version: 1, fences: { [fences[2].id]: signatures[fences[2].id] } }), /only verified generator/);
});

test("compilation uses the exact documented TypeScript profile without widening libraries or skipping declarations", () => {
  const documented = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    lib: ["ES2022", "ESNext.Disposable"], types: ["node"], strict: true, outDir: "dist" }, include: ["*.mts"] };
  const fences = extractFences(`## TypeScript\n\`\`\`json\n${JSON.stringify(documented)}\n\`\`\`\n`, "GUIDE.md");
  const actual = documentedTypeScriptConfig(fences, fences[0].id, ["cases/001/example.mts"]);
  assert.deepEqual(actual, { ...documented, compilerOptions: { ...documented.compilerOptions,
    rootDir: "cases", outDir: "compiled", verbatimModuleSyntax: true }, files: ["cases/001/example.mts"] });
  assert.equal(Object.hasOwn(actual.compilerOptions, "skipLibCheck"), false);
  assert.equal(Object.hasOwn(actual.compilerOptions, "moduleDetection"), false);
  assert.throws(() => documentedTypeScriptConfig(fences, "missing", []), /GUIDE configuration/);
});

test("semantic output checks retain numeric scores, exact int64 values, and object fields", () => {
  const records = [{ level: "log", args: [[{ title: "Graph databases", score: 0.8, id: { $bigint: "9007199254740993" } }]] }];
  verifyChecks([{ kind: "output", match: [[{ title: "Graph databases", score: { $number: { min: 0, max: 1 } }, id: { $bigint: "9007199254740993" } }]] }], records, "", ".");
  assert.throws(() => verifyChecks([{ kind: "output", match: [[{ title: "Missing" }]] }], records, "", "."), /expected console output/);
  assert.equal(matches(Infinity, { $number: {} }), false);
  assert.equal(matches([{ label: "Paper" }, { label: "Chunk" }], { $arrayContains: [{ label: "Paper" }] }), true);
  assert.equal(matches([{ label: "Paper" }, { label: "Chunk" }], { $arrayContains: [{ label: "Paper" }], $length: 1 }), false);
  assert.equal(matches("cancelled", { $oneOf: ["cancelled", "deadline_exceeded"] }), true);
  assert.throws(() => verifyChecks([{ kind: "output", match: records[0].args, count: 2 }], records, "", "."), /expected console output/);
});

test("vector-score examples tolerate small floating differences and reject wrong results", () => {
  const entries = JSON.parse(readFileSync(new URL("./doc-examples.json", import.meta.url), "utf8")).fences;
  const verify = (id, args) => verifyChecks(entries[id].checks, [{ level: "log", args }], "", ".");
  const filtered = "GUIDE.md#candidate-filters-and-score-filters:1";
  verify(filtered, [[{ text: "Graph guide", score: 0.99999994 }]]);
  assert.throws(() => verify(filtered, [[{ text: "Graph guide", score: 0.99 }]]), /expected console output/);
  assert.throws(() => verify(filtered, [[{ text: "Wrong result", score: 1 }]]), /expected console output/);
  assert.throws(() => verify(filtered, [[{ text: "Graph guide", score: 1 }, { text: "Extra result", score: 1 }]]), /expected console output/);
  const scales = "GUIDE.md#stored-vector-indexes-and-score-scales:1";
  verify(scales, [0.50000006, -0.00000006, 0.5]);
  assert.throws(() => verify(scales, [0.51, 0, 0.5]), /expected console output/);
});

test("diagnostics and files require the requested evidence", () => {
  verifyChecks([{ kind: "text", includes: "deadline_exceeded" }], [], "deadline_exceeded", ".");
  assert.throws(() => verifyChecks([{ kind: "text", includes: "cancelled" }], [], "deadline_exceeded", "."), /missing output/);
  assert.throws(() => verifyChecks([{ kind: "file", path: "../outside" }], [], "", "."), /must stay/);
});
