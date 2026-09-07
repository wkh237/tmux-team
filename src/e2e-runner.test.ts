import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSandbox, runCli } from './test-support/cli-process.js';

describe('Docker wrapper executable forwarding', () => {
  it.each(['unset', 'selected', 'failed container'])(
    'preserves argv, isolation and image cleanup with %s settings',
    async (mode) => {
      const sandbox = createSandbox({
        TMT_TEST_CLI: JSON.stringify({
          executable: process.execPath,
          args: [fileURLToPath(new URL('../scripts/run-e2e.mjs', import.meta.url))],
        }),
      });
      try {
        const bin = path.join(sandbox.root, 'fake docker');
        fs.mkdirSync(bin);
        const log = path.join(sandbox.root, 'docker.jsonl');
        fs.writeFileSync(
          path.join(bin, 'docker'),
          `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMT_RUNNER_LOG, JSON.stringify(args) + '\\n');
process.exitCode = args[0] === 'run' ? Number(process.env.TMT_RUNNER_STATUS) : 0;
`,
          { mode: 0o755 }
        );
        sandbox.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
        sandbox.env.TMT_RUNNER_LOG = log;
        const status = mode === 'failed container' ? 23 : 0;
        sandbox.env.TMT_RUNNER_STATUS = String(status);
        delete sandbox.env.TMT_TEST_CLI;
        delete sandbox.env.TMT_TEST_PEER_CLI;
        const primary = JSON.stringify({
          executable: "/container/CLI's path",
          args: ['prefix with spaces', '$HOME; quoted'],
        });
        const peer = JSON.stringify({ executable: '/container/peer', args: [] });
        if (mode !== 'unset') {
          sandbox.env.TMT_TEST_CLI = primary;
          sandbox.env.TMT_TEST_PEER_CLI = peer;
        }
        expect(await runCli(sandbox, [])).toEqual({ status, signal: null, stdout: '', stderr: '' });
        const calls = fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(calls).toHaveLength(3);
        expect(calls[0].slice(0, 2)).toEqual(['build', '--tag']);
        const image = calls[0][2];
        expect(calls[1]).toEqual([
          'run',
          '--rm',
          '--init',
          '--network',
          'none',
          ...(mode === 'unset'
            ? []
            : ['--env', `TMT_TEST_CLI=${primary}`, '--env', `TMT_TEST_PEER_CLI=${peer}`]),
          image,
        ]);
        expect(calls[2]).toEqual(['image', 'rm', '--force', image]);
      } finally {
        fs.rmSync(sandbox.root, { recursive: true, force: true });
      }
    },
    10_000
  );
});
