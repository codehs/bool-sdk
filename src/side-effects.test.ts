import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

// 0.3.0 shipped `"sideEffects": false` and broke EVERY published app that used a
// live view. `react.js` registers the live-query implementation into the
// React-free core at module scope, and apps load it as a bare
// `import "bool-sdk/react"` with no bindings used — so a blanket `false` tells
// bundlers the module is inert and they delete the import outright. Vite dev
// doesn't tree-shake, so it only surfaced after publishing.
//
// Confirmed by building a real Vite app against both configurations and calling
// useQuery in the bundled output:
//   sideEffects: false               → throws "needs the React entry loaded"
//   sideEffects: ["./dist/react.js"] → registration survives
describe("package.json sideEffects (published-bundle contract)", () => {
  test("is a list, never a blanket false", () => {
    expect(pkg.sideEffects).not.toBe(false);
    expect(Array.isArray(pkg.sideEffects)).toBe(true);
  });

  test("declares every entry point that registers something at module scope", () => {
    // Keep this list in sync with any new side-effecting entry. The rule: if a
    // module's job is to run rather than to export, it belongs here.
    for (const entry of ["./dist/react.js"]) {
      expect(pkg.sideEffects).toContain(entry);
    }
  });

  test("each listed path is a real published entry point", () => {
    // A typo'd path silently reverts to "no side effects" for that file, which
    // is the original bug wearing a different hat.
    const exported = new Set(
      Object.values(pkg.exports as Record<string, { default: string }>).map((e) => e.default),
    );
    for (const p of pkg.sideEffects as string[]) {
      expect(exported).toContain(p);
    }
  });
});
