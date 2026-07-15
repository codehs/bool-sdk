# Changelog

## 0.1.0

Initial release. Lifts the previously-vendored Bool v2 ("gateway") app client
out of per-app scaffold files into a published package:

- `createBoolClient(config)` — supabase-js client routed through the Bool
  gateway data plane (REST + Storage), realtime doorbell helper
  (`subscribeToChanges`), and the end-user auth surface (`client.auth`)
  against the gateway users plane.
- `@bool/sdk/react` — `BoolAuthProvider`, `useBoolAuth`, `AuthGate`,
  `useSignInForm`.
