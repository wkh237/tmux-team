// ─────────────────────────────────────────────────────────────
// Tmux Wrapper Tests - send-keys, capture-pane
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { createTmux } from './tmux.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe('createTmux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('calls tmux send-keys with pane ID and message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello world');

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t "1.0" "Hello world"',
        expect.any(Object)
      );
    });

    it('sends Enter key after message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello');

      expect(mockedExecSync).toHaveBeenCalledTimes(2);
      expect(mockedExecSync).toHaveBeenNthCalledWith(
        2,
        'tmux send-keys -t "1.0" Enter',
        expect.any(Object)
      );
    });

    it('escapes special characters in message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello "world" with \'quotes\'');

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('"Hello \\"world\\" with \'quotes\'"'),
        expect.any(Object)
      );
    });

    it('handles newlines in message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Line 1\nLine 2');

      // JSON.stringify escapes newlines as \n
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('"Line 1\\nLine 2"'),
        expect.any(Object)
      );
    });

    it('throws when pane does not exist', () => {
      const error = new Error("can't find pane: 99.99");
      mockedExecSync.mockImplementationOnce(() => {
        throw error;
      });

      const tmux = createTmux();

      expect(() => tmux.send('99.99', 'Hello')).toThrow("can't find pane: 99.99");
    });

    it('uses pipe stdio to suppress output', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello');

      expect(mockedExecSync).toHaveBeenCalledWith(expect.any(String), { stdio: 'pipe' });
    });
  });

  describe('capture', () => {
    it('calls tmux capture-pane with pane ID and line count', () => {
      mockedExecSync.mockReturnValue('captured output');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t "1.0" -p -S -100',
        expect.any(Object)
      );
    });

    it('returns captured pane content', () => {
      const expectedOutput = 'Line 1\nLine 2\nLine 3';
      mockedExecSync.mockReturnValue(expectedOutput);
      const tmux = createTmux();

      const result = tmux.capture('1.0', 50);

      expect(result).toBe(expectedOutput);
    });

    it('captures specified number of lines', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('2.1', 200);

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t "2.1" -p -S -200',
        expect.any(Object)
      );
    });

    it('throws when pane does not exist', () => {
      const error = new Error("can't find pane: 99.99");
      mockedExecSync.mockImplementationOnce(() => {
        throw error;
      });

      const tmux = createTmux();

      expect(() => tmux.capture('99.99', 100)).toThrow("can't find pane: 99.99");
    });

    it('uses utf-8 encoding for output', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('uses pipe stdio for all streams', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
    });
  });

  describe('pane ID handling', () => {
    it('accepts window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('1.2', 'Hello');
      tmux.capture('1.2', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-t "1.2"'),
        expect.any(Object)
      );
    });

    it('accepts session:window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('main:1.2', 'Hello');
      tmux.capture('main:1.2', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-t "main:1.2"'),
        expect.any(Object)
      );
    });

    it('quotes pane ID to prevent shell injection', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      // Malicious pane ID attempt
      tmux.send('1.0; rm -rf /', 'Hello');

      // Should be quoted and treated as literal string
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t "1.0; rm -rf /" "Hello"',
        expect.any(Object)
      );
    });
  });
});
