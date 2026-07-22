# bool-sdk — agent notes

## This repo is PUBLIC (and published to npm)

Everything here ships to the world: source, comments, README, CHANGELOG,
commit messages, PR titles/bodies. Write accordingly.

## Voice

Describe the SDK on its own terms — what an API does and why it's shaped that
way. Keep comments, docs, the README, the CHANGELOG, commit messages, and PRs
self-contained: no references to other products or frameworks as the
explanation for a design (a reader shouldn't need outside context to
understand ours).

## Working here

- `bun install`, `bun test` (hermetic — fetch/fs stubbed or temp dirs),
  `bun run typecheck`, `bun run build` (emits `dist/`, ESM + `.d.ts`).
- Add tests in the same change as the code.
- The gateway wire paths (`/_bool/v1/*`) are append-only; keep this SDK in
  sync with the gateway routes in the Bool platform repo (`lib/gateway/`).
- Semver discipline is load-bearing: generated apps install from a caret
  range on every sandbox boot, so a breaking change requires a major bump.
