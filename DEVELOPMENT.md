# Development

## Project Setup

- Requirements: Node.js >= 18
- Install dependencies:

```bash
npm install
```

- Run the CLI locally:

```bash
npm run dev -- --help
```

## Running Tests

- Watch mode:

```bash
npm test
```

- Single run:

```bash
npm run test:run
```

- Full checks:

```bash
npm run check
```

## Testing Strategy

We prefer structured, deterministic assertions in tests. Human-facing formatting is validated sparingly; most tests assert on structured output or file contents.

### 1) Structured Output Verification

- Always use JSON mode (`--json`) in tests when you need structured output.
- Assert on `ui.json` or `ui.jsonData`, not `console.log`.
- Example:

```ts
const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

cmdConfig(ctx, ['show']);

expect(ctx.ui.json).toHaveBeenCalledTimes(1);
expect(ctx.ui.json).toHaveBeenCalledWith(
  expect.objectContaining({ resolved: expect.any(Object) })
);
```

### 2) Mock Isolation

- Clear mocks before the call being tested to avoid stale assertions.
- Use `toHaveBeenCalledTimes(1)` to ensure a single output.
- Example:

```ts
(ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
cmdConfig(ctx, ['show']);
expect(ctx.ui.json).toHaveBeenCalledTimes(1);
```

### 3) File Content Verification

- For config tests, read actual files from disk and assert on contents.
- Use temp directories and clean up in `afterEach`.
- Example:

```ts
testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
// ... run operation ...
const configPath = path.join(testDir, 'config.json');
const content = fs.readFileSync(configPath, 'utf-8');
expect(content).toContain('polling');
```

### 4) Table Output

- Verify table output via the `ui.table` mock (headers and rows).
- Example:

```ts
cmdList(ctx, []);
expect(ctx.ui.table).toHaveBeenCalledWith(
  ['Name', 'Pane', 'Remark'],
  expect.any(Array)
);
```

### 5) Avoid console.log mocking

- Don’t override `console.log` directly in tests (leak risk).
- Use JSON mode for structured verification or assert on `ui.table`/`ui.json` mocks.

## Rationale for Structured Testing

- **Deterministic**: JSON output is stable; formatted strings are brittle.
- **Clear intent**: Tests assert on the data, not presentation details.
- **Lower maintenance**: Formatting changes don’t break unrelated tests.
- **Faster debugging**: `ui.jsonData` and mock call assertions pinpoint mismatches.

When a test must validate human-readable output, keep it focused and minimal (single formatter test) so the rest of the suite stays stable.
