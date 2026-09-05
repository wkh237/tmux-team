import { describe, expect, it, vi } from 'vitest';
import { createCliOutput, CliOutputSerializationError } from './cli-output.js';

describe('CLI JSON output boundary', () => {
  it('publishes at most one document and exposes duplicate writes', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      output.setJson({ ok: true });
      output.setJson({ second: true });

      expect(output.hasDuplicateJson()).toBe(true);
      output.replaceJson({ error: { code: 'INTERNAL_ERROR', message: 'duplicate' } });
      output.flush();
      output.flush();
      expect(writeSpy).toHaveBeenCalledOnce();
      expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'duplicate' },
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not publish an unserializable result', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      output.setJson(1n);

      expect(() => output.flush()).toThrow(CliOutputSerializationError);
      expect(writeSpy).not.toHaveBeenCalled();
      output.replaceJson({ error: { code: 'INTERNAL_ERROR', message: 'serialize failed' } });
      output.flush();
      expect(writeSpy).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it.each(['undefined', 'circular'])('rejects %s before writing bytes', (kind) => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      if (kind === 'undefined') {
        output.setJson(undefined);
      } else {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        output.setJson(circular);
      }

      expect(() => output.flush()).toThrow(CliOutputSerializationError);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not retry a stdout write failure', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('broken pipe');
    });
    try {
      const output = createCliOutput(true);
      output.setJson({ ok: true });
      expect(() => output.flush()).toThrow('broken pipe');
      expect(writeSpy).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
