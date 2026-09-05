import { MAX_RESPONSE_BYTES } from './domain/response.js';

/**
 * Build the only recipient-side framing used by durable talk. The fenced block
 * ends the request instructions, not the recipient response; completion is
 * accepted only by the public reply command and durable request service.
 */
export function buildDurableReplyInstruction(requestId: string, receipt: string): string {
  return [
    '[TMT-DURABLE-REPLY v1 BEGIN]',
    '',
    `request-id=${requestId}`,
    `receipt=${receipt}`,
    `body-limit-bytes=${MAX_RESPONSE_BYTES}`,
    `stdin-command=tmt reply ${requestId} --receipt ${receipt} --stdin`,
    `file-command=tmt reply ${requestId} --receipt ${receipt} --file <path>`,
    'body-rules=strict-utf8;preserve-empty-whitespace-bom-nul-crlf-unicode;complete-body',
    'summary-after=accepted',
    '',
    'Submit the complete final response with exactly one command above. Stdin input must reach EOF within five seconds.',
    'The receipt is local correlation, not authentication. Successful submission means the response was delivered, not that the task succeeded.',
    'After accepted submission, provide a short truthful summary of work, tests, and blockers.',
    'Surface submission failure without a success summary. If summary generation fails after acceptance, do not resubmit.',
    'Identical retries are safe only with the same receipt and body while the result is retained for seven days.',
    '[TMT-DURABLE-REPLY v1 END]',
  ].join('\n');
}
