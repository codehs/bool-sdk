import { beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createBoolClient } from "./client";
import { AuthGate, BoolAuthProvider, useBoolAuth } from "./react";

// SSR smoke tests: effects don't run in renderToString, so the provider is in
// its initial loading state — enough to pin the gate/hook contract without a
// browser. The full auth flow is covered in client.test.ts.

const CONFIG = {
  supabaseUrl: "https://upstream.supabase.test",
  supabaseAnonKey: "anon-key",
  schema: "bool_abc",
  appOrigin: "https://bool.test",
  slug: "my-app",
};

beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ user: null })) as unknown as typeof fetch;
  (globalThis as any).sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

describe("BoolAuthProvider + AuthGate", () => {
  test("renders nothing while the initial session check is in flight", () => {
    createBoolClient(CONFIG);
    const html = renderToString(
      <BoolAuthProvider>
        <AuthGate fallback={<div>login</div>}>
          <div>app</div>
        </AuthGate>
      </BoolAuthProvider>,
    );
    expect(html).toBe("");
  });

  test("provider accepts an explicit client", () => {
    const client = createBoolClient(CONFIG);
    const html = renderToString(
      <BoolAuthProvider client={client}>
        <span>hi</span>
      </BoolAuthProvider>,
    );
    expect(html).toContain("hi");
  });
});

describe("useBoolAuth", () => {
  test("throws outside <BoolAuthProvider>", () => {
    function Naked() {
      useBoolAuth();
      return null;
    }
    expect(() => renderToString(<Naked />)).toThrow(
      "useBoolAuth must be used inside <BoolAuthProvider>",
    );
  });
});
