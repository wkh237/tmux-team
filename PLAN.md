# tmux-team v2 Implementation Plan

> Team consensus reached between Claude (lead), Codex, and Gemini.

---

## Overview

This document outlines the implementation plan for tmux-team v2, which introduces:

1. **Enhanced `talk` command** with `--delay` and `--wait` flags
2. **Global configuration** with agent preambles
3. **Project management** for milestone and task tracking
4. **GitHub integration** for visualizing tasks as GitHub Issues

The implementation is divided into 5 phases, each building on the previous.

---

## Architecture

```
bin/tmux-team              # Thin command router + argument parsing

lib/
├── context.js             # Context object passed to all commands
├── ui.js                  # Logging, colors, --json output
├── config.js              # 3-tier config hierarchy
├── tmux.js                # Pure tmux wrapper (send-keys, capture-pane)
├── talk.js                # Enhanced talk with --delay, --wait
├── state.js               # State management (locks, request tracking)
├── exits.js               # Exit code registry
└── pm/                    # Project management
    ├── index.js           # Main entry, adapter selection
    ├── teams.js
    ├── tasks.js
    ├── milestones.js
    ├── models/            # Shared Task/Milestone schemas
    │   └── index.js
    └── storage/           # Storage adapters
        ├── adapter.js     # Abstract interface
        ├── fs.js          # Filesystem implementation
        └── github.js      # GitHub Issues implementation (Phase 5)

~/.tmux-team/              # Global config directory
├── config.json            # Global settings + agent profiles
├── state.json             # Runtime state (locks, request tracking)
├── locks/                 # Per-agent lock files
│   └── <agent>.lock
└── teams/<uuid>/          # Project data
    ├── team.json
    ├── id-map.json        # Local ID → GitHub issue number mapping (Phase 5)
    ├── milestones/<id>.json
    ├── tasks/<id>.json
    ├── tasks/<id>.md      # Task documentation
    └── events.jsonl       # Audit log (fs backend) / GitHub Comments (github backend)

./tmux-team.json           # Local agent pane registry (existing)
```

---

## Phase 1: Refactor + Config Foundation

### Goal

Extract modules from monolithic `bin/tmux-team`, establish context pattern, add `--json` output, define exit codes. **Keep CLI behavior identical.**

### Why This First?

- Phase 2 (`--wait`) needs config defaults like `pollInterval` and `timeout`
- Stable exit codes enable scripting by agents early
- Clean module boundaries make subsequent phases easier

### Deliverables

| File | Purpose |
|------|---------|
| `lib/context.js` | Central `ctx` object passed to all commands |
| `lib/ui.js` | Logging with `--json` support, TTY-aware colors |
| `lib/config.js` | 3-tier hierarchy: global → local → CLI flags |
| `lib/tmux.js` | Pure wrapper for `send-keys`, `capture-pane` |
| `lib/exits.js` | Exit code registry |

### Context Object

```javascript
// lib/context.js
ctx = {
  argv: [],                    // Raw arguments
  flags: {                     // Global flags
    json: false,
    verbose: false,
    config: null,              // Override config path
  },
  ui: {                        // From lib/ui.js
    info(msg),
    success(msg),
    error(msg),
    table(data),
    render(data),              // Respects --json
  },
  config: {                    // From lib/config.js
    mode: 'polling',
    preambleMode: 'always',
    defaults: { timeout: 60000, pollInterval: 1000, captureLines: 500 },
    agents: {},                // Per-agent config (preambles, etc.)
    local: {},                 // Raw local config
    global: {},                // Raw global config
  },
  tmux: {                      // From lib/tmux.js
    send(pane, message),
    capture(pane, lines),
    listPanes(),
  },
  paths: {
    globalDir: '~/.tmux-team',
    globalConfig: '~/.tmux-team/config.json',
    localConfig: './tmux-team.json',
    stateFile: '~/.tmux-team/state.json',
    locksDir: '~/.tmux-team/locks',
  },
  exits: {                     // From lib/exits.js
    SUCCESS: 0,
    ERROR: 1,
    CONFIG_MISSING: 2,
    PANE_NOT_FOUND: 3,
    TIMEOUT: 4,
  },
}
```

