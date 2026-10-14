import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("eslint-config-next"));
const nextPluginRequire = createRequire(
  eslintRequire.resolve("@next/eslint-plugin-next"),
);
const shadcnRequire = createRequire(require.resolve("shadcn"));

type Braces = {
  (input: string): string[];
  compile(input: string): string;
  expand(input: string): string[];
  stringify(input: string): string;
  parse(input: string): unknown;
};

for (const [consumer, consumerRequire] of [
  ["ESLint", nextPluginRequire],
  ["shadcn", shadcnRequire],
] as const) {
  const globRequire = createRequire(consumerRequire.resolve("fast-glob"));
  const micromatchRequire = createRequire(globRequire.resolve("micromatch"));
  const braces = micromatchRequire("braces") as Braces;

  describe(`${consumer} brace-pattern depth guard`, () => {
    it("preserves normal patterns, ranges, and literal braces", () => {
      expect(braces.expand("src/{app,lib}/file{1..2}.ts")).toEqual([
        "src/app/file1.ts",
        "src/app/file2.ts",
        "src/lib/file1.ts",
        "src/lib/file2.ts",
      ]);
      expect(braces.compile("{a,{b,c}}")).toBe("(a|(b|c))");
      expect(braces.expand('"' + "{".repeat(500) + '"')).toEqual([
        "{".repeat(500),
      ]);
      expect(braces.expand("\\{".repeat(500))).toEqual(["{".repeat(500)]);
      expect(braces.expand("[" + "{".repeat(500) + "]")).toEqual([
        "[" + "{".repeat(500) + "]",
      ]);
    });

    it.each([
      braces,
      braces.compile,
      braces.expand,
      braces.stringify,
      braces.parse,
    ])("rejects adversarial nesting before recursive walkers run", (run) => {
      for (const pattern of [
        "{".repeat(4000) + "a,b" + "}".repeat(4000),
        "(".repeat(4000) + "a" + ")".repeat(4000),
        "{(".repeat(2000) + "a,b" + ")}".repeat(2000),
      ]) {
        expect(() => run(pattern)).toThrow(
          new SyntaxError("Input nesting exceeds maximum depth (100)"),
        );
      }
    });

    it("accepts the boundary and rejects the next nested group", () => {
      expect(() =>
        braces.compile("{".repeat(100) + "a,b" + "}".repeat(100)),
      ).not.toThrow();
      expect(() =>
        braces.compile("{".repeat(101) + "a,b" + "}".repeat(101)),
      ).toThrow(SyntaxError);
    });
  });
}
