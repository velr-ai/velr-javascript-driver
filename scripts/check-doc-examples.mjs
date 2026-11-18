#!/usr/bin/env node
/** Execute the examples that consumers actually read, through public package exports. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultManifest = new URL("./doc-examples.json", import.meta.url);
const runnableLanguages = new Set(["js", "javascript", "mjs", "cjs", "ts", "typescript", "cypher"]);
const typescriptLanguages = new Set(["ts", "typescript"]);
const nonExecutableKinds = new Set(["installation", "configuration", "shell", "reference", "generated-reference"]);

function typescriptApi() {
  return createRequire(import.meta.url)("typescript");
}

function typeOnlyReference(code) {
  const ts = typescriptApi();
  const source = ts.createSourceFile("reference.ts", code, ts.ScriptTarget.Latest, true);
  return !source.parseDiagnostics.length && source.statements.length > 0 && source.statements.every((node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
    if (ts.isImportDeclaration(node)) return node.importClause?.isTypeOnly === true;
    if (ts.isExportDeclaration(node)) return node.isTypeOnly;
    if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
      return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true
        && !("body" in node && node.body);
    }
    return false;
  });
}

function slug(text) {
  return text.toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s/g, "-");
}

/** Inventory every Markdown fence; IDs stay stable when text above an example moves. */
export function extractFences(markdown, document) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const slugs = new Map();
  const ordinals = new Map();
  const fences = [];
  let heading = "introduction";
  let headingText = "Introduction";
  let headingLevel = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const title = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (title) {
      const base = slug(title[1]);
      const count = slugs.get(base) ?? 0;
      slugs.set(base, count + 1);
      heading = count ? `${base}-${count}` : base;
      headingText = title[1];
      headingLevel = line.trimStart().match(/^#+/)[0].length;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s]*)\s*(.*?)\s*$/);
    if (!opening) continue;
    const [, marker, rawLanguage, info] = opening;
    const lineNumber = index + 1;
    const code = [];
    let closed = false;
    while (++index < lines.length) {
      const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
        closed = true;
        break;
      }
      code.push(lines[index]);
    }
    if (!closed) throw new Error(`${document}:${lineNumber}: unterminated code fence`);
    const ordinal = (ordinals.get(heading) ?? 0) + 1;
    ordinals.set(heading, ordinal);
    const source = `${code.join("\n")}\n`;
    fences.push({ id: `${document}#${heading}:${ordinal}`, sourceKind: "fence", document, line: lineNumber, heading: headingText, headingLevel,
      language: rawLanguage.toLowerCase(), info, code: source,
      sha256: createHash("sha256").update(source).digest("hex") });
  }
  return fences;
}

/** Discover all shipped source programs, including nested directories, without relying on a fixed file list. */
export function discoverExamplePrograms(directory) {
  const programs = [];
  const languages = new Map([["ts", "ts"], ["mts", "ts"], ["js", "js"], ["mjs", "mjs"], ["cjs", "cjs"]]);
  const visit = (path, prefix) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = join(path, entry.name);
      const document = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { visit(target, document); continue; }
      const language = languages.get(entry.name.split(".").at(-1));
      if (!language) continue;
      assert.ok(entry.isFile(), `Shipped example must be a regular source file: ${document}`);
      const code = readFileSync(target, "utf8");
      programs.push({ id: document, sourceKind: "file", document, line: 1, language, code,
        sha256: createHash("sha256").update(code).digest("hex") });
    }
  };
  visit(directory, "examples");
  return programs;
}

