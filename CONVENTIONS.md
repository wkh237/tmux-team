# tmux-team Coding Conventions

Team consensus from Claude, Codex, and Gemini (2025-12-19).

---

## Architecture: The Context Pattern

**Rule:** Commands must be pure functions that receive a `Context` object.

**Reason:** Enables dependency injection for testing (mock Tmux, FileSystem, etc.).

**Constraint:**
- Never use `process.exit()` inside a command → use `ctx.exit()`
- Never use `console.log()` inside a command → use `ctx.ui.*`

```typescript
// ✅ Good
export async function cmdTalk(ctx: Context, target: string, message: string): Promise<void> {
  const { ui, tmux, exit } = ctx;
  // ...
  ui.success('Message sent');
}

// ❌ Bad
export async function cmdTalk(ctx: Context, target: string, message: string): Promise<void> {
  console.log('Message sent');  // Don't use console directly
  process.exit(0);              // Don't use process.exit
}
```

---

## Naming & Structure

### Command Functions
- Prefix with `cmd` (e.g., `cmdTalk`, `cmdPmInit`, `cmdMilestoneAdd`)

### File Names
- Use kebab-case: `talk.ts`, `config.ts`, `fs.ts`
- Test files: `<name>.test.ts` (colocated with source)

### Directory Structure
- Group related logic in subdirectories: `src/pm/`, `src/commands/`
- Prefer function-based modules over classes
- Only use `class` for stateful implementations like `StorageAdapter`

### Imports
- ESM-style with explicit `.js` extensions (tsx-compatible)
```typescript
import { loadConfig } from './config.js';
import type { Context } from './types.js';
```

---

## Configuration & Paths

### Priority (Lowest → Highest)
```
Defaults → Global Config → Local Config → CLI Flags
```
CLI flags always win.

### Path Resolution
- Always use `ctx.paths` object
- Never hardcode `~/.tmux-team` or `./tmux-team.json`
- XDG compliance via `config.ts` logic

```typescript
// ✅ Good
const stateFile = ctx.paths.stateFile;

// ❌ Bad
const stateFile = path.join(os.homedir(), '.tmux-team', 'state.json');
```

---

## CLI & UX

### JSON Contract
Every command must support `--json` flag:
- If `flags.json` is true, output single valid JSON object to stdout
- Errors also go as JSON (with `error` field)
- No mixing stdout/stderr in JSON mode

```typescript
if (flags.json) {
  ui.json({ status: 'success', data: result });
} else {
  ui.success('Operation completed');
}
```

### TTY Awareness
- Use `isTTY` checks for spinners, progress indicators, colors
- Ensure clean output when piped to other tools

### Exit Codes
Always use `ExitCodes` registry:
| Code | Name | Meaning |
|------|------|---------|
| 0 | `SUCCESS` | Command completed |
| 1 | `ERROR` | General error |
| 2 | `CONFIG_MISSING` | Required config missing |
| 3 | `PANE_NOT_FOUND` | Tmux pane not found |
| 4 | `TIMEOUT` | Wait timed out |
| 5 | `CONFLICT` | GitHub state differs |

---

## Time Values

Default to **seconds** (no suffix needed):
- `--delay 5` → 5 seconds
- `--timeout 60` → 60 seconds
- `--delay 500ms` → 500 milliseconds (suffix supported)

Normalize in CLI parsing; avoid internal ms unless explicitly noted.

---

## Data Integrity

### Audit Trail
Every state-changing PM command must append to `events.jsonl`:
```typescript
await storage.appendEvent({
  event: 'task_created',
  id: task.id,
  actor: 'human',
  ts: new Date().toISOString(),
});
```

### File Operations
- Prefer synchronous FS operations in CLI paths for simplicity
- Use `fs.writeFileSync` for atomic-like config/state updates

---

## PM: Storage Adapter Pattern

### Interface
`StorageAdapter` is the seam between PM commands and backends:
- `FSAdapter` is the reference implementation (Phase 4)
- `GitHubAdapter` will be added in Phase 5

### ID Generation
- Auto-incrementing integers for tasks/milestones
- IDs are scoped per team

### Audit Log
- Append-only JSONL format (`events.jsonl`)
- One JSON object per line

---

## Talk: Message Building

### Preamble Format
```
[SYSTEM: <preamble>]

<message>
```
- Blank line separates preamble from message
- Use `buildMessage()` helper for consistent formatting

### Nonce Markers
```
{tmux-team-end:<nonce>}
```
- 4-character hex nonce
- Appended in `[IMPORTANT: ...]` instruction block

### Agent Filters
- Gemini: Remove `!` from messages (TTY rendering issue)

---

## Code Style

### Header Comments
Use consistent separator pattern:
```typescript
// ─────────────────────────────────────────────────────────────
// Section Title
// ─────────────────────────────────────────────────────────────
```

### Error Handling
- Validate early, fail fast
- Use `ctx.exit(ExitCodes.*)` for expected errors
- Let unexpected errors bubble up to top-level handler

### Type Annotations
- Use `type` imports for types-only: `import type { Context } from './types.js'`
- Explicit return types on exported functions

---

## Testing

### File Naming
- Colocate tests: `foo.test.ts` next to `foo.ts`
- Use vitest with `describe/it/expect`

### Test Structure
```typescript
describe('functionName', () => {
  it('does expected behavior', () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Mocking
- Mock `ctx` for command tests
- Mock filesystem for storage tests
- Use `vi.mock()` for module mocks

---

## Changelog

- **2025-12-19**: Initial conventions from Phase 1-4 implementation review
