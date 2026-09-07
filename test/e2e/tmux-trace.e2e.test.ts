import { describe, expect, it } from 'vitest';
import { withE2EFixture } from './harness.js';
import { installTmuxTrace } from './tmux-trace.js';

describe.sequential('tmux invocation trace', () => {
  it('normalizes multiline logged arguments without changing tmux payloads', async () => {
    await withE2EFixture(async (fixture) => {
      const trace = installTmuxTrace(fixture);
      const bufferName = `trace-baseline-${process.pid}`;
      const payload = 'first line\nsecond line\n<html>request body</html>';

      try {
        trace.clear();
        fixture.tmux(['set-buffer', '-b', bufferName, '--', payload]);

        const invocations = trace.invocations();
        expect(invocations).toHaveLength(1);
        expect(trace.commands()).toEqual(['set-buffer']);
        expect(invocations[0]).toContain('first line second line');
        expect(invocations[0]).not.toContain('\n');

        const saved = fixture.tmux(['save-buffer', '-b', bufferName, '-']);
        expect(saved).toBe(payload);
      } finally {
        try {
          fixture.tmux(['delete-buffer', '-b', bufferName]);
        } catch {
          // The fixture server still owns cleanup if set-buffer failed early.
        }
      }

      expect(fixture.tmux(['list-buffers', '-F', '#{buffer_name}'])).not.toContain(bufferName);
    });
  });
});
