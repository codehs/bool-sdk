import { beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createBoolClient } from "./client";
import { AuthGate, BoolAuthProvider, takeResetTokenFromSearch, useBoolAuth } from "./react";

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

// Regression coverage for the reported bug: a reset link left the
// `bool_reset_token` param in the URL forever (so signing out landed back on
// the "set a new password" screen), and AuthGate never even looked at the
// token when a session already existed (so a fresh reset link silently
// auto-signed the visitor in instead of prompting for a new password). The
// fix hinges on this pure extraction being correct — the DOM-touching glue in
// BoolAuthProvider (read once, replaceState) isn't exercisable without a
// browser, but this pins the string logic it depends on.
describe("takeResetTokenFromSearch", () => {
  test("extracts the token and clears it from an otherwise-empty search", () => {
    expect(takeResetTokenFromSearch("?bool_reset_token=abc123")).toEqual({
      token: "abc123",
      rest: "",
    });
  });

  test("preserves sibling params, order aside", () => {
    const { token, rest } = takeResetTokenFromSearch(
      "?utm_source=email&bool_reset_token=abc123&ref=x",
    );
    expect(token).toBe("abc123");
    expect(new URLSearchParams(rest).get("bool_reset_token")).toBeNull();
    expect(new URLSearchParams(rest).get("utm_source")).toBe("email");
    expect(new URLSearchParams(rest).get("ref")).toBe("x");
  });

  test("no token present — rest is unchanged, token is null", () => {
    expect(takeResetTokenFromSearch("?foo=bar")).toEqual({
      token: null,
      rest: "?foo=bar",
    });
  });

  test("empty search — no token, no rest", () => {
    expect(takeResetTokenFromSearch("")).toEqual({ token: null, rest: "" });
  });
});
