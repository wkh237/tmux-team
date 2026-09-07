import { describe, expect, it } from 'vitest';
import { PaneMetadataError } from './pane-metadata-error.js';

describe('pane metadata failure diagnostics', () => {
  it.each([
    [{ code: 'EPERM' }, ' (EPERM)'],
    [{ code: 'EACCES' }, ' (EACCES)'],
    [{ status: 1 }, ' (tmux exit 1)'],
    [{ signal: 'SIGKILL' }, ' (SIGKILL)'],
    [{ code: 'private payload', status: -1 }, ''],
  ])('exposes only safe failure classification for %j', (fields, suffix) => {
    const cause = Object.assign(new Error('private argv and metadata'), fields, {
      stderr: 'private subprocess output',
    });
    const error = new PaneMetadataError('write', { cause });
    expect(error.message).toBe(`Could not write pane metadata${suffix}.`);
    expect(error.stage).toBe('write');
    expect(error.cause).toBe(cause);
  });

  it('reports read stage without relying on an arbitrary cause', () => {
    expect(new PaneMetadataError('read', { cause: 'private text' }).message).toBe(
      'Could not read pane metadata.'
    );
  });
});
