import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { E2EFixture, withE2EFixture } from './harness.js';

describe.sequential('Docker/Vitest tmux foundation smoke scenarios', () => {
  it('propagates real CLI stdout, stderr, and exit codes', async () => {
    await withE2EFixture(async (fixture) => {
      const version = await fixture.runCli(['--version']);
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

      const help = await fixture.runCli(['--help']);
      expect(help.code).toBe(0);
      expect(help.stdout.toLowerCase()).toContain('tmux-team');

      const invalid = await fixture.runCli(['definitely-not-a-command']);
      expect(invalid.code).not.toBe(0);
      expect(invalid.stderr.toLowerCase()).toContain('unknown command');
    });
  });

  it('transports deterministic mock-agent input/output through real tmux', async () => {
    await withE2EFixture(async (fixture) => {
      expect(fixture.serverIsRunning()).toBe(true);
      expect(fixture.tmux(['list-panes', '-a']).trim()).toContain(fixture.pane);

      const nonce = 'foundation123';
      fixture.sendMockInput([
        'hello from the foundation',
        '',
        `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`,
      ]);
      const output = await fixture.waitForCapture(
        (capture) =>
          capture.includes('mock-agent response: hello from the foundation') &&
          capture.includes(`RESPONSE-END-${nonce}`)
      );
      await fixture.waitForEvent((event) => event.event === 'response' && event.nonce === nonce);

      const events = fixture.events();
      expect(events[0]).toEqual({
        event: 'ready',
        mode: 'respond',
        pid: fixture.panePid,
      });
      expect(events).toContainEqual({
        event: 'request',
        message: 'hello from the foundation',
        nonce,
        mode: 'respond',
      });
      expect(events).toContainEqual({
        event: 'response',
        message: 'hello from the foundation',
        nonce,
        mode: 'respond',
      });
      expect(output).toContain('mock-agent response: hello from the foundation');
    });
  });

  it('records a silent mock-agent lifecycle without fabricating a response', async () => {
    await withE2EFixture(
      async (fixture) => {
        const nonce = 'silent123';
        fixture.sendMockInput([
          'silent request',
          '',
          `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`,
        ]);
        await fixture.waitForEvent((event) => event.event === 'silent' && event.nonce === nonce);

        const events = fixture.events();
        expect(events.map((event) => event.event)).toEqual(['ready', 'request', 'silent']);
        expect(fixture.capture()).not.toContain('mock-agent response: silent request');
      },
      { mode: 'silent' }
    );
  });

  it('records malformed output separately from a valid response', async () => {
    await withE2EFixture(
      async (fixture) => {
        const nonce = 'malformed123';
        fixture.sendMockInput([
          'malformed request',
          '',
          `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`,
        ]);
        const output = await fixture.waitForCapture((capture) =>
          capture.includes('mock-agent malformed response: malformed request')
        );
        await fixture.waitForEvent((event) => event.event === 'malformed' && event.nonce === nonce);

        const events = fixture.events();
        expect(events.map((event) => event.event)).toEqual(['ready', 'request', 'malformed']);
        expect(output).not.toContain(`RESPONSE-END-${nonce}`);
      },
      { mode: 'malformed' }
    );
  });

  it('keeps the canonical pane ID across a real tmux move', async () => {
    await withE2EFixture((fixture) => {
      const originalPane = fixture.pane;
      const originalTarget = fixture.paneTarget(originalPane);
      const targetPane = fixture
        .tmux(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'e2e', '-n', 'sink', 'sleep 30'])
        .trim();
      const targetWindow = fixture.paneTarget(targetPane);
      fixture.tmux(['move-pane', '-s', originalPane, '-t', targetPane]);

      expect(fixture.pane).toBe(originalPane);
      expect(fixture.paneTarget(originalPane)).not.toBe(originalTarget);
      expect(fixture.paneTarget(originalPane)).toContain(targetWindow.split('.')[0]);
      expect(fixture.tmux(['list-panes', '-a', '-F', '#{pane_id}']).trim()).toContain(originalPane);
    });
  });

  it('cleans the private server and files after a thrown scenario error', async () => {
    let failedFixture: E2EFixture | undefined;
    await expect(
      withE2EFixture((fixture) => {
        failedFixture = fixture;
        throw new Error('simulated scenario failure');
      })
    ).rejects.toThrow('simulated scenario failure');

    expect(failedFixture).toBeDefined();
    expect(failedFixture?.serverIsRunning()).toBe(false);
    expect(failedFixture?.mockProcessIsRunning()).toBe(false);
    expect(fs.existsSync(failedFixture?.socketPath ?? '')).toBe(false);
    expect(fs.existsSync(failedFixture?.root ?? '')).toBe(false);
    expect(fs.existsSync(failedFixture?.socketRoot ?? '')).toBe(false);

    let secondFixture: E2EFixture | undefined;
    await withE2EFixture((fixture) => {
      secondFixture = fixture;
      expect(fixture.serverIsRunning()).toBe(true);
      expect(fixture.socket).not.toBe(failedFixture?.socket);
      expect(fixture.root).not.toBe(failedFixture?.root);
    });
    expect(secondFixture?.serverIsRunning()).toBe(false);
    expect(secondFixture?.mockProcessIsRunning()).toBe(false);
  });
});
