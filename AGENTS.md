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
and verification evidence in the PR and Linear issue. If there are no findings,
state what was inspected rather than merely saying "LGTM". Review later changes
and rerun affected checks before accepting a newer head.

For every PR, follow the [architecture maintenance contract](ARCHITECTURE.md#maintenance-contract):
update affected architecture and developer guidance in the same PR, or explain
why the change does not affect them. The implementer proposes documentation
updates; the primary reviewer verifies them against code before merge. A linked
follow-up is not permission to ship inaccurate descriptions of current behavior.

## Pattern audit before changes

Before editing code, tests, documentation, configuration, or repository skills, the primary agent must delegate a read-only repository pattern audit to a `gpt-5.6-luna` agent with high reasoning effort.

The audit must inspect the relevant architecture, helpers, fixtures, scripts, naming conventions, tests, documentation, and skills. It must identify reusable patterns, duplicated behavior, and conflicts with established conventions. The delegated agent must not edit files, mutate external systems, or broaden the requested scope during this audit.

The primary agent must review the findings before any edits begin, record which findings are accepted or rejected and why, and reuse or extend established abstractions where practical. If the audit finds unnecessary duplication or an inconsistent implementation within scope, correct it before continuing. When this rule is introduced after work has started, pause new edits, run the audit, and apply the same review.

If delegation is unavailable, document that limitation and perform the same read-only audit locally before editing. Delegation never expands the user's authorization.

## Repository content language

All repository content must be written in English, including code, tests,
comments, documentation, configuration, workflows, repository skills, commit
messages, and pull request metadata. Non-language symbols and technically
required fixture data are allowed when necessary; explain any such exception
in English.

## Delivery lifecycle

- For development beyond incidental edits, use one tracked Linear issue, one
  dedicated branch/worktree, and one reviewable PR. Confirm outcome, scope,
  acceptance criteria, dependencies and project relationship before editing;
  mark the issue started when implementation begins. Split oversized work first.
- Delegate bounded implementation to `gpt-5.6-luna` by default when available.
  Give explicit file ownership, constraints and verification requirements;
  prevent overlapping edits. The primary retains design and acceptance authority.
- Keep decisions, progress, blockers, deferred work, branch/PR links and evidence
  synchronized in Linear. Do not mark work done before its delivery state supports it.
- Every Codex-created commit includes `Co-authored-by: Codex <codex@openai.com>`.
  Preserve the user's authorship and signing configuration.
- Merge only when authorized and all required CI has passed on the reviewed head.
  Never bypass protection or lower checks to deliver. Publishing, releases and
  destructive operations require their own applicable authorization.
- Before removing a completed worktree, verify it is clean, committed and safely
  pushed or handed off, with branch/PR recorded in Linear. Do not discard user
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
