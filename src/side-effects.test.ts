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

// The STRUCTURAL fix, and the reason the field above is now belt-and-braces
// rather than the only thing standing between us and broken published apps.
//
// A React app creates its client with
//   import { createBoolClient } from "bool-sdk/react";
// so loading the module that arms the live hook is a side effect of needing
// something the app already needs. A used binding cannot be tree-shaken by any
// bundler under any configuration — verified by building a real Vite app with
// `"sideEffects": false` (the config that broke 0.3.0) and confirming the
// registration still survives with this import shape.
describe("react entry re-exports createBoolClient (the unshakeable import)", () => {
  test("createBoolClient is importable from the React entry", async () => {
    const react = await import("./react");
    expect(typeof react.createBoolClient).toBe("function");
  });

  test("it is the SAME function as the core export, not a wrapper", async () => {
    // A wrapper would drift; and the default-client registry only works if
    // there is exactly one implementation.
    const [core, react] = await Promise.all([import("./client"), import("./react")]);
    expect(react.createBoolClient).toBe(core.createBoolClient);
  });
});
