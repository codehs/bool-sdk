# Changelog

## 0.2.0-next.5

Fix: `onAuthStateChange` (and thus `<AuthGate>`) no longer hangs forever when
the initial `/users/me` session check rejects (cross-origin/network failure —
e.g. the sandbox-preview context used for project-card screenshots). A rejected
check now fires `SIGNED_OUT` instead of leaving `loading` stuck, so the app
renders its sign-in screen rather than a blank page. Adds a regression test.

## 0.1.1

Publishing now goes through npm OIDC trusted publishing (no long-lived token).
No functional or API changes.

## 0.1.0

Initial release. Lifts the previously-vendored Bool v2 ("gateway") app client
out of per-app scaffold files into a published package:

- `createBoolClient(config)` — supabase-js client routed through the Bool
  gateway data plane (REST + Storage), realtime doorbell helper
  (`subscribeToChanges`), and the end-user auth surface (`client.auth`)
  against the gateway users plane.
- `bool-sdk/react` — `BoolAuthProvider`, `useBoolAuth`, `AuthGate`,
  `useSignInForm`.
