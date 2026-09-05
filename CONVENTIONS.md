# Coding conventions

These are rules for new and touched code, not a claim that all legacy code
already follows them. [ARCHITECTURE.md](ARCHITECTURE.md) owns module boundaries
and known exceptions; [AGENTS.md](AGENTS.md) owns review and maintenance policy.
Use the [development skill](.agents/skills/tmt-dev/SKILL.md) to apply them.

## Style and readability

- Write repository content in English. Let the repository Prettier configuration
  and [tsconfig.json](tsconfig.json) define formatting and strict TypeScript
  settings; run checks rather than restyling unrelated files.
- Use kebab-case files, `cmd`-prefixed handlers, colocated `<module>.test.ts`
  unit tests and `.e2e.test.ts` integration scenarios.
- Use ESM with explicit `.js` extensions for local TypeScript modules and
  `import type` for type-only dependencies. Prefer `node:` for new built-in
  imports without opportunistic whole-repo rewrites.
- Prefer small function-based modules and typed inputs/results. Use discriminated
  unions for alternative states, explicit return contracts on exported APIs,
  and `unknown` plus validation at untrusted boundaries instead of `any`
  or assertions that hide missing evidence.
- Name units and ownership (`timeoutMs`, `identityId`, `socketPath`).
  Extract helpers around shared behavior, not incidental line sequences.
  Do not add wrappers, speculative frameworks or generic utilities without a
  concrete consumer and demonstrated benefit.
- Explain invariants and non-obvious decisions in comments; avoid narrating each
  statement or requiring decorative banners. Favor early validation and cohesive
  control flow over nested special cases.

## Commands, effects and contracts

- Commands are effectful adapters, not pure domain functions. Use injected
  `Context` services, `ctx.ui` and `ctx.exit(ExitCodes.*)` for new handlers.
  Pure domain code must not depend on Context, console, filesystem or process exit.
  Existing direct-output/legacy paths are debt, not examples to copy.
- Extend the typed parser and dispatcher together. Do not slice argv again in a
  handler, guess an omitted identity, or add a parallel name/pane resolver.
- Specify and test JSON shape, stdout/stderr, exit codes, human output, defaults
  and units for changed commands. Prefer one structured result/error in JSON mode
  without progress text mixed into it. Uniformity is a target with known gaps;
  preserve public behavior unless the issue explicitly changes it.
- Use [src/exits.ts](src/exits.ts) and parser definitions as authoritative
  code/grammar registries. Do not copy stale numeric tables or claim unsupported
  duration suffixes. Convert CLI time values and internal milliseconds explicitly.
- Resolve paths through the existing config boundary; use `ctx.paths` in
  handlers. Do not invent another global directory or reconstruct XDG rules.
- Keep expected domain errors distinguishable from unexpected failures. Preserve
  causes for diagnosis. Catch only to translate, recover, clean up or implement
  documented best-effort effects; never silently discard a failed mutation.
- Bound external process/file work and clean up resources on every exit path.
  Direct file writes are not atomic or concurrency-safe. Follow the state owner's
  transaction/recovery contract, not an "atomic-like" write.
- Message framing and adaptation belong to shared delivery implementation.
  Current waits use `RESPONSE-END-<nonce>`; do not invent a second marker.
  The `!` policy protects coding-agent shell/bash mode, not TTY cosmetics.
  Consult the delivery gap in ARCHITECTURE before changing payload/fallback behavior.

## Dependencies and refactoring

Before adding a dependency or abstraction, inspect existing helpers and compare
the concrete benefit, compatibility/native-install impact, maintenance, license,
security and operational cost. Record the decision in the issue. A built-in is
not automatically preferable; a dependency is not a substitute for design.

Refactor within the issue when it makes implementation coherent and testable.
Keep behavioral changes explicit. Do not mix unrelated renames, formatting or
migrations into a correctness fix; split larger prerequisites into linked issues.

## Tests and review

Follow [DEVELOPMENT.md](DEVELOPMENT.md) and the
[E2E skill](.agents/skills/tmt-e2e/SKILL.md) for commands and test boundaries.
Name the invariant or realistic defect each test detects. Use real temporary
storage for repository behavior and injected ports for focused service tests;
mocking a storage operation is not proof of persistence or atomicity.

Use deterministic barriers for races, bounded polling for readiness, and
observable failure/cleanup postconditions. Verify causal agent output rather
than terminal echo. Cover compatibility, negative paths and partial failure,
not only the new happy path. Demonstrate regression tests fail against the
original defect when practical; explain when that evidence cannot be obtained.

Primary review examines test setup and assertions as code. Do not weaken an
assertion, bypass a gate or count more tests as proof of correctness. Use fixture
types compatible with the pinned runtime; an example from a newer framework
version is not automatically a project convention.
