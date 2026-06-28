import { defineConfig, type Options } from "tsup";

const entry: NonNullable<Options["entry"]> = {
  index: "src/index.ts",
  "worker/index": "src/worker/index.ts",
  "worker/runtime-worker": "src/worker/runtime-worker.ts"
};

const common: Options = {
  entry,
  target: "node22",
  platform: "node",
  splitting: false,
  external: ["koffi", "apache-arrow"]
};

export default defineConfig([
  {
    ...common,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: false
  },
  {
    ...common,
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    clean: false,
    esbuildOptions(options) {
      options.define = {
        ...options.define,
        "import.meta.url": "__velrImportMetaUrl"
      };
      options.banner = {
        ...options.banner,
        js: [
          "const __velrUrl = require(\"node:url\");",
          "const __velrImportMetaUrl = __velrUrl.pathToFileURL(__filename).href;"
        ].join("\n")
      };
    }
  }
]);