### Exit Code Registry

| Code | Name | Meaning |
|------|------|---------|
| 0 | `SUCCESS` | Command completed successfully |
| 1 | `ERROR` | General error (invalid JSON, unknown command, etc.) |
| 2 | `CONFIG_MISSING` | Required config missing (local pane registry not found) |
| 3 | `PANE_NOT_FOUND` | Tmux pane not found or tmux not running |
| 4 | `TIMEOUT` | `--wait` timed out (reserved for Phase 2) |

### Config Hierarchy

```
Defaults (hardcoded)
    ↓ override
Global (~/.tmux-team/config.json)
    ↓ override
Local (./tmux-team.json)
    ↓ override
CLI flags (--timeout, --no-preamble, etc.)
```

### `--json` Output Contract

When `--json` is passed:
- Suppress colors and progress indicators
- Output structured JSON to stdout
- Errors go to stderr as JSON

```json
{
  "command": "talk",
  "agent": "codex",
  "pane": "10.1",
  "status": "success",
  "requestId": "req_20251219_abc123",
  "error": null
}
```

### Design Notes

- **`lib/tmux.js` is pure**: No knowledge of `tmux-team.json`, only knows tmux commands
- **Smoke test parity**: All existing commands must work identically after refactor
- **XDG compliance**: Respect `XDG_CONFIG_HOME` if set, otherwise use `~/.tmux-team`

---

## Phase 2: Enhanced `talk` Command

### Goal

Add `--delay` and `--wait` flags with nonce-based completion detection.

### Why `--delay` Instead of `sleep`?

Tool allowlists typically approve one safe command (`tmux-team talk:*`) but not arbitrary shell commands. Using `sleep` is:
- Often blocked by security policies
- Requires shell availability and proper quoting
- Creates a separate process that's hard to manage

Internal delay keeps the workflow as a **single tool call**.

### Deliverables

| Feature | Description |
|---------|-------------|
| `--delay <time>` | Wait before sending, accepts `500ms`, `2s`, or raw ms |
| `--wait` | Send + poll until completion marker detected |
| `--timeout <time>` | Max wait time (default: 60s from config) |
| `lib/state.js` | Request tracking, locking |

### Command Syntax

```bash
# Delay before sending
tmux-team talk codex "message" --delay 5s

# Wait for response
tmux-team talk codex "message" --wait
tmux-team talk codex "message" --wait --timeout 120s

# Combined
tmux-team talk codex "message" --delay 2s --wait --timeout 60s
```

### Nonce Protocol

The "Zero-API RPC" mechanism over TTY streams.

**Flow:**

1. `talk --wait` generates unique 4-char nonce (e.g., `8f3a`)
2. Appends instruction to message:
   ```
   <original message>

   [IMPORTANT: When your response is complete, print exactly: {tmux-team-end:8f3a}]
   ```
3. Records request in `~/.tmux-team/state.json`:
   ```json
   {
     "requests": {
       "codex": {
         "id": "req_20251219_abc123",
         "nonce": "8f3a",
         "anchor": "line_hash_before_send",
         "createdAt": "2025-12-19T10:30:00Z"
       }
     }
   }
   ```
4. Polls `tmux capture-pane` at configured interval
5. Searches for `{tmux-team-end:8f3a}` in output
6. Returns captured response when found, clears state

**Why nonces?**
- **Collision avoidance**: Prevents matching markers from previous turns
- **Completion safety**: Ensures agent truly finished, not just paused
- **Deterministic**: Ties response to specific request

### Locking

One request at a time per agent to prevent interleaving.

```
~/.tmux-team/locks/
├── codex.lock
└── gemini.lock
```

- Use atomic file creation (`O_EXCL`)
- Include PID for stale lock detection
- `--force` flag to override stale locks

### Streaming Output

```
# TTY mode: in-place updates
⏳ Waiting for codex... (5s)

# Non-TTY mode: periodic log lines
[tmux-team] Waiting for codex (5s elapsed)
[tmux-team] Waiting for codex (10s elapsed)
```

### Design Notes

