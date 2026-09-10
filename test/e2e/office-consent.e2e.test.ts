import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withE2EFixture } from './harness.js';
import { spawnRealTmuxCli } from './real-tmux-caller.js';

describe('optional Office consent on a real terminal', () => {
  it.each(['', 'n', 'no'])(
    'declines installation with %j without creating an installation',
    async (answer) => {
      await withE2EFixture(async (fixture) => {
        const prefix = path.join(fixture.root, 'optional office');
        const process = await spawnRealTmuxCli(fixture, ['office', '--prefix', prefix], {
          name: 'office-consent',
          json: false,
          terminal: true,
        });
        fs.writeFileSync(process.releasePath, 'run');
        await fixture.waitForCapture((text) => text.includes('[y/N]'), process.pane);
        expect(fs.existsSync(process.exitPath)).toBe(false);
        expect(fs.existsSync(prefix)).toBe(false);
        if (answer) fixture.tmux(['send-keys', '-t', process.pane, '-l', answer]);
        fixture.tmux(['send-keys', '-t', process.pane, 'Enter']);
        await fixture.waitFor(
          () =>
            fs.existsSync(process.exitPath) && fs.readFileSync(process.exitPath, 'utf8') === '0',
          5_000,
          'declined Office exit'
        );
        expect(fs.existsSync(prefix)).toBe(false);
        const status = await fixture.runJsonCli(['office', '--prefix', prefix, 'status']);
        expect(status.code).toBe(1);
        expect(status.json).toMatchObject({ error: { code: 'OFFICE_NOT_INSTALLED' } });
      });
    }
  );
});
