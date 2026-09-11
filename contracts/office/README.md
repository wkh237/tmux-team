# Office contract boundary

Private-world and home-block document contracts are implemented in the browser
and Rules. The remote work-handoff protocol remains a proposal, not a deployed API.

The [agent resource grant v1](agent-grant-v1.md) adds server-enforced access to
assigned UUID blocks. [Pairing approval and claim v1](pairing-v1.md) defines the
locally tested trusted issuer. Native pairing and the agent-block UI remain
separate work; the browser currently edits only the owner's home block.
The [native pairing contract](native-pairing.md) defines deployment discovery and
the in-progress command/credential boundary, not shipped command guidance.

The separately versioned [private world document v1](private-world.md) is the
direct-Firestore contract. It uses native Firestore timestamps and Rules,
not the work-handoff HTTP/JSON envelopes below. Its actual client adapter and
Rules are exercised together in `apps/office/e2e/world-rules.spec.ts`.

The [home block document v1](block-v1.md) extends that owner-only world with
bounded, revision-checked decoration. Its vectors are shared by client and
real Rules tests, not derived from implementation output.

## Single source of truth

The [native companion handshake](native-companion.md) is an implemented internal
local boundary, independently versioned from the remote work-handoff proposal.

- `v1.schema.json` is JSON Schema 2020-12 for the initial work handoff ingress:
  negotiation offer, human work submission, connector evidence and final export.
- `examples.json` contains valid wire examples. Authentication is supplied by
  the transport, never by an `actorUid`, display name or local receipt field.
- `scenarios.json` assigns behavioral acceptance vectors to implementation
  issues. Its assertions are requirements, **not passing policy tests**.
- [Design](../../docs/office/design.md) owns semantics and trust boundaries;
  [commands](../../docs/office/commands.md) owns planned CLI UX.

Browser, service and Rust connector representations must derive from this schema
or run these fixtures and boundary mutations through their actual serializer and
validator. Do not maintain parallel hand-written contracts without conformance.
No shared runtime package, Firebase dependency or Rust crate is invented merely
to host this file. Pairing endpoints, read projections, signed/scoped permit
transport and board payloads must extend this owner in their implementing issue
before their first consumer ships. They are not implicitly defined by Firebase
collection shapes or by these four ingress message types.

## Compatibility and interpretation

The stable negotiation offer carries supported exact `major.minor` versions and
required capabilities. A service chooses the highest mutually supported exact
version only if it supports every required capability. Currently the design has
only `1.0` and capability `work-handoff` (review requests). An incompatible offer
is structurally valid but gets `409` and no session/work execution. Capability
negotiation never grants the caller permission to perform that operation.

Unknown message kinds, versions and fields reject; they are not silently ignored.
Future additive fields require a new minor schema and explicit negotiation;
semantic breaking changes require a new major. Keep older released schemas
immutable once consumers ship. Do not infer compatibility from semver package
versions or fall back to a local CLI protocol. Review metadata binds the exact
revision, not repository access or permission to publish feedback.

Strict JSON cannot contain duplicate object keys, non-finite numbers or invalid
Unicode scalar sequences. Reject duplicate keys during decoding before a normal
object parser discards them; JSON Schema alone cannot detect that condition.
Timestamps are safe-integer UTC milliseconds. Service time validates freshness,
deadline range and leases; a valid timestamp type is not evidence of freshness.
Empty and whitespace-only text remain valid exact text, not silently trimmed
content or a synthetic withheld result. This preserves native text semantics.

Human work submissions return `201` with the accepted exchange ID and `queued`
routing state; an exact authorized retry returns `200` with the original ID and
current projection. Reports/final retries also return the original projection;
they cannot replace stored content or advance unauthorized state. The service
derives the actor/device from authentication and resolves current grants and
assignment before these operations. Errors follow the design's HTTP classes;
do not forward native CLI error details to remote clients.

## Local conformance

```sh
pnpm exec vitest run test/tooling/office-contracts.test.ts
pnpm check:tooling
```

The root tooling suite uses [Ajv JSON Schema validation](https://ajv.js.org/json-schema.html) in strict mode rather than a
home-grown schema validator. It checks actual examples, required/unknown fields,
versions, local-metadata injection and Unicode size boundaries, plus scenario
reference integrity. It cannot prove server authorization, stale-token rejection,
tmux delivery or crash recovery. Each downstream issue must implement the owned
behavioral cases using its real rules/service/connector and causal observations.
