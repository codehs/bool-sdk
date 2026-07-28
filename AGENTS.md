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

## Realtime (`src/realtime.ts`, `src/live.ts`)

Read the platform repo's `docs/2026-07-realtime.md` before changing either.
It records three generations of this design, why the first two were abandoned,
and the traps that are easy to walk back into. The short version:

- Change payloads arrive on **private** channels joined with a short-TTL token
  the gateway mints; there is **no public channel** to fall back to. Don't add
  one "just in case" — the previous one cost double writes forever and leaked
  row ids to anyone holding the (public) anon key.
- A payload's `id` is only trustworthy on channels whose payload shape we
  control: the transport injects its own message uuid when a payload lacks one,
  and it looks exactly like a row id.
- `LiveEntityStore` merges changes by id and never replaces the list from a
  server snapshot. Replacing is what made rows pop in and out; two earlier
  releases tried to shrink that race window before we removed it instead.
- On failure, retry and report (`connecting | live | unauthorized | unavailable`)
  rather than degrading quietly. Distinguish "refused" from "unreachable": a
  public app admits every visitor, so a dropped request must never surface as
  *unauthorized*.
