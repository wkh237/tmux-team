# Repository Working Agreement

## Required development context

Before planning or changing this repository, read this file, the
[development skill](.agents/skills/tmt-dev/SKILL.md),
[architecture](ARCHITECTURE.md), [coding conventions](CONVENTIONS.md), and
[development/verification guide](DEVELOPMENT.md). Inspect the relevant source
and issue as well. Use the linked E2E or release skill when applicable. If a
required reference is missing or contradicts the code, report and resolve that
discrepancy within scope before relying on it; do not invent a convention.

## Architecture ownership and primary review

The primary agent owns the architectural model, design tradeoffs, decomposition,
integration, and final review. Delegation transfers implementation work, not
accountability. Before accepting delegated work, the primary must personally
read every changed file's diff and surrounding implementation, relevant callers,
contracts, and tests. Assess dependency direction, module responsibility, reuse,
compatibility, state/failure behavior, readability, and test validity—not only
whether the ticket or CI is green. Apply the same gate to primary-authored work;
an independent reviewer is supplementary, not a replacement.

Record the reviewed commit, affected boundaries, findings and their disposition,
and verification evidence in the PR and GitHub issue. If there are no findings,
state what was inspected rather than merely saying "LGTM". Review later changes
and rerun affected checks before accepting a newer head.

For every PR, follow the [architecture maintenance contract](ARCHITECTURE.md#maintenance-contract):
update affected architecture and developer guidance in the same PR, or explain
why the change does not affect them. The implementer proposes documentation
updates; the primary reviewer verifies them against code before merge. A linked
follow-up is not permission to ship inaccurate descriptions of current behavior.

## Pattern audit before changes

Before editing code, tests, documentation, configuration, or repository skills, inspect the relevant existing patterns. The primary agent decides whether to inspect locally or delegate, based on the total implementation, coordination, and review effort. Delegation is optional, not a prerequisite for making changes.

Keep the inspection proportional to the change. Inspect relevant architecture, helpers, fixtures, scripts, naming conventions, tests, documentation, and skills to identify reusable patterns, duplicated behavior, and conflicts. Prefer `gpt-5.6-luna` for simple, bounded tasks and large-scale detection or scanning. A delegated read-only audit must not edit files, mutate external systems, or broaden the requested scope.

The primary agent reviews findings before editing, records material findings and their disposition, and reuses or extends established abstractions where practical. Correct unnecessary duplication or inconsistent implementation within scope before continuing.

Do not split tightly coupled architecture or integration work merely to use another agent. Direct implementation requires no delegation exception. Delegation never expands the user's authorization.

## Repository content language

All repository content must be written in English, including code, tests,
comments, documentation, configuration, workflows, repository skills, commit
messages, and pull request metadata. Non-language symbols and technically
required fixture data are allowed when necessary; explain any such exception
in English.

## Delivery lifecycle

- GitHub Issues is the active tracker for TMT. Historical Linear links are
  references, not a second workflow or a requirement to duplicate tickets.
- For development beyond incidental edits, use one tracked GitHub issue, one
  dedicated branch/worktree, and one reviewable PR. Confirm outcome, scope,
  acceptance criteria, dependencies and project relationship before editing;
  mark the issue started when implementation begins. Split oversized work first.
- Delegate only when it reduces total effort or provides useful independent coverage.
  Prefer `gpt-5.6-luna` for simple, bounded work and large-scale detection or scanning.
  When delegating, give explicit file ownership, constraints and verification
  requirements; prevent overlapping edits. The primary retains design,
  integration, and acceptance authority.
- Keep decisions, progress, blockers, deferred work, branch/PR links and evidence
  synchronized in GitHub. Do not mark work done before its delivery state supports it.
- Every Codex-created commit includes `Co-authored-by: Codex <codex@openai.com>`.
  Preserve the user's authorship and signing configuration.
- Merge only when authorized and all required CI has passed on the reviewed head.
  Never bypass protection or lower checks to deliver. Publishing, releases and
  destructive operations require their own applicable authorization.
- Before removing a completed worktree, verify it is clean, committed and safely
  pushed or handed off, with branch/PR recorded in GitHub. Do not discard user
  changes or unpushed work. Remove the safe worktree and prune stale metadata.
- Follow the [release skill](.agents/skills/tmt-release/SKILL.md) for branch-line
  policy; do not duplicate or improvise long-lived branch rules here.

## Code organization

- Keep production behavior, test infrastructure, fixtures, and scenario assertions in clearly separated modules.
- Prefer small, purpose-specific interfaces and existing dependency-injection boundaries over new global state or parallel abstractions.
- Put shared behavior in one named helper only after more than one caller needs it; keep scenario-specific behavior close to the scenario.
- Use names that describe observable behavior and stable domain concepts rather than implementation accidents.
- Keep changes bounded to the tracked issue. Record adjacent improvements as follow-up work instead of silently expanding scope.

## Verification quality

- Verify observable behavior and durable state, not only exit codes, log echoes, snapshots, or test counts.
- Include representative success, failure, cleanup, and lifecycle cases for the changed behavior.
- Prefer deterministic readiness signals and bounded polling over fixed sleeps.
- Treat false positives, leaked processes, leaked tmux servers, and non-isolated state as test failures.
- Run the repository checks relevant to every changed layer and report the exact commands and results.
