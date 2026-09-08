#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { generateNativeBootstrap } from './native-bootstrap.mjs';

const { values } = parseArgs({
  options: { manifest: { type: 'string' }, 'archive-dir': { type: 'string' } },
});
assert(
  values.manifest && values['archive-dir'],
  'Usage: --manifest <file> --archive-dir <directory>'
);
process.stdout.write(await generateNativeBootstrap(values.manifest, values['archive-dir']));
