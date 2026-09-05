import { describe, expect, it, vi } from 'vitest';
import { createCliOutput, CliOutputSerializationError } from './cli-output.js';

describe('CLI JSON output boundary', () => {
  it('preserves only bounded correlation when replacing a pending result with failure', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      const getter = vi.fn(() => {
        throw new Error('must not evaluate');
      });
      const pending = {
        status: 'completed',
        requestId: 'req-one',
        target: 'Alice',
        pane: '%14',
        response: 'private full body',
        receipt: 'private receipt',
        endpoint: { secret: true },
      };
      Object.defineProperty(pending, 'unused', { get: getter });
      output.setJson(pending);
      output.replaceFailure({ code: 'CLEANUP_ERROR', message: 'Inspect the request.' });
      output.flush();
      expect(write).toHaveBeenCalledOnce();
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
        requestId: 'req-one',
        target: 'Alice',
        pane: '%14',
        error: { code: 'CLEANUP_ERROR', message: 'Inspect the request.' },
      });
      expect(getter).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    { requestId: 'x'.repeat(257), target: 'Alice', pane: '%14' },
    { requestId: 12, target: 'Alice', pane: '%14' },
    Object.defineProperty({}, 'requestId', {
      get() {
        throw new Error('unexpected getter');
      },
    }),
  ])('does not promote invalid correlation fields from an arbitrary result', (pending) => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      output.setJson(pending);
      output.replaceFailure({ code: 'ERROR', message: 'failed' });
      output.flush();
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
        error: { code: 'ERROR', message: 'failed' },
      });
    } finally {
      write.mockRestore();
    }
  });

  it('omits invalid target/pane fields without losing a valid request ID', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const output = createCliOutput(true);
      output.setJson({ requestId: 'req-one', target: 'x'.repeat(257), pane: '10.3' });
      output.replaceFailure({ code: 'ERROR', message: 'failed' });
      output.flush();
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
        requestId: 'req-one',
        error: { code: 'ERROR', message: 'failed' },
      });
    } finally {
      write.mockRestore();
    }
  });

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
