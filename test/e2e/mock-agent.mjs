#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.env.TMT_MOCK_MODE ?? 'respond';
const delayMs = Number(process.env.TMT_MOCK_DELAY_MS ?? 0);
const logPath = process.env.TMT_MOCK_LOG;

function appendEvent(event) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function respond(message, nonce) {
  const output = `mock-agent response: ${message || '(empty)'}\nRESPONSE-END-${nonce}\n`;
  process.stdout.write(output);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let messageLines = [];

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
  appendEvent({ event: 'request', message, nonce, mode });

  if (mode === 'silent') return;
  const send = () => respond(message, nonce);
  if (mode === 'malformed') {
    setTimeout(() => process.stdout.write(`mock-agent malformed response: ${message}\n`), delayMs);
    return;
  }
  setTimeout(send, delayMs);
});

input.on('close', () => appendEvent({ event: 'stopped' }));
