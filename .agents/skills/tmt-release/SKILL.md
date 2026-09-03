---
name: tmt-release
description: Maintain and promote tmux-team release lines, versions, and prerelease readiness without assuming publish authorization.
---

# tmux-team release management

Use this skill for release-line maintenance, v4 compatibility fixes, v5 promotion, version synchronization, or prerelease readiness in this repository.

## Long-lived branch policy

- `main` is the active v5 line after promotion.
- `v4` is the maintenance line rooted at commit `7056679dfa816a1acef8e7c978cf1733a578115b`.
- If remote `v4` does not exist, create it at that exact anchor only when the user has explicitly requested the maintenance line, then verify the remote ref before continuing.
- Before any branch mutation, verify the relevant remote refs and ancestry. Never force-push or repoint a long-lived line.
- A v4 maintenance fix requires a tracked issue, a dedicated branch and worktree, and a reviewable pull request. Keep the fix on the v4 line unless an explicitly scoped backport is requested.
- Use the checks available on the v4 line for maintenance pull requests; do not require contexts that the target branch cannot produce. Record any coverage gap in the issue.
- Synchronize `package.json`, `.claude-plugin/marketplace.json`, `plugins/tmux-team/.claude-plugin/plugin.json`, the `src/version.ts` fallback, and its test whenever a release version changes.
- Follow `AGENTS.md` for Linear state, branch and pull-request links, verification evidence, and safe worktree cleanup.

## Promotion and prerelease checks

- Promotion requires passing Code quality, Unit tests, and Docker E2E checks.
- Tags, GitHub Releases, npm publishing, and npm dist-tags are separate operations that require explicit authorization; this skill never assumes permission for them.
- Update user-facing installation or channel documentation whenever a version change would make it inaccurate.
- A future prerelease publish must use a non-`latest` npm dist-tag. Before declaring it available, inspect the registry dist-tags and install the exact published version in a clean temporary environment.
