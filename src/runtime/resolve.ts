import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { VelrError } from "../errors.js";

const require = createRequire(import.meta.url);

export interface RuntimeResolution {
  readonly libraryPath: string;
  readonly source: "env" | "package" | "vendor" | "monorepo";
}

function platformLibraryNames(): readonly string[] {
  if (process.platform === "darwin") return ["libvelrc.dylib", "velrc.dylib"];
  if (process.platform === "win32") return ["velrc.dll"];
  return ["libvelrc.so", "velrc.so"];
}

function runtimePackageNames(): readonly string[] {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return ["@velr-ai/runtime-darwin-universal"];
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return ["@velr-ai/runtime-darwin-universal"];
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return ["@velr-ai/runtime-win32-x64-msvc"];
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return ["@velr-ai/runtime-linux-x64-gnu"];
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return ["@velr-ai/runtime-linux-arm64-gnu"];
  }
  return [];
}

function candidateLibraryPaths(root: string): string[] {
  const names = platformLibraryNames();
  return [
    ...names.map((name) => join(root, "vendor", name)),
    ...names.map((name) => join(root, "_vendor", name)),
    ...names.map((name) => join(root, "prebuilt", name)),
    ...names.map((name) => join(root, name))
  ];
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

function resolvePackageRuntime(): RuntimeResolution | null {
  for (const packageName of runtimePackageNames()) {
    try {
      const packageJson = require.resolve(`${packageName}/package.json`);
      const root = dirname(packageJson);
      const libraryPath = firstExisting(candidateLibraryPaths(root));
      if (libraryPath) return { libraryPath, source: "package" };
    } catch {
      // Optional runtime packages are intentionally absent on other platforms.
    }
  }
  return null;
}

function resolveLocalVendorRuntime(): RuntimeResolution | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, "..", "..", "vendor"),
    resolve(here, "..", "..", "_vendor"),
    resolve(here, "..", "..", "..", "vendor"),
    resolve(here, "..", "..", "..", "_vendor")
  ];

  for (const root of roots) {
    const libraryPath = firstExisting(platformLibraryNames().map((name) => join(root, name)));
    if (libraryPath) return { libraryPath, source: "vendor" };
  }

  return null;
}

function resolveMonorepoRuntime(): RuntimeResolution | null {
  const root = findRepoRoot(process.cwd());
  if (!root) return null;

  const platformRoot =
    process.platform === "darwin"
      ? "macos-universal"
      : process.platform === "win32"
        ? "windows-x86_64"
        : process.arch === "arm64"
          ? "linux-aarch64"
          : "linux-x86_64";

  const runtimeRoots = [
    join(root, "rust", "velr-rust-driver", "runtime", platformRoot, "prebuilt"),
    join(root, "rust", "target", "release"),
    join(root, "rust", "target", "debug"),
    join(root, "target", "release"),
    join(root, "target", "debug")
  ];
  const libraryPath = firstExisting(
    runtimeRoots.flatMap((runtimeRoot) =>
      platformLibraryNames().map((name) => join(runtimeRoot, name))
    )
  );
  return libraryPath ? { libraryPath, source: "monorepo" } : null;
}

function findRepoRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(join(current, "Cargo.toml")) &&
      existsSync(join(current, "rust", "velr-ffi", "Cargo.toml"))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveRuntime(): RuntimeResolution {
  const envPath = process.env.VELR_NATIVE_LIBRARY ?? process.env.VELR_LIB;
  if (envPath) {
    const libraryPath = resolve(envPath);
    if (!existsSync(libraryPath)) {
      throw new VelrError(
        `Velr native library from VELR_NATIVE_LIBRARY/VELR_LIB does not exist: ${libraryPath}`
      );
    }
    return { libraryPath, source: "env" };
  }

  const resolution =
    resolvePackageRuntime() ?? resolveLocalVendorRuntime() ?? resolveMonorepoRuntime();
  if (resolution) return resolution;

  const packageHint = runtimePackageNames().join(", ") || "<no package for this platform>";
  throw new VelrError(
    [
      "Unable to locate the Velr native runtime.",
      `Platform: ${process.platform}/${process.arch}`,
      `Expected optional runtime package: ${packageHint}`,
      "You can also set VELR_NATIVE_LIBRARY to an explicit libvelrc/velrc path."
    ].join("\n")
  );
}
