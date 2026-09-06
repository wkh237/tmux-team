import fs from 'node:fs';

const [readyFile] = process.argv.slice(2);
if (!readyFile) throw new Error('Missing readiness file.');

process.on('SIGTERM', () => undefined);
fs.writeFileSync(readyFile, 'ready');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
