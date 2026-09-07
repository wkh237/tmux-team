import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runPackedCommand } from './packed-command.mjs';

// Resource measurement is deliberately macOS-only. Docker scenarios own tmux
// latency; do not compare these resource samples to Linux timing samples.
assert.equal(process.platform, 'darwin', 'This resource probe requires macOS /usr/bin/time.');
assert.equal(process.argv.length, 2, 'This probe does not accept arguments.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-startup-baseline-'));
const samples = [];
try {
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const forbidden = path.join(root, 'unexpected-tmux');
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ntouch "$TMT_BENCH_FORBIDDEN"\nexit 97\n', {
    mode: 0o755,
  });
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    LC_ALL: 'C',
    TMUX_TEAM_HOME: path.join(home, 'global'),
    TMT_BENCH_FORBIDDEN: forbidden,
    TMT_BENCH_METRICS: path.join(root, 'metrics'),
    TMT_BENCH_STDERR: path.join(root, 'stderr'),
  };
  const measure = (scenario, args, verify) => {
    const started = performance.now();
    // Fixed shell program; all command arguments remain positional data. Keep
    // CLI diagnostics separate from time's stderr so neither masks the other.
    const stdout = runPackedCommand(
      '/bin/sh',
      [
        '-c',
        '/usr/bin/time -lp /bin/sh -c \'exec "$@" 2> "$TMT_BENCH_STDERR"\' bench "$@" 2> "$TMT_BENCH_METRICS"',
        'bench',
        path.join(repo, 'bin/tmux-team'),
        ...args,
      ],
      { cwd: root, env }
    );
    const wallMs = performance.now() - started;
    assert.equal(fs.readFileSync(env.TMT_BENCH_STDERR, 'utf8'), '');
    verify(stdout);
    const metrics = fs.readFileSync(env.TMT_BENCH_METRICS, 'utf8');
    const value = (pattern) => {
      const matches = [...metrics.matchAll(pattern)];
      assert.equal(matches.length, 1, `Missing or ambiguous resource metric: ${metrics}`);
      const number = Number(matches[0][1]);
      assert.ok(Number.isFinite(number) && number >= 0);
      return number;
    };
    samples.push({
      scenario,
      wallMs,
      userSeconds: value(/^user\s+(\d+(?:\.\d+)?)$/gm),
      systemSeconds: value(/^sys\s+(\d+(?:\.\d+)?)$/gm),
      maximumResidentSetBytes: value(/^\s*(\d+)\s+maximum resident set size$/gm),
    });
    assert.equal(fs.existsSync(forbidden), false, 'Storage/startup invoked tmux.');
  };
  for (let index = 0; index < 7; index += 1) {
    measure('help', ['--help'], (stdout) => assert.match(stdout, /TALK OPTIONS/));
    env.TMUX_TEAM_HOME = path.join(home, `fresh-${index}`);
    measure('fresh-storage-create', ['--json', 'identity', 'create', 'Bench'], (stdout) => {
      assert.equal(JSON.parse(stdout).created, true);
    });
    measure('existing-storage-show', ['--json', 'identity', 'show', 'Bench'], (stdout) => {
      assert.equal(JSON.parse(stdout).identity.name, 'Bench');
    });
  }
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      kernel: os.release(),
      node: process.version,
      cpu: os.cpus()[0]?.model,
      tool: '/usr/bin/time -lp',
      samples,
      interpretation:
        'Fresh processes, not dropped OS caches. CPU includes waited descendants; maximum RSS is not the sum of simultaneously live processes. Timing includes measurement wrappers. No tmux or agent work is measured.',
    })
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
}
