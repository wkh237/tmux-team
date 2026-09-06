import { describe, expect, it } from 'vitest';
import { buildDurableReplyInstruction } from './talk-instruction.js';

describe('durable reply instruction', () => {
  it('uses concise HTML-style framing and includes the receipt exactly once', () => {
    const receipt = 'receipt-token';
    const instruction = buildDurableReplyInstruction('request-1', receipt);
    const lines = instruction.split('\n');

    expect(lines.slice(0, 3)).toEqual([
      '<tmt-reply>',
      'tmt reply request-1 --receipt receipt-token --message <text>',
      '</tmt-reply>',
    ]);
    expect(lines[3]).toContain('Submit your response with the command above.');
    expect(lines[3]).toContain('Chat output alone does not complete the request.');
    expect(lines[3]).toContain('After successful submission, show a brief summary;');
    expect(lines[3]).toContain('report submission errors.');
    expect(instruction.match(new RegExp(receipt, 'g'))).toHaveLength(1);
    expect(instruction).not.toContain('!');
    expect(instruction.length - receipt.length).toBeLessThan(300);
    const longReceipt = 'a'.repeat(8192);
    expect(buildDurableReplyInstruction('request-1', longReceipt).length).toBe(
      instruction.length - receipt.length + longReceipt.length
    );
  });
});
