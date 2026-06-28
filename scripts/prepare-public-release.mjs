#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_PACKAGES = [
  {
    dir: "darwin-universal",
    name: "@velr-ai/runtime-darwin-universal",
    description: "Velr native runtime for macOS universal",
    rustDir: "macos-universal",
    file: "libvelrc.dylib",
    os: ["darwin"],
    cpu: ["arm64", "x64"]
  },
  {
    dir: "linux-x64-gnu",
    name: "@velr-ai/runtime-linux-x64-gnu",
    description: "Velr native runtime for Linux x64 GNU",
    rustDir: "linux-x86_64",
    file: "libvelrc.so",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"]
  },
  {
    dir: "linux-arm64-gnu",
    name: "@velr-ai/runtime-linux-arm64-gnu",
    description: "Velr native runtime for Linux arm64 GNU",
    rustDir: "linux-aarch64",
    file: "libvelrc.so",
    os: ["linux"],
    cpu: ["arm64"],
    libc: ["glibc"]
  },
  {
    dir: "win32-x64-msvc",
    name: "@velr-ai/runtime-win32-x64-msvc",
    description: "Velr native runtime for Windows x64 MSVC",
    rustDir: "windows-x86_64",
    file: "velrc.dll",
    os: ["win32"],
    cpu: ["x64"]
  }
];

const DRIVER_PACKAGE_NAME = "@velr-ai/velr";

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    args.set(key, value);
    i += 1;
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`missing required --${key}`);
  return value;
}

function normalizeRepo(repo) {
  return repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function assertFile(path) {
  if (!existsSync(path)) throw new Error(`missing required file: ${path}`);
}

function runtimeLockPackage(runtime, version) {
  const entry = {
    version,
    license: "LicenseRef-Velr-Runtime-Binary-Redistribution-License",
    optional: true,
    os: runtime.os,
    cpu: runtime.cpu,
    engines: {
      node: ">=22"
    }
  };
  if (runtime.libc) entry.libc = runtime.libc;
  return entry;
}

function patchDriverPackage(root, version, publicRepo) {
  const packagePath = join(root, "package.json");
  const pkg = readJson(packagePath);
  pkg.name = DRIVER_PACKAGE_NAME;
  pkg.version = version;
  pkg.license = "MIT";
  pkg.repository = {
    type: "git",
    url: `https://github.com/${publicRepo}.git`
  };
  pkg.bugs = {
    url: `https://github.com/${publicRepo}/issues`
  };
  pkg.optionalDependencies = Object.fromEntries(
    RUNTIME_PACKAGES.map((runtime) => [runtime.name, version])
  );
  writeJson(packagePath, pkg);

  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) return;
  const lock = readJson(lockPath);
  lock.name = DRIVER_PACKAGE_NAME;
  lock.version = version;
  if (lock.packages?.[""]) {
    lock.packages[""].name = DRIVER_PACKAGE_NAME;
    lock.packages[""].version = version;
    lock.packages[""].license = "MIT";
    lock.packages[""].optionalDependencies = pkg.optionalDependencies;
    for (const runtime of RUNTIME_PACKAGES) {
      lock.packages[`node_modules/${runtime.name}`] = runtimeLockPackage(runtime, version);
    }
  }
  writeJson(lockPath, lock);
}

function runtimePackageJson(runtime, version, publicRepo) {
  const pkg = {
    name: runtime.name,
    version,
    description: runtime.description,
    license: "LicenseRef-Velr-Runtime-Binary-Redistribution-License",
    repository: {
      type: "git",
      url: `https://github.com/${publicRepo}.git`,
      directory: `runtime/${runtime.dir}`
    },
    bugs: {
      url: `https://github.com/${publicRepo}/issues`
    },
    os: runtime.os,
    cpu: runtime.cpu,
    engines: {
      node: ">=22"
    },
    files: ["prebuilt", "README.md", "LICENSE.runtime"],
    publishConfig: {
      access: "public"
    }
  };
  if (runtime.libc) pkg.libc = runtime.libc;
  return pkg;
}

function runtimeReadme(runtime) {
  return `# ${runtime.name}

${runtime.description}.

This package contains the Velr native runtime in compiled binary form only. It is installed as an optional dependency of the \`velr\` JavaScript and TypeScript driver.

The JavaScript and TypeScript driver is MIT licensed. The native runtime binary is distributed under \`LICENSE.runtime\`.
`;
}

function prepareRuntimePackages(root, runtimeRoot, version, publicRepo) {
  const runtimeOut = join(root, "runtime");
  rmSync(runtimeOut, { recursive: true, force: true });

  for (const runtime of RUNTIME_PACKAGES) {
    const src = join(runtimeRoot, runtime.rustDir, "prebuilt", runtime.file);
    assertFile(src);

    const dir = join(runtimeOut, runtime.dir);
    const prebuilt = join(dir, "prebuilt");
    mkdirSync(prebuilt, { recursive: true });

    cpSync(src, join(prebuilt, runtime.file));
    cpSync(join(root, "LICENSE.runtime"), join(dir, "LICENSE.runtime"));
    writeFileSync(join(dir, "README.md"), runtimeReadme(runtime));
    writeJson(join(dir, "package.json"), runtimePackageJson(runtime, version, publicRepo));
  }
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.get("root") ?? fileURLToPath(new URL("..", import.meta.url)));
const version = required(args, "version");
const publicRepo = normalizeRepo(required(args, "public-repo"));
const runtimeRoot = resolve(required(args, "runtime-root"));

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`version must be an npm semver without leading v, got: ${version}`);
}

assertFile(join(root, "package.json"));
assertFile(join(root, "LICENSE.runtime"));

patchDriverPackage(root, version, publicRepo);
prepareRuntimePackages(root, runtimeRoot, version, publicRepo);

console.log(
  `Prepared ${basename(root)} ${version} for ${publicRepo} with ${RUNTIME_PACKAGES.length} runtime packages.`
);