- **Graceful SIGINT**: Ctrl+C stops polling but doesn't kill target agent
- **Buffer truncation**: Track anchor point to capture from command start, not just last N lines
- **Sequential for `talk all --wait`**: Process agents one at a time for v1
- **Argument parser**: Need real parser to support trailing flags

---

## Phase 3: Preambles (Context Injection)

### Goal

Inject hidden instructions per agent to prevent "instruction drift" and reduce cognitive load.

### Why Preambles?

AI agents forget constraints over long sessions. Manually re-typing system instructions is a "token tax." Preambles:
- Ensure agents stay "in character"
- Centralize policy instead of repeating manually
- Reduce cognitive load for humans

### Deliverables

| Feature | Description |
|---------|-------------|
| `preambleMode` | `always` or `disabled` (global setting) |
| Per-agent preambles | In config: `agents.<name>.preamble` |
| `--no-preamble` flag | Skip preamble for specific message |

### Config Schema

```json
{
  "preambleMode": "always",
  "agents": {
    "gemini": {
      "pane": "10.2",
      "preamble": "Do not edit files until explicitly asked. Always explain your reasoning."
    },
    "codex": {
      "pane": "10.1",
      "preamble": "Focus on code quality and testing. Be concise."
    }
  }
}
```

### Message Format

When `preambleMode: "always"`:

```
[SYSTEM: Do not edit files until explicitly asked.]

<user's actual message>
```

### Design Notes

- **Visibility**: Preamble is visible in agent's pane (we're sending keys to TTY)
- **Clear formatting**: Wrap in `[SYSTEM: ...]` to distinguish from user content
- **Deep merge**: Local config always wins over global for same keys
- **Single string**: Ensure preambles don't break quoting—send as one combined string

---

## Phase 4: Project Management (Core + FS Backend)

### Goal

Lightweight task tracking that agents can update programmatically, enabling divide-and-conquer workflows. Implement with **storage adapter pattern** to enable GitHub backend in Phase 5.

### Why PM?

When coordinating multiple agents:
- Need shared understanding of tasks and progress
- Agents should self-report status
- History should be auditable (who changed what, when)

### Why Storage Adapters?

Phase 5 will add GitHub as a backend. By implementing the adapter interface in Phase 4:
- Clean separation between PM logic and storage
- `fs` adapter provides stable, offline-first reference
- `github` adapter can focus on `gh` CLI interaction

### Deliverables

| Command | Description |
|---------|-------------|
| `pm init [--name]` | Create team with UUID |
| `pm milestone add <name>` | Add milestone |
| `pm milestone list` | List milestones |
| `pm milestone done <id>` | Mark milestone complete |
| `pm task add <title> [--milestone <id>]` | Add task |
| `pm task list [--milestone <id>] [--status <s>]` | List tasks |
| `pm task show <id>` | Show task details |
| `pm task update <id> --status <status>` | Update task |
| `pm task done <id>` | Mark task complete |
| `pm doc <id> [--print]` | View/edit task documentation |
| `pm jump` | Jump to team's tmux window |

### Data Model

```
~/.tmux-team/teams/<uuid>/
├── team.json
├── milestones/
│   └── 1.json
├── tasks/
│   ├── 1.json
│   ├── 1.md
│   ├── 2.json
│   └── 2.md
└── events.jsonl
```

**team.json:**
```json
{
  "id": "uuid-here",
  "name": "Auth Refactor",
  "windowId": "10",
  "createdAt": "2025-12-19T10:00:00Z"
}
```

**milestones/1.json:**
```json
{
  "id": "1",
  "name": "MVP Release",
  "status": "in_progress",
  "createdAt": "2025-12-19T10:00:00Z",
  "updatedAt": "2025-12-19T12:00:00Z"
}
```

**tasks/1.json:**
```json
{
  "id": "1",
  "title": "Implement login flow",
  "milestone": "1",
  "status": "pending",
  "assignee": null,
  "docPath": "tasks/1.md",
  "createdAt": "2025-12-19T10:00:00Z",
  "updatedAt": "2025-12-19T10:00:00Z"
}
```

### Task ID Format

- **Default**: Auto-incrementing numbers (`1`, `2`, `3`)
- **Milestone notation**: `<milestone>-<task>` (e.g., `1-2`)
- **Opaque**: Accept any string—numeric is convention, not enforced

