---
name: tmt-dev
description: Implement, review, or maintain tmux-team repository changes with the project's issue, architecture, verification, and review gates.
---

# tmux-team development

Use this skill for repository implementation and review work. It is a development
workflow, not end-user documentation for the `tmt` CLI.

Read the repository guidance before planning work:

- [`AGENTS.md`](../../../AGENTS.md) — pattern inspection, discretionary delegation, ownership, and lifecycle policy.
- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) — current and target boundaries, legacy debt, and architecture change triggers.
- [`CONVENTIONS.md`](../../../CONVENTIONS.md) — code and test style.
- [`DEVELOPMENT.md`](../../../DEVELOPMENT.md) — commands and the focused verification matrix.
- [`tmt-e2e`](../tmt-e2e/SKILL.md) for Docker/tmux integration work.
- [`tmt-release`](../tmt-release/SKILL.md) for release-line or packaged-install work.

## Required workflow

1. Start from a tracked issue whose outcome, scope, acceptance criteria,
   dependencies, and project relationship are clear. Create its dedicated branch
   and worktree before implementation; follow AGENTS for state and commit attribution.
2. Before editing, inspect relevant existing patterns locally or delegate a
   read-only audit when it is worth the coordination and review effort. Keep
   inspection proportional to the change; record material findings and their
   disposition. Delegation is not mandatory. Prefer Luna for simple, bounded
   tasks and large-scale detection or scanning.
3. The primary reviewer owns the architecture design: define the affected
   boundary, inputs and outputs, risks, and reuse of existing ports/helpers
   before implementation.
4. Implement directly or delegate according to total effort and coupling, not
   a requirement to assign work. When delegating, set explicit file ownership,
   constraints, and verification requirements. Do not let concurrent agents
   edit overlapping files. Keep architectural and integration decisions with
   the primary agent.
5. The primary reviewer reviews every changed file and the relevant callers,
   fixtures, and tests. Passing reports or green CI are evidence, not a
   substitute for that review. Record findings, dispositions, and the reviewed
   commit in the PR and GitHub issue.
6. Run the exact checks required by the changed layer and report their commands
   and results. Add behavioral tests for changed contracts, including relevant
   failure, cleanup, or lifecycle cases.
   During runtime retirement, map assertions rather than file names or counts:
   returned-error rollback is not crash recovery, and policy tests are not
   terminal-output tests. Preserve a positive control when a fixture could pass
   without executing its intended mutation. Review resource destruction order
   when consolidating cleanup helpers; reuse the existing test-only child owner
   and stop/reap children before their files are removed.
7. Before an authorized merge, verify all required CI passed on the current
   reviewed commit. Review later edits and rerun affected checks. Keep
   GitHub issue status, branch/PR links, verification evidence, and deferred work
   current; clean up the worktree only after its state is safely handed off.

## Architecture maintenance

For installed-agent guidance changes, follow DEVELOPMENT's installed guidance
source ownership: edit the single canonical skill, verify native provider links
and local drift detection, and review semantic changes and provider invocation
behavior. Matching installed bytes alone does not prove that instructions are
correct. Do not reintroduce command wrappers or provider-specific copies.

For every change, record a substantive architecture-impact assessment. If the
change modifies a module boundary, dependency direction, public contract,
legacy compatibility path, persistence model, or test/fixture ownership, update
`ARCHITECTURE.md` in the same PR and explain the change. If none of those
triggers apply, record why in the PR/GitHub issue; a checkbox alone is not
evidence. Keep architecture rules in `ARCHITECTURE.md`, style rules in
`CONVENTIONS.md`, and command guidance in `DEVELOPMENT.md` rather than copying
them into this skill.
