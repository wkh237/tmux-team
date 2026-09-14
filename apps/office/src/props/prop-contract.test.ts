import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import builtinDocument from '../../../../contracts/office/builtin-props-v1.tmtprop.json' with { type: 'json' };
import { BUILTIN_DIGEST, BUILTIN_PACK, decodePropPack, indexedProp } from './prop-contract.js';

describe('data-only prop pack contract', () => {
  it('independently accepts the frozen built-in pack', () => {
    const bytes = readFileSync(
      path.resolve(process.cwd(), '../../contracts/office/builtin-props-v1.tmtprop.json')
    );
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    const digest = createHash('sha256')
      .update(Buffer.from('TMT-OFFICE-PROP-PACK-V1\0'))
      .update(length)
      .update(bytes)
      .digest('hex');
    expect(`sha256:${digest}`).toBe(BUILTIN_DIGEST);
    expect(decodePropPack(builtinDocument)).toEqual(BUILTIN_PACK);
    expect(indexedProp(BUILTIN_PACK, 'desk')?.footprint).toEqual({ width: 4, height: 2 });
  });

  it('rejects executable-looking fields and unknown palette indexes', () => {
    expect(() => decodePropPack({ ...builtinDocument, script: 'throw 1' })).toThrow();
    const invalid = structuredClone(builtinDocument);
    invalid.props[0]!.pixels[0] = 'f'.repeat(invalid.props[0]!.pixels[0]!.length);
    expect(() => decodePropPack(invalid)).toThrow('Invalid prop pixels.');
  });
});
