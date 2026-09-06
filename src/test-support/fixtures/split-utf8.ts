import fs from 'node:fs';
import path from 'node:path';
import { waitForBarrier } from '../workers/barrier.js';

const [barrierDirectory] = process.argv.slice(2);
if (!barrierDirectory) throw new Error('Missing barrier directory.');

const body = Buffer.from('{"message":"😀"}\n', 'utf8');
const emojiStart = body.indexOf(Buffer.from('😀', 'utf8'));
process.stdout.write(body.subarray(0, emojiStart + 1));
fs.writeFileSync(path.join(barrierDirectory, 'first-byte-written'), 'ready');
waitForBarrier(path.join(barrierDirectory, 'go'), 5_000);
process.stdout.write(body.subarray(emojiStart + 1));
