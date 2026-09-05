import { describe, expect, it } from 'vitest';
import { normalizePreambleContent, PreambleContentError } from './preamble.js';

describe('preamble content input', () => {
  it('normalizes line endings, strips one BOM, and preserves meaningful whitespace', () => {
    expect(normalizePreambleContent('\ufeff\ufeff\t one\r\ntwo\r\n')).toBe('\ufeff\t one\ntwo\n');
  });

  it('rejects blank, control, and malformed Unicode content', () => {
    for (const value of [' \n\t\r', 'bad\u0000', 'bad\u007f', 'bad\ud800', 'bad\udc00']) {
      expect(() => normalizePreambleContent(value)).toThrowError(
        expect.objectContaining({ code: 'PREAMBLE_INPUT_INVALID' })
      );
    }
    expect(() => normalizePreambleContent('bad\u0000')).toThrowError(PreambleContentError);
    expect(normalizePreambleContent('valid 😀 content')).toBe('valid 😀 content');
  });

  it('enforces the raw UTF-8 byte limit before normalization', () => {
    expect(normalizePreambleContent('a'.repeat(65_536))).toHaveLength(65_536);
    expect(() => normalizePreambleContent('a'.repeat(65_537))).toThrowError(
      expect.objectContaining({ code: 'PREAMBLE_INPUT_TOO_LARGE' })
    );
    expect(() => normalizePreambleContent(`${'a'.repeat(65_535)}\r\n`)).toThrowError(
      expect.objectContaining({ code: 'PREAMBLE_INPUT_TOO_LARGE' })
    );

    const multibyte = '😀'.repeat(16_384);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(65_536);
    expect(normalizePreambleContent(multibyte)).toBe(multibyte);
    expect(() => normalizePreambleContent(`${multibyte}😀`)).toThrowError(
      expect.objectContaining({ code: 'PREAMBLE_INPUT_TOO_LARGE' })
    );
  });
});
