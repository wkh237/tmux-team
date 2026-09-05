#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.env.TMT_MOCK_MODE ?? 'respond';
const delayMs = Number(process.env.TMT_MOCK_DELAY_MS ?? 0);
const logPath = process.env.TMT_MOCK_LOG;
const virtualizedLineCount = 200;

function appendEvent(event) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function respond(message, nonce) {
  if (mode === 'virtualized') {
    const responseLines = [
      `VIRTUALIZED-BEGIN:${message}`,
      ...Array.from(
        { length: virtualizedLineCount },
        (_, index) => `VIRTUALIZED-LINE-${String(index + 1).padStart(3, '0')}:${message}`
      ),
      `VIRTUALIZED-END:${message}`,
    ];
    const response = responseLines.join('\n');
    const visibleLines = responseLines.slice(-3).join('\n');
    // The virtualized response replaces the terminal surface before rendering its
    // short tail. The full plain-text body remains available only in the event log.
    const output = `\u001b[2J\u001b[3J\u001b[H${visibleLines}\nRESPONSE-END-${nonce}\n`;
    process.stdout.write(output, () =>
      appendEvent({
        event: 'response',
        message,
        nonce,
        mode,
        pid: process.pid,
        response,
        responseLength: response.length,
      })
    );
    return;
  }
  const output = `mock-agent response: ${message || '(empty)'}\nRESPONSE-END-${nonce}\n`;
  process.stdout.write(output, () =>
    appendEvent({ event: 'response', message, nonce, mode, pid: process.pid })
  );
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let messageLines = [];

appendEvent({ event: 'ready', mode, pid: process.pid });

input.on('line', (line) => {
  const instruction = line.match(
    /^When done, output exactly: RESPONSE-END-xxxx \(where xxxx = ([A-Za-z0-9]+)\)$/
  );
  if (!instruction) {
    if (line.length > 0) messageLines.push(line);
    return;
  }

  const nonce = instruction[1];
  const message = messageLines.join('\n').trim();
  messageLines = [];
  appendEvent({ event: 'request', message, nonce, mode, pid: process.pid });

  if (mode === 'silent') {
    appendEvent({ event: 'silent', message, nonce, mode, pid: process.pid });
    return;
  }
  const send = () => respond(message, nonce);
  if (mode === 'malformed') {
    setTimeout(
      () =>
        process.stdout.write(`mock-agent malformed response: ${message}\n`, () =>
          appendEvent({ event: 'malformed', message, nonce, mode, pid: process.pid })
        ),
      delayMs
    );
    return;
  }
  setTimeout(send, delayMs);
});

input.on('close', () => appendEvent({ event: 'stopped', pid: process.pid }));