/** Require an intentional classification and behavior check for every current fence. */
export function validateInventory(fences, manifest, generatedSignatures = new Set()) {
  assert.equal(manifest.version, 1, "unsupported documentation-example manifest version");
  assert.ok(manifest.fences && typeof manifest.fences === "object", "manifest.fences is required");
  const ids = new Set(fences.map((fence) => fence.id));
  assert.equal(ids.size, fences.length, "duplicate documentation example ID");
  const unknown = fences.filter((fence) => !Object.hasOwn(manifest.fences, fence.id)).map((fence) => fence.id);
  const stale = Object.keys(manifest.fences).filter((id) => !ids.has(id));
  assert.deepEqual(unknown, [], `unclassified documentation examples: ${unknown.join(", ")}`);
  assert.deepEqual(stale, [], `stale documentation classifications: ${stale.join(", ")}`);
  for (const fence of fences) {
    const entry = manifest.fences[fence.id];
    const at = `${fence.id} (${fence.document}:${fence.line})`;
    assert.equal(entry.language, fence.language, `${at}: fence language changed`);
    if (fence.sourceKind === "file") assert.equal(entry.kind, "run", `${at}: shipped source examples must execute`);
    if (runnableLanguages.has(fence.language)) {
      if (entry.kind === "generated-reference") {
        assert.ok(generatedSignatures.has(fence.id), `${at}: only verified generator signatures may be excluded from execution`);
        continue;
      }
      const allowed = fence.language === "cypher" ? ["cypher"] : typescriptLanguages.has(fence.language) ? ["run", "typecheck", "import"] : ["run"];
      assert.ok(allowed.includes(entry.kind), `${at}: executable languages cannot be skipped or classified as reference text`);
      if (entry.kind === "typecheck") {
        assert.ok(entry.reason?.trim(), `${at}: type-only examples need a reason`);
        assert.ok(typeOnlyReference(fence.code), `${at}: type-only classification cannot hide an executable program`);
      } else if (entry.kind === "import") {
        assert.ok(entry.reason?.trim(), `${at}: import-only examples need a reason`);
        assert.match(fence.code, /^\s*import\s*\{\s*\w+\s*\}\s*from\s*["']@velr-ai\/velr(?:\/worker)?["'];?\s*$/,
          `${at}: import-only classification must contain exactly one public value import`);
      } else {
        assert.ok(entry.checks?.length || entry.inlineAssertions, `${at}: a runnable example needs behavior assertions`);
        if (entry.inlineAssertions) {
          assert.match(fence.code, /(?:from\s+["']node:assert(?:\/strict)?["']|require\(["']node:assert(?:\/strict)?["']\))/,
            `${at}: inlineAssertions requires Node assert`);
          assert.match(fence.code, /\bassert(?:\.\w+)?\s*\(/, `${at}: no inline assertion call found`);
        }
      }
    } else {
      assert.ok(nonExecutableKinds.has(entry.kind), `${at}: non-executable fence needs an explicit classification`);
      assert.ok(entry.reason?.trim(), `${at}: classification needs a reason`);
      if (fence.language === "json") JSON.parse(fence.code);
    }
  }
}

/**
 * API.md adds one trailing declaration fence per generated declaration section.
 * Treat only those syntactically valid declarations as reference signatures;
 * any new fenced example in a comment must enter the explicit runnable inventory.
 * The generator --check is required before this recognizer is used.
 */
export function generatedApiSignatures(fences) {
  const ts = typescriptApi();
  const lastInSection = new Map();
  for (const fence of fences) if (fence.document === "API.md") lastInSection.set(fence.id.replace(/:\d+$/, ""), fence.id);
  const result = {};
  for (const fence of fences) {
    if (fence.document !== "API.md" || fence.language !== "ts"
        || lastInSection.get(fence.id.replace(/:\d+$/, "")) !== fence.id) continue;
    let signature = false;
    if (fence.headingLevel === 3 && fence.heading.includes(".")) {
      const parsed = ts.createSourceFile("signature.ts", `declare class Reference {\n${fence.code}\n}`, ts.ScriptTarget.Latest, true);
      const declaration = parsed.statements[0];
      signature = !parsed.parseDiagnostics.length && parsed.statements.length === 1
        && ts.isClassDeclaration(declaration) && declaration.members.length === 1
        && !declaration.members[0].body;
    } else if (fence.headingLevel === 2 && /^export\s+(?:interface|type)\s/.test(fence.code)) {
      const parsed = ts.createSourceFile("signature.ts", fence.code, ts.ScriptTarget.Latest, true);
      signature = !parsed.parseDiagnostics.length && parsed.statements.length === 1
        && (ts.isInterfaceDeclaration(parsed.statements[0]) || ts.isTypeAliasDeclaration(parsed.statements[0]));
    }
    if (signature) result[fence.id] = { language: "ts", kind: "generated-reference",
      reason: "Generator-produced declaration signature; API freshness and strict public declaration typechecking cover this reference, rather than executing it as a program." };
  }
  return result;
}

/** Use the configuration readers are told to install, with only harness paths/import retention overlaid. */
export function documentedTypeScriptConfig(fences, configurationId, files) {
  const fence = fences.find((candidate) => candidate.id === configurationId);
  assert.ok(fence && fence.document === "GUIDE.md" && fence.language === "json", "TypeScript compilation must use the GUIDE configuration JSON fence");
  const documented = JSON.parse(fence.code);
  assert.ok(documented.compilerOptions && typeof documented.compilerOptions === "object", "documented TypeScript configuration needs compilerOptions");
  return { ...documented, compilerOptions: { ...documented.compilerOptions,
    rootDir: "cases", outDir: "compiled", verbatimModuleSyntax: true }, files };
}

/** Match selected values without fixing query scores, diagnostic text, or object key order. */
export function matches(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Object.hasOwn(expected, "$oneOf")) return expected.$oneOf.some((option) => matches(actual, option));
    if (Object.hasOwn(expected, "$number")) {
      const bounds = expected.$number;
      return typeof actual === "number" && Number.isFinite(actual)
        && (bounds.min === undefined || actual >= bounds.min)
        && (bounds.max === undefined || actual <= bounds.max);
    }
    if (Object.hasOwn(expected, "$stringIncludes")) return typeof actual === "string" && actual.includes(expected.$stringIncludes);
    if (Object.hasOwn(expected, "$regex")) return typeof actual === "string" && new RegExp(expected.$regex, expected.flags ?? "").test(actual);
    if (Object.hasOwn(expected, "$arrayContains")) {
      return Array.isArray(actual) && (expected.$length === undefined || actual.length === expected.$length)
        && expected.$arrayContains.every((item) => actual.some((value) => matches(value, item)));
    }
    return actual !== null && typeof actual === "object"
      && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && matches(actual[key], value));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  return Object.is(actual, expected);
}

export function verifyChecks(checks, records, output, cwd) {
  for (const check of checks ?? []) {
    if (check.kind === "output") {
      const matching = records.filter((record) => (!check.level || record.level === check.level) && matches(record.args, check.match));
      assert.ok(check.count === undefined ? matching.length > 0 : matching.length === check.count,
        `expected console output ${JSON.stringify(check.match)}; got ${JSON.stringify(records)}`);
    } else if (check.kind === "text") {
      if (check.includes !== undefined) assert.ok(output.includes(check.includes), `missing output text ${JSON.stringify(check.includes)}`);
      else if (check.regex !== undefined) assert.match(output, new RegExp(check.regex, check.flags ?? ""));
      else throw new Error("text checks require includes or regex");
    } else if (check.kind === "file") {
      const target = resolve(cwd, check.path);
      assert.ok(!relative(cwd, target).startsWith("..") && !isAbsolute(relative(cwd, target)), "file check must stay in the example directory");
      assert.ok(existsSync(target), `expected example output file ${check.path}`);
      if (check.nonempty) assert.ok(readFileSync(target).length > 0, `empty example output file ${check.path}`);
    } else throw new Error(`unknown documentation assertion kind ${JSON.stringify(check.kind)}`);
  }
}

async function runProcess(command, args, options) {
  const started = performance.now();
  return await new Promise((finish) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 30000);
    child.stdout.setEncoding("utf8").on("data", (text) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
    const complete = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ code, signal, timedOut, error: error?.message, stdout, stderr,
        milliseconds: Math.round(performance.now() - started) });
    };
    child.on("error", (error) => complete(null, null, error));
    child.on("close", (code, signal) => complete(code, signal));
  });
}

