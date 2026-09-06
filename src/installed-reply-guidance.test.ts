import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli/parser.js';

// Provider wrappers differ, but each shipped entry point must teach the same
// reply input contract. Real CLI and Docker tests own execution semantics.
describe('shipped reply guidance', () => {
  it.each([
    'skills/tmux-team/SKILL.md',
    'skills/codex/SKILL.md',
    'skills/claude/team.md',
    'plugins/tmux-team/skills/tmux-team/SKILL.md',
    'plugins/tmux-team/commands/team.md',
    'plugins/tmux-team/commands/learn.md',
  ])('%s exposes inline and streaming/file alternatives', (relativePath) => {
    const source = fs.readFileSync(
      fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
      'utf8'
    );
    expect(source).toContain(
      "tmt reply <request-id> --receipt <receipt> --message 'Review complete.'"
    );
    expect(source).toContain('tmt reply <request-id> --receipt <receipt> --file response.md');
    expect(source).toContain('tmt reply <request-id> --receipt <receipt> --stdin');
    expect(source).toContain('operating-system size limits');
    expect(source).toContain('cannot contain NUL');
    expect(source).toContain('do not guarantee hidden UI');
  });

  it('keeps the short reply example compatible with the public parser', () => {
    expect(
      parseArgs(['reply', 'request-1', '--receipt', 'receipt', '--message', 'Review complete.'])
        .invocation
    ).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt: 'receipt',
      message: 'Review complete.',
    });
  });
});
