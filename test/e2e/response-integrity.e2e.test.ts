import { describe, expect, it } from 'vitest';
import { withE2EFixture } from './harness.js';

interface TalkResult {
  nonce: string;
  pane: string;
  response: string;
  status: string;
  truncated: boolean;
}

interface CheckResult {
  output: string;
}

function expectedVirtualizedResponse(token: string): string {
  return [
    `VIRTUALIZED-BEGIN:${token}`,
    ...Array.from(
      { length: 200 },
      (_, index) => `VIRTUALIZED-LINE-${String(index + 1).padStart(3, '0')}:${token}`
    ),
    `VIRTUALIZED-END:${token}`,
  ].join('\n');
}

describe.sequential('TMT-35 response-channel research characterization', () => {
  it('shows that terminal capture cannot recover a virtualized full response', async () => {
    // This is deliberately a research characterization of the current terminal-source
    // limitation, not a complete-response acceptance test. A future structured-channel
    // test must assert this exact full body and durable request correlation before delivery.
    await withE2EFixture(
      async (fixture) => {
        const peer = await fixture.createMockPane('virtualized-agent');
        const binding = await fixture.runJsonCli(['add', peer.pane, 'Virtualized']);
        expect(binding.code).toBe(0);

        const token = 'tmt35-virtualized-response';
        const expectedResponse = expectedVirtualizedResponse(token);
        const talk = await fixture.runJsonCli<TalkResult>([
          'talk',
          'Virtualized',
          token,
          '--no-preamble',
          '--wait',
          '--timeout',
          '8',
        ]);

        expect(talk.code).toBe(0);
        expect(talk.json).toMatchObject({ status: 'completed', truncated: true });
        expect(talk.json?.pane).toBe(peer.pane);
        expect(talk.json?.nonce).toMatch(/^[a-f0-9]+$/);
        expect(talk.json?.response).toContain(`VIRTUALIZED-END:${token}`);
        expect(talk.json?.response).not.toContain(`VIRTUALIZED-LINE-100:${token}`);

        const requestEvent = await fixture.waitForEvent(
          (event) =>
            event.event === 'request' && event.pid === peer.pid && event.nonce === talk.json?.nonce
        );
        expect(requestEvent).toMatchObject({
          message: token,
          mode: 'virtualized',
          nonce: talk.json?.nonce,
          pid: peer.pid,
        });
        const responseEvent = await fixture.waitForEvent(
          (event) =>
            event.event === 'response' && event.pid === peer.pid && event.nonce === talk.json?.nonce
        );
        expect(responseEvent.message).toBe(token);
        expect(responseEvent.response).toBe(expectedResponse);
        expect(responseEvent.responseLength).toBe(expectedResponse.length);
        expect(responseEvent.response).toContain(`VIRTUALIZED-LINE-100:${token}`);

        const capturedAtDefault = await fixture.runJsonCli<CheckResult>([
          'check',
          'Virtualized',
          '100',
        ]);
        const capturedAtMax = await fixture.runJsonCli<CheckResult>([
          'check',
          'Virtualized',
          '2000',
        ]);
        for (const captured of [capturedAtDefault, capturedAtMax]) {
          expect(captured.code).toBe(0);
          expect(captured.json?.output).toContain(`VIRTUALIZED-END:${token}`);
          expect(captured.json?.output).not.toContain(`VIRTUALIZED-LINE-100:${token}`);
        }
      },
      { mode: 'virtualized' }
    );
  }, 15_000);
});