const bootstrap = String.raw`
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
const records = [];
function normalize(value, seen = new Set()) {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && !Number.isFinite(value)) return { $numberText: String(value) };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: value.message,
      ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }) };
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, seen)]));
  } finally { seen.delete(value); }
}
for (const level of ["log", "info", "warn", "error", "debug"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    records.push({ level, args: args.map((item) => normalize(item)), text: format(...args) });
    original(...args);
  };
}
try {
  await import(pathToFileURL(process.argv[2]).href);
} finally {
  writeFileSync(process.argv[3], JSON.stringify(records, null, 2) + "\n");
}
`;

const publicExportsSmoke = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Velr } from "@velr-ai/velr";
import { VelrWorker } from "@velr-ai/velr/worker";
const require = createRequire(import.meta.url);
const cjs = require("@velr-ai/velr");
const workerCjs = require("@velr-ai/velr/worker");
assert.equal(typeof Velr.open, "function");
assert.equal(typeof VelrWorker.open, "function");
assert.equal(typeof workerCjs.VelrWorker.open, "function");
const db = cjs.Velr.open();
try { assert.deepEqual(db.query("RETURN 42 AS value"), [{ value: 42 }]); }
finally { db.close(); }
console.log("Public ESM root/worker and CommonJS root/worker exports resolve; native query passed.");
`;

function linkDependency(consumer, name) {
  const source = join(packageRoot, "node_modules", name);
  if (!existsSync(source)) throw new Error(`Documentation examples require ${name}. Install the package's development dependencies and optional apache-arrow peer before running this check.`);
  const target = join(consumer, "node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(realpathSync(source), target, "junction");
}

