import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli/parser.js';

// The canonical installed skill must teach the complete reply input contract.
// Real CLI and Docker tests own execution semantics.
describe('shipped reply guidance', () => {
  it('exposes inline and streaming/file alternatives', () => {
    const relativePath = 'skills/tmux-team/SKILL.md';
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
