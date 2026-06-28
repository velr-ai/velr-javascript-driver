#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function linuxLibcSuffix() {
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
}

function rollupNativePackageName() {
  switch (process.platform) {
    case "darwin":
      return `@rollup/rollup-darwin-${process.arch}`;
    case "freebsd":
      return `@rollup/rollup-freebsd-${process.arch}`;
    case "linux":
      if (process.arch === "arm") {
        return `@rollup/rollup-linux-arm-${linuxLibcSuffix() === "gnu" ? "gnueabihf" : "musleabihf"}`;
      }
      return `@rollup/rollup-linux-${process.arch}-${linuxLibcSuffix()}`;
    case "win32":
      return `@rollup/rollup-win32-${process.arch}-msvc`;
    default:
      return null;
  }
}

const root = process.cwd();
const lock = readJson(join(root, "package-lock.json"));
const rollup = lock.packages?.["node_modules/rollup"];
const nativeName = rollupNativePackageName();

if (!nativeName) {
  console.log(`No Rollup native optional package is needed for ${process.platform}/${process.arch}.`);
  process.exit(0);
}

const version = rollup?.optionalDependencies?.[nativeName];
if (!version) {
  throw new Error(`package-lock.json does not contain Rollup optional dependency ${nativeName}`);
}

const packageJsonPath = join(root, "node_modules", ...nativeName.split("/"), "package.json");
if (existsSync(packageJsonPath)) {
  console.log(`${nativeName} is already installed.`);
  process.exit(0);
}

const spec = `${nativeName}@${version}`;
console.log(`Installing ${spec} omitted by npm ci --omit=optional...`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npm,
  ["install", "--no-save", "--package-lock=false", "--ignore-scripts", spec],
  { stdio: "inherit" }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
