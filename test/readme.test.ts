import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Velr } from "../src/index.js";

describe("README quick start", () => {
  it.skipIf(process.env.VELR_JS_NATIVE_TESTS !== "1").each([["LF", "\n"], ["CRLF", "\r\n"]])("runs the published JavaScript example (%s)", (_name, newline) => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
      .replace(/\r\n?/g, "\n").replace(/\n/g, newline);
    const code = readme.match(/```js\r?\n([\s\S]*?)\r?\n```/)?.[1];
    if (!code) throw new Error("README quick start is missing");
    const output: unknown[][] = [];
    // Supply the source driver so this documentation check also works before a build.
    const body = code.replace('import { Velr } from "@velr-ai/velr";', "");
    new Function("Velr", "console", body)(Velr, { log: (...values: unknown[]) => output.push(values) });
    expect(output).toEqual([["Keanu Reeves", 1964]]);
  });
});
