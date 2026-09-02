# Repository Working Agreement

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
