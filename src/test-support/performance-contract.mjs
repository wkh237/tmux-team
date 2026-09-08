import assert from 'node:assert/strict';

// Measurement evidence requires the public command inventory, not a particular
// renderer's section heading. This is an independent test oracle, not CLI grammar.
export function assertBenchmarkHelp(stdout) {
  for (const command of ['talk', 'reply', 'result', 'identity', 'config']) {
    assert.match(stdout, new RegExp(`^  ${command}\\s`, 'm'), `Missing help command: ${command}`);
  }
}
