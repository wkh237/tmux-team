// ─────────────────────────────────────────────────────────────
// UI utilities - colors, logging, output formatting
// ─────────────────────────────────────────────────────────────

import type { UI } from './types.js';

const isTTY = process.stdout.isTTY;

// Strip ANSI escape codes for accurate length calculation
const ansiEscape = String.fromCharCode(27);
const stripAnsi = (s: string) => s.replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, 'g'), '');

export const colors = {
  red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

export function createUI(jsonMode: boolean): UI {
  if (jsonMode) {
    // In JSON mode, suppress all human-friendly output
    return {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: (msg: string) => {
        console.error(JSON.stringify({ error: msg }));
      },
      table: () => {},
      json: (data: unknown) => {
        console.log(JSON.stringify(data, null, 2));
      },
    };
  }

  return {
    info: (msg: string) => {
      console.log(`${colors.blue('ℹ')} ${msg}`);
    },
    success: (msg: string) => {
      console.log(`${colors.green('✓')} ${msg}`);
    },
    warn: (msg: string) => {
      console.log(`${colors.yellow('⚠')} ${msg}`);
    },
    error: (msg: string) => {
      console.error(`${colors.red('✗')} ${msg}`);
    },
    table: (headers: string[], rows: string[][]) => {
      // Calculate column widths (strip ANSI codes for accurate length)
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] || '').length))
      );

      // Print header
      console.log('  ' + headers.map((h, i) => colors.yellow(h.padEnd(widths[i]))).join(' '));
      console.log('  ' + widths.map((w) => '─'.repeat(w)).join(' '));

      // Print rows (pad based on visible length, not byte length)
      for (const row of rows) {
        const cells = row.map((c, i) => {
          const cell = c || '-';
          const visibleLen = stripAnsi(cell).length;
          const padding = ' '.repeat(Math.max(0, widths[i] - visibleLen));
          return cell + padding;
        });
        console.log('  ' + cells.join(' '));
      }
    },
    json: (data: unknown) => {
      console.log(JSON.stringify(data, null, 2));
    },
  };
}