### Audit Log

Append-only `events.jsonl` for auditability:

```jsonl
{"event":"task_created","id":"1","title":"Implement login flow","actor":"human","ts":"2025-12-19T10:00:00Z"}
{"event":"task_updated","id":"1","field":"status","from":"pending","to":"in_progress","actor":"codex","ts":"2025-12-19T11:00:00Z"}
{"event":"task_updated","id":"1","field":"status","from":"in_progress","to":"done","actor":"codex","ts":"2025-12-19T12:00:00Z"}
```

Benefits:
- Enables future `pm undo` feature
- Prevents silent history rewrites
- Agents can update, but changes are traceable

### Locking

Multiple agents may update tasks concurrently. Use file-level locking:

```javascript
// Atomic append to events.jsonl
fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', { flag: 'a' });
```

For task JSON updates, use lock file pattern similar to Phase 2.

### Storage Adapter Interface

```javascript
// lib/pm/storage/adapter.js
class StorageAdapter {
  async getTeam(teamId) {}
  async createTeam(team) {}

  async listMilestones(teamId) {}
  async createMilestone(teamId, milestone) {}
  async updateMilestone(teamId, id, updates) {}

  async listTasks(teamId, filters) {}
  async createTask(teamId, task) {}
  async updateTask(teamId, id, updates) {}
  async getTask(teamId, id) {}

  async appendEvent(teamId, event) {}
  async getEvents(teamId) {}
}
```

### Design Notes

- **Local pointer file**: Store `./.tmux-team/team.json` with just the UUID to link repo → team
- **JSON as source of truth**: `tasks/<id>.json` is canonical; `events.jsonl` is audit trail
- **Agent permissions**: Agents can update status via `tmux-team pm task update`—this is intentional
- **Adapter selection**: Based on `pm.storage` config (`fs` or `github`)

---

## Phase 5: GitHub Integration

### Goal

Add GitHub Issues as a storage backend, enabling teams to visualize and manage tasks in GitHub's UI while agents update via CLI.

### Why GitHub?

- **Visibility**: Humans can watch progress on GitHub's project board
- **Cross-agent knowledge**: Agent A can see Agent B finished Issue #5
- **Persistence**: No need to sync `~/.tmux-team/` across machines
- **Familiar UI**: Teams already use GitHub for project management

### Prerequisites

- `gh` CLI installed and authenticated
- Repository has GitHub remote configured

### Config Schema

```json
{
  "pm": {
    "storage": "github",
    "repo": "owner/repo",
    "labels": {
      "pending": { "name": "tmux-team:pending", "color": "FBCA04" },
      "in_progress": { "name": "tmux-team:in_progress", "color": "0052CC" },
      "done": { "name": "tmux-team:done", "color": "0E8A16" }
    }
  }
}
```

### Deliverables

| Feature | Description |
|---------|-------------|
| `lib/pm/storage/github.js` | GitHub storage adapter |
| Repo auto-detection | Parse `git remote get-url origin` |
| Status mapping | Labels for pending/in_progress, closed for done |
| ID mapping | Local `id-map.json` linking task IDs to issue numbers |
| Audit via comments | Post status changes as issue comments |

### Repo Detection

Auto-detect GitHub repo from git remote:

```bash
# These formats are normalized to "owner/repo"
git@github.com:owner/repo.git     → owner/repo
https://github.com/owner/repo.git → owner/repo
```

Allow override via:
- Config: `pm.repo = "owner/repo"`
- CLI flag: `--repo owner/repo`

### Status Mapping

GitHub Issues only have open/closed states. Use labels for granular status:

| tmux-team Status | GitHub State | GitHub Label |
|------------------|--------------|--------------|
| `pending` | Open | `tmux-team:pending` |
| `in_progress` | Open | `tmux-team:in_progress` |
| `done` | Closed | (labels removed) |

**Rules:**
- Exactly one status label at a time
- If issue is closed, treat as `done` regardless of labels
- If no label and open, default to `pending`

### ID Mapping

Local task IDs (1, 2, 1-2) don't match GitHub issue numbers (#42, #43).