function cypherModule(fence, entry) {
  return `import { Velr } from "@velr-ai/velr";\nconst db = Velr.open("example.db");\ntry {\n`
    + (entry.setup ?? []).map((query) => `db.run(${JSON.stringify(query)});\n`).join("")
    + `console.log(db.query(${JSON.stringify(fence.code)}, ${JSON.stringify(entry.options ?? {})}));\n} finally { db.close(); }\n`;
}

export async function checkDocumentationExamples(options = {}) {
  const manifestPath = options.manifest ?? defaultManifest;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.documents, ["README.md", "GUIDE.md", "API.md"], "the example inventory must include README.md, GUIDE.md, and API.md");
  const fences = [
    ...manifest.documents.flatMap((document) => extractFences(readFileSync(join(packageRoot, document), "utf8"), document)),
    ...discoverExamplePrograms(join(packageRoot, "examples"))
  ];
  const generatedApiCheck = await runProcess(process.execPath, [join(packageRoot, "scripts/api-reference.mjs"), "--check"], { cwd: packageRoot });
  assert.equal(generatedApiCheck.code, 0, `Generated API reference is stale or invalid:\n${generatedApiCheck.stdout}${generatedApiCheck.stderr}`);
  const signatures = generatedApiSignatures(fences);
  for (const id of Object.keys(signatures)) assert.ok(!Object.hasOwn(manifest.fences, id), `Generated signatures must not obscure an explicit example: ${id}`);
  manifest.fences = { ...manifest.fences, ...manifest.sourceExamples, ...signatures };
  validateInventory(fences, manifest, new Set(Object.keys(signatures)));
  const compilerConfiguration = documentedTypeScriptConfig(fences, manifest.typescriptConfiguration, []);
  const inventory = fences.map(({ code, ...fence }) => ({ ...fence, kind: manifest.fences[fence.id].kind }));
  if (options.inventoryOnly) return { inventory };
  assert.ok(existsSync(join(packageRoot, "dist/index.js")) && existsSync(join(packageRoot, "dist/index.d.ts")), "Build the public package before checking documentation examples (npm run build).");
  const consumer = mkdtempSync(join(tmpdir(), "velr-doc-examples-"));
  const report = { node: process.version, inventory, generatedApiCheck, results: [], consumer };
  let success = false;
  try {
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "velr-doc-examples-consumer", private: true, type: "module" }));
    mkdirSync(join(consumer, "node_modules/@velr-ai"), { recursive: true });
    symlinkSync(packageRoot, join(consumer, "node_modules/@velr-ai/velr"), "junction");
    linkDependency(consumer, "@types/node");
    linkDependency(consumer, "apache-arrow");
    writeFileSync(join(consumer, "bootstrap.mjs"), bootstrap);
    writeFileSync(join(consumer, "public-exports.mjs"), publicExportsSmoke);
    const smoke = await runProcess(process.execPath, [join(consumer, "public-exports.mjs")], { cwd: consumer });
    report.publicExports = smoke;
    assert.equal(smoke.code, 0, `Public package/native runtime preflight failed:\n${smoke.stdout}${smoke.stderr}`);
    const cases = [];
    for (const [number, fence] of fences.entries()) {
      const entry = manifest.fences[fence.id];
      if (nonExecutableKinds.has(entry.kind)) continue;
      const directory = join(consumer, "cases", String(number + 1).padStart(3, "0"));
      mkdirSync(directory, { recursive: true });
      const extension = typescriptLanguages.has(fence.language) ? "mts" : fence.language === "cjs" || entry.module === "commonjs" ? "cjs" : "mjs";
      const sourcePath = join(directory, `example.${extension}`);
      writeFileSync(sourcePath, fence.language === "cypher" ? cypherModule(fence, entry) : fence.code);
      cases.push({ fence, entry, directory, sourcePath, extension });
    }
    const typescript = cases.filter((test) => test.extension === "mts");
    if (typescript.length) {
      compilerConfiguration.files = typescript.map((test) => relative(consumer, test.sourcePath));
      report.typescriptConfiguration = { fence: manifest.typescriptConfiguration, ...compilerConfiguration };
      writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(compilerConfiguration, null, 2));
      const require = createRequire(import.meta.url);
      const compiler = require.resolve("typescript/bin/tsc");
      const compiled = await runProcess(process.execPath, [compiler, "-p", join(consumer, "tsconfig.json")], { cwd: consumer, timeoutMs: 60000 });
      report.typescript = compiled;
      assert.equal(compiled.code, 0, `Documentation TypeScript does not compile against public exports:\n${compiled.stdout}${compiled.stderr}`);
    }
    for (const test of cases) {
      const { fence, entry, directory, sourcePath, extension } = test;
      if (entry.kind === "typecheck") {
        report.results.push({ id: fence.id, status: "typechecked", checks: 0 });
        continue;
      }
      const executable = extension === "mts" ? join(consumer, "compiled", relative(join(consumer, "cases"), sourcePath)).replace(/\.mts$/, ".mjs") : sourcePath;
      const resultPath = join(directory, "console.json");
      const result = await runProcess(process.execPath, [join(consumer, "bootstrap.mjs"), executable, resultPath], { cwd: directory, timeoutMs: entry.timeoutMs ?? 30000 });
      let failure;
      let records = [];
      try {
        assert.equal(result.code, 0, result.timedOut ? "example exceeded its process deadline (possible leaked handles)" : `example exited ${result.code}`);
        records = JSON.parse(readFileSync(resultPath, "utf8"));
        if (entry.kind === "import") assert.deepEqual(records, [], "import-only API example unexpectedly executed additional output");
        verifyChecks(entry.checks, records, result.stdout + result.stderr, directory);
      } catch (error) { failure = error.message; }
      report.results.push({ id: fence.id, status: failure ? "failed" : "passed", checks: (entry.checks?.length ?? 0) + (entry.inlineAssertions || entry.kind === "import" ? 1 : 0),
        ...result, records, ...(failure ? { failure } : {}) });
      console.log(`${failure ? "FAIL" : "PASS"} ${fence.id} (${result.milliseconds}ms)`);
      if (failure) console.error(`${failure}\n${result.stdout}${result.stderr}`);
    }
    const failures = report.results.filter((result) => result.status === "failed");
    assert.equal(failures.length, 0, `${failures.length} documentation example(s) failed; evidence: ${consumer}`);
    success = true;
    return report;
  } finally {
    report.passed = success;
    if (options.report) writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
    if (success && !options.keepTemp) rmSync(consumer, { recursive: true, force: true });
    else console.error(`Documentation example evidence retained at ${consumer}`);
  }
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--inventory") { options.inventoryOnly = true; options.inventoryJson = true; }
    else if (argument === "--inventory-only") options.inventoryOnly = true;
    else if (argument === "--keep-temp") options.keepTemp = true;
    else if (argument === "--report") options.report = process.argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  const report = await checkDocumentationExamples(options);
  const markdownCount = report.inventory.filter((example) => example.sourceKind === "fence").length;
  const sourceCount = report.inventory.filter((example) => example.sourceKind === "file").length;
  if (options.inventoryJson) console.log(JSON.stringify(report.inventory, null, 2));
  else if (options.inventoryOnly) console.log(`Validated all ${markdownCount} README/GUIDE/API fences and ${sourceCount} shipped source examples, with behavior assertions or explicit installation/configuration/generated-reference classifications.`);
  else console.log(`Checked all ${markdownCount} README/GUIDE/API fences and ${sourceCount} shipped source examples: ${report.results.length} compiled/executed programs; ${report.inventory.length - report.results.length} explicitly classified installation/configuration/reference fences.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}
