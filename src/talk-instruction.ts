/**
 * Build the only recipient-side framing used by durable talk. The HTML-style
 * grouping ends the request instructions, not the recipient response; completion is
 * accepted only by the public reply command and durable request service.
 */
export function buildDurableReplyInstruction(requestId: string, receipt: string): string {
  return [
    '<tmt-reply>',
    `tmt reply ${requestId} --receipt ${receipt} --message <text>`,
    '</tmt-reply>',
    'Submit your response with the command above. Chat output alone does not complete the request. After successful submission, show a brief summary; report submission errors.',
  ].join('\n');
}