Store mapping in `~/.tmux-team/teams/<uuid>/id-map.json`:

```json
{
  "1": { "issueNumber": 42, "nodeId": "I_kwDOxxx" },
  "2": { "issueNumber": 43, "nodeId": "I_kwDOyyy" },
  "1-2": { "issueNumber": 44, "nodeId": "I_kwDOzzz" }
}
```

Display both in CLI output: `Task 1-2 (#44)`

### Milestone Mapping

- tmux-team milestone → GitHub milestone
- `milestone done` → Close GitHub milestone
- Don't auto-close milestones when all issues closed (explicit action required)

### Audit Trail

For `storage=github`, use **Issue Comments** instead of `events.jsonl`:

```markdown
**[tmux-team]** Status changed: `pending` → `in_progress`
Actor: codex | 2025-12-19T11:00:00Z
```

**When to comment:**
- Status transitions (pending → in_progress → done)
- Milestone changes
- Not on every field update (too noisy)

### Sync Strategy

**v1: Unidirectional (CLI → GitHub)**

- GitHub is source of truth
- CLI commands directly call `gh issue create/edit/close`
- Local `id-map.json` is cache only

**Conflict handling:**
- Store `updatedAt` in id-map
- On update, fetch current state first
- If stale, return error with `--json` payload
- `--force` flag for last-write-wins

**Future (v2+):**
- `pm sync --pull`: GitHub → local cache
- Bidirectional sync for offline-first workflows

### Command Examples

```bash
# Auto-detects repo, creates GitHub issue
tmux-team pm task add "Implement auth" --milestone 1
# → gh issue create --title "Implement auth" --milestone "MVP" --label "tmux-team:pending"

# Updates issue state
tmux-team pm task update 1 --status in_progress
# → gh issue edit 42 --remove-label "tmux-team:pending" --add-label "tmux-team:in_progress"
# → gh issue comment 42 --body "[tmux-team] Status: pending → in_progress (actor: codex)"

# Closes issue
tmux-team pm task done 1
# → gh issue close 42
```

### Design Notes

- **Graceful degradation**: If `gh` not installed, fall back to `fs` with warning
- **Rate limiting**: Cache `gh` responses, batch updates where possible
- **Labels auto-creation**: Create `tmux-team:*` labels with colors if they don't exist
- **Exit code 5**: Reserved for `CONFLICT` when GitHub state differs from expected
- **Offline handling**: Print error to stderr and fail immediately (no queuing)

### GitHub Projects (Kanban Board)

Instead of building GraphQL integration, we document how to use GitHub's native automation:

1. **Create a Project** with columns: `To Do`, `In Progress`, `Done`
2. **Auto-add rule**: Add issues with label `tmux-team:*` to the project
3. **Workflow rules**:
   - When label `tmux-team:pending` added → Move to "To Do"
   - When label `tmux-team:in_progress` added → Move to "In Progress"
   - When issue closed → Move to "Done"

This gives users a Kanban UI without adding GraphQL complexity to the CLI. Future versions may add native Projects support as Phase 6.

---

## Implementation Order

```
Phase 1: Foundation
├── lib/exits.js           # Exit code constants
├── lib/ui.js              # Logging, --json support
├── lib/config.js          # Config loading + merge
├── lib/tmux.js            # Pure tmux wrapper
├── lib/context.js         # Context builder
└── bin/tmux-team          # Migrate to use ctx pattern

Phase 2: Talk Enhancement
├── Argument parser        # Support trailing flags
├── lib/state.js           # Request tracking, locks
├── --delay flag           # Internal setTimeout
└── --wait flag            # Nonce protocol + polling

Phase 3: Preambles
├── Config schema update   # Add preambleMode, agent preambles
├── Message builder        # Prepend preamble to messages
└── --no-preamble flag     # Override for single message

Phase 4: Project Management (Core + FS)
├── lib/pm/storage/adapter.js  # Abstract interface
├── lib/pm/storage/fs.js       # Filesystem implementation
├── lib/pm/teams.js            # Team init, metadata
├── lib/pm/milestones.js       # Milestone CRUD
├── lib/pm/tasks.js            # Task CRUD + events
├── pm commands                # CLI surface
└── doc command                # Documentation viewer/editor

Phase 5: GitHub Integration
├── lib/pm/storage/github.js   # GitHub adapter
├── Repo auto-detection        # Parse git remote
├── Label management           # Create tmux-team:* labels
├── ID mapping                 # id-map.json
└── Audit comments             # Post status changes
```

