---
name: tmt-e2e
description: Add, change, diagnose, or run this repository's Docker-isolated end-to-end tests for tmt and tmux.
---

# TMT end-to-end testing

Use this skill for the repository's Docker E2E test foundation. Keep E2E tests separate from unit tests and unit-test coverage: Docker provides isolation, while Vitest is the scenario runner and assertion layer.

## Required test boundary

- Exercise the real `tmt`/`tmux-team` CLI and a real tmux server.
- Run deterministic mock agents inside tmux panes; never invoke a real AI agent, model, credential, or network service.
- Never touch the host user's tmux server, host credentials, or unrelated processes. The container must be network-isolated.
- Reuse the existing E2E harness and its cleanup hooks. Every scenario must leave its temporary tmux server, socket, panes, and files cleaned up, including on assertion failure.
- For lifecycle or cleanup changes, run the Docker suite twice to catch leaked state and non-idempotent teardown.

## Test quality gate

Do not optimize for a passing suite or a larger test count. Every scenario must name the concrete regression risk or invariant it covers, and a reviewer should be able to explain what realistic defect would make it fail.

- Cover distinct boundaries and failure modes instead of repeating equivalent happy paths.
- Exercise the subject under test rather than recreating its logic in the harness. Mock agents are allowed because they are deterministic peers; `tmt` and tmux themselves stay real.
- Assert causal output and durable state. Terminal-echoed input is not proof that a mock agent processed a request; wait for agent-produced output and corroborate it with the structured event log or metadata.
- Include negative paths for exit-code propagation, invalid operations, timeouts, partial startup, and thrown scenario errors when those risks are relevant.
- Use bounded polling for observable state changes. Do not use fixed sleeps to hide races or make a flaky scenario appear stable.
- Verify state preservation after failed operations and verify cleanup with observable absence, not only by calling a cleanup function.
- Prefer stable JSON fields, exit codes, pane IDs, metadata, and essential output over incidental formatting.
- Keep foundation tests focused on infrastructure invariants. Add feature semantics only through the issue that defines that feature's state matrix.
- Treat a test that can pass without the intended action occurring as a test bug. Fix false positives before expanding coverage.

## Maintained implementation

Read the relevant files before changing behavior:

- [`test/e2e/`](../../../test/e2e/): Vitest configuration, scenarios, harness, and mock-agent behavior.
- [`scripts/run-e2e.mjs`](../../../scripts/run-e2e.mjs): Docker build/run wrapper and exit-code handling.

Keep orchestration in the wrapper and scenario assertions in Vitest. Do not duplicate harness or mock-agent implementation in this skill.

## Scope guard

This foundation covers CLI/tmux integration scenarios only. Do not expand it into daemon behavior, persistence, team workflows, aliases, or memory unless a separate, explicit requirement adds those areas.

## Verification

Prefer the repository's documented E2E command through [`scripts/run-e2e.mjs`](../../../scripts/run-e2e.mjs). Confirm failures propagate as non-zero exit codes, and inspect cleanup behavior when tests fail—not only when they pass.
