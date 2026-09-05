---
name: tmt-dev
description: Implement, review, or maintain tmux-team repository changes with the project's issue, architecture, verification, and review gates.
---

# tmux-team development

Use this skill for repository implementation and review work. It is a development
workflow, not end-user documentation for the `tmt` CLI.

Read the repository guidance before planning work:

- [`AGENTS.md`](../../../AGENTS.md) — mandatory audit, ownership, and lifecycle policy.
- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) — current and target boundaries, legacy debt, and architecture change triggers.
- [`CONVENTIONS.md`](../../../CONVENTIONS.md) — code and test style.
- [`DEVELOPMENT.md`](../../../DEVELOPMENT.md) — commands and the focused verification matrix.
- [`tmt-e2e`](../tmt-e2e/SKILL.md) for Docker/tmux integration work.
- [`tmt-release`](../tmt-release/SKILL.md) for release-line or packaged-install work.

## Required workflow

1. Start from a tracked issue whose outcome, scope, acceptance criteria,
   dependencies, and project relationship are clear. Create its dedicated branch
   and worktree before implementation; follow AGENTS for state and commit attribution.
2. Before editing, perform the required read-only repository pattern audit with
   the delegated Luna reviewer at high reasoning effort. The primary reviewer
   must accept or reject its findings before implementation starts and record
   the disposition.
3. The primary reviewer owns the architecture design: define the affected
   boundary, inputs and outputs, risks, and reuse of existing ports/helpers
   before assigning implementation.
4. Assign bounded implementation work with explicit file ownership. Do not let
   concurrent agents edit overlapping files.
5. The primary reviewer reviews every changed file and the relevant callers,
   fixtures, and tests. Passing reports or green CI are evidence, not a
   substitute for that review. Record findings, dispositions, and the reviewed
   commit in the PR and Linear issue.
6. Run the exact checks required by the changed layer and report their commands
   and results. Add behavioral tests for changed contracts, including relevant
   failure, cleanup, or lifecycle cases.
7. Before an authorized merge, verify all required CI passed on the current
   reviewed commit. Review later edits and rerun affected checks. Keep
   Linear status, branch/PR links, verification evidence, and deferred work
   current; clean up the worktree only after its state is safely handed off.

## Architecture maintenance

For every change, record a substantive architecture-impact assessment. If the
change modifies a module boundary, dependency direction, public contract,
legacy compatibility path, persistence model, or test/fixture ownership, update
`ARCHITECTURE.md` in the same PR and explain the change. If none of those
triggers apply, record why in the PR/Linear issue; a checkbox alone is not
evidence. Keep architecture rules in `ARCHITECTURE.md`, style rules in
`CONVENTIONS.md`, and command guidance in `DEVELOPMENT.md` rather than copying
them into this skill.
