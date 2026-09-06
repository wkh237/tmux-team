import { describe, expect, it } from 'vitest';
import { decodeStrictUtf8 } from './strict-utf8.js';

describe('strict UTF-8 decoding', () => {
  it.each([
    [new Uint8Array(), ''],
    [new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), '\ufeffA'],
    [new Uint8Array([0x00, 0x0d, 0x0a, 0x41]), '\u0000\r\nA'],
    // Emoji exercises a four-byte UTF-8 sequence without normalization.
    [new Uint8Array([0xf0, 0x9f, 0x98, 0x80]), '😀'],
  ])('decodes valid bytes exactly', (bytes, expected) => {
    expect(decodeStrictUtf8(bytes)).toBe(expected);
  });

  it.each([
    new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xe2, 0x82]),
    new Uint8Array([0xf0, 0x9f, 0x98]),
  ])('rejects malformed or truncated UTF-8', (bytes) => {
    expect(() => decodeStrictUtf8(bytes)).toThrow();
  });

  it('does not retain malformed decoder state across invocations', () => {
    expect(() => decodeStrictUtf8(new Uint8Array([0xe2, 0x82]))).toThrow();
    expect(decodeStrictUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('\ufeffA');
  });
});