---

## Testing Strategy

### Phase 1: Smoke Tests

Ensure all existing commands work identically:

```bash
# These should all work exactly as before
tmux-team init
tmux-team add test 10.0 "Test agent"
tmux-team list
tmux-team talk test "Hello"
tmux-team check test
tmux-team update test --remark "Updated"
tmux-team remove test
```

### Phase 2: Wait Mode Tests

```bash
# Manual test with cooperating agent
tmux-team talk codex "Say hello and end with the marker" --wait --timeout 30s

# Timeout behavior
tmux-team talk codex "Never respond" --wait --timeout 5s
# Should exit with code 4
```

### Phase 3: Preamble Tests

```bash
# Verify preamble appears in target pane
tmux-team talk gemini "What were your instructions?"

# Verify --no-preamble works
tmux-team talk gemini "What were your instructions?" --no-preamble
```

### Phase 4: PM Tests

```bash
tmux-team pm init --name "Test Project"
tmux-team pm milestone add "Phase 1"
tmux-team pm task add "First task" --milestone 1
tmux-team pm task list
tmux-team pm task done 1
tmux-team pm doc 1 --print
```

### Phase 5: GitHub Tests

```bash
# Requires gh CLI authenticated and a test repo

# Test repo detection
cd /path/to/github-repo
tmux-team pm init --name "GitHub Test"
# Should auto-detect owner/repo

# Test issue creation
tmux-team pm task add "Test issue" --milestone 1
# Verify: gh issue list should show new issue with tmux-team:pending label

# Test status update
tmux-team pm task update 1 --status in_progress
# Verify: issue has tmux-team:in_progress label, comment posted

# Test task completion
tmux-team pm task done 1
# Verify: issue is closed

# Test conflict detection
# (manually edit issue title in GitHub UI, then try to update via CLI)
tmux-team pm task update 1 --status pending
# Should fail with exit code 5 (CONFLICT)

tmux-team pm task update 1 --status pending --force
# Should succeed with warning
```

---

## Open Questions

### Resolved

1. **Preamble format**: `[SYSTEM: ...]` is the agreed wrapper. Can refine in Phase 3 based on model feedback.

2. **Wait mode for `talk all`**: Disallowed for v1—sequential waiting is too complex and error-prone.

3. **PM storage**: Task docs (`.md`) stored in `~/.tmux-team/` to keep repos clean. Can add export feature later.

4. **GitHub sync direction**: Unidirectional (CLI → GitHub) for v1. GitHub is source of truth.

5. **Audit trail for GitHub**: Use Issue Comments for status transitions. `events.jsonl` only for `fs` backend.

6. **GitHub label colors**: Yes, auto-create with specific colors:
   - `tmux-team:pending` → Yellow (`#FBCA04`)
   - `tmux-team:in_progress` → Blue (`#0052CC`)
   - `tmux-team:done` → Green (`#0E8A16`) — applied before closing for visual consistency

7. **Offline mode for GitHub**: Simple—print error to stderr and fail immediately. No queuing.

8. **GitHub Projects integration**: Not built into CLI. Instead, document how to use GitHub's native automation:
   - Users create a Project with columns (To Do, In Progress, Done)
   - Use GitHub's built-in "Auto-add" to include issues with `tmux-team:*` labels
   - Use GitHub's "Workflows" to auto-move cards when labels change
   - This gives Kanban UI without GraphQL complexity in the CLI

### Open

*(All questions resolved)*

---

## Changelog

- **2025-12-19**: Initial plan drafted with team consensus (Claude, Codex, Gemini)
- **2025-12-19**: Added Phase 5 (GitHub Integration) with storage adapter pattern, status mapping via labels, and audit via issue comments
- **2025-12-19**: Resolved all open questions—label colors (yellow/blue/green), offline mode (fail fast), GitHub Projects (use native automation, document setup)
