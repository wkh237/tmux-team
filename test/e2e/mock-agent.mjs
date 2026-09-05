#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const mode = process.env.TMT_MOCK_MODE ?? 'respond';
const delayMs = Number(process.env.TMT_MOCK_DELAY_MS ?? 0);
const replyDelayMs = Number(process.env.TMT_MOCK_REPLY_DELAY_MS ?? delayMs);
const logPath = process.env.TMT_MOCK_LOG;
const cliPath = process.env.TMT_E2E_CLI_PATH;
const virtualizedLineCount = 200;
const maxReplyOutputBytes = 64 * 1024;
const replyChildren = new Set();
const replyGate = process.env.TMT_MOCK_REPLY_GATE;

function appendEvent(event) {
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function generatedBody(message) {
  if (process.env.TMT_MOCK_RESPONSE_BODY_BASE64 !== undefined) {
    const bytes = Buffer.from(process.env.TMT_MOCK_RESPONSE_BODY_BASE64, 'base64');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  const requestedBytes = Number(process.env.TMT_MOCK_RESPONSE_BYTES ?? 0);
  if (requestedBytes > 0) {
    if (process.env.TMT_MOCK_RESPONSE_MULTIBYTE === '1') {
      const unit = '🙂';
      const unitBytes = Buffer.byteLength(unit);
      return (
        unit.repeat(Math.floor(requestedBytes / unitBytes)) + 'a'.repeat(requestedBytes % unitBytes)
      );
    }
    return Buffer.alloc(requestedBytes, 'a').toString('utf8');
  }
  return `mock-agent response: ${message}`;
}

function virtualizedBody(message) {
  const responseLines = [
    `VIRTUALIZED-BEGIN:${message}`,
    ...Array.from(
      { length: virtualizedLineCount },
      (_, index) => `VIRTUALIZED-LINE-${String(index + 1).padStart(3, '0')}:${message}`
    ),
    `VIRTUALIZED-END:${message}`,
  ];
  return responseLines.join('\n');
}

function renderDurableSurface(body, requestId) {
  if (mode !== 'virtualized') return;
  const visibleLines = body.split('\n').slice(-3).join('\n');
  process.stdout.write(`\u001b[2J\u001b[3J\u001b[H${visibleLines}\nRESPONSE-END-${requestId}\n`);
}

function parseField(line, name) {
  const match = line.match(new RegExp(`^${name}=(\\S+)$`, 'i'));
  return match?.[1];
}

function parseCommand(line) {
  const match = line.match(/^stdin-command=tmt\s+reply\s+(\S+)\s+--receipt\s+(\S+)\s+--stdin\s*$/);
  return match ? { requestId: match[1], receipt: match[2] } : undefined;
}

function scheduleReply(requestId, receipt, body, message) {
  const start = () => setTimeout(() => submit(requestId, receipt, body, message), replyDelayMs);
  if (!replyGate) {
    start();
    return;
  }
  if (!/^req_[0-9a-f-]+$/.test(requestId)) {
    appendEvent({ event: 'failure', stage: 'request-id', requestId, mode, pid: process.pid });
    return;
  }
  const poll = setInterval(() => {
    if (
      !fs.existsSync(`${replyGate}/release`) &&
      !fs.existsSync(`${replyGate}/${requestId}.release`)
    ) {
      return;
    }
    clearInterval(poll);
    start();
  }, 10);
}

function killReplyChild(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}

function runReply(requestId, receipt, body) {
  if (!cliPath) throw new Error('TMT_E2E_CLI_PATH is required for durable mock replies.');
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cliPath, 'reply', requestId, '--receipt', receipt, '--stdin', '--json'],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    replyChildren.add(child);
    appendEvent({ event: 'child-start', requestId, childPid: child.pid, mode, pid: process.pid });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    let forcedResult;
    let killTimer;
    let timeoutTimer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      replyChildren.delete(child);
      resolve(forcedResult ?? value);
    };
    const stopWithBound = (value) => {
      if (stopping) return;
      stopping = true;
      forcedResult = value;
      killReplyChild(child);
      killTimer = setTimeout(() => finish(value), 500);
    };
    timeoutTimer = setTimeout(
      () => stopWithBound({ code: 124, stdout, stderr: `${stderr}reply subprocess timed out\n` }),
      5_000
    );
    const consume = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > maxReplyOutputBytes) {
        stopWithBound({
          code: 125,
          stdout,
          stderr: `${stderr}reply subprocess output exceeded bound\n`,
        });
        return;
      }
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.once('error', (error) =>
      finish({ code: 1, stdout, stderr: `${stderr}${error.message}\n` })
    );
    child.once('close', (code) => {
      appendEvent({
        event: 'child-close',
        requestId,
        childPid: child.pid,
        exitCode: code ?? 1,
        mode,
        pid: process.pid,
      });
      finish({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', (error) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPIPE') {
        stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      }
    });
    if (process.env.TMT_MOCK_HOLD_REPLY_EOF !== '1') child.stdin.end(body, 'utf8');
  });
}

function parseReplyResult(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function successfulSubmission(result, requestId, body) {
  const parsed = parseReplyResult(result);
  if (
    result.code !== 0 ||
    parsed?.status !== 'submitted' ||
    parsed.requestId !== requestId ||
    parsed.bodyBytes !== Buffer.byteLength(body) ||
    !Number.isSafeInteger(parsed.submittedAtMs)
  ) {
    return undefined;
  }
  return { parsed };
}

function submit(requestId, receipt, body, message) {
  const submittedRequestId = process.env.TMT_MOCK_REPLY_FAILURE ? `${requestId}-wrong` : requestId;
  runReply(submittedRequestId, receipt, body).then((result) => {
    const success = successfulSubmission(result, requestId, body);
    if (!success) {
      appendEvent({
        event: 'failure',
        stage: 'reply',
        requestId,
        message,
        mode,
        pid: process.pid,
        exitCode: result.code,
        error: parseReplyResult(result)?.error,
        stderr: result.stderr,
      });
      return;
    }

    const submitted = {
      event: 'submitted',
      requestId,
      message,
      body,
      mode,
      pid: process.pid,
      submittedAtMs: success.parsed.submittedAtMs,
      bodyBytes: success.parsed.bodyBytes,
    };
    if (process.env.TMT_MOCK_REPLY_ACK_LOSS) {
      appendEvent({ ...submitted, event: 'failure', stage: 'ack-lost' });
      runReply(requestId, receipt, body).then((retry) => {
        const retrySuccess = successfulSubmission(retry, requestId, body);
        if (retrySuccess && retrySuccess.parsed.submittedAtMs === submitted.submittedAtMs) {
          appendEvent({ ...submitted, stage: 'retry' });
        } else {
          appendEvent({ event: 'failure', stage: 'retry', requestId, mode, pid: process.pid });
        }
      });
      return;
    }
    appendEvent(submitted);

    if (process.env.TMT_MOCK_REPLY_RETRY) {
      runReply(requestId, receipt, body).then((retry) => {
        const retrySuccess = successfulSubmission(retry, requestId, body);
        if (retrySuccess && retrySuccess.parsed.submittedAtMs === submitted.submittedAtMs) {
          appendEvent({ ...submitted, stage: 'retry' });
        } else {
          appendEvent({ event: 'failure', stage: 'retry', requestId, mode, pid: process.pid });
        }
      });
    }
    if (process.env.TMT_MOCK_REPLY_CONFLICT) {
      runReply(requestId, receipt, `${body}\nconflict`).then((conflict) => {
        const conflictJson = parseReplyResult(conflict);
        appendEvent({
          event: conflict.code === 0 ? 'submitted' : 'failure',
          stage: 'conflict',
          requestId,
          mode,
          pid: process.pid,
          exitCode: conflict.code,
          error: conflictJson?.error,
        });
      });
    }
    if (process.env.TMT_MOCK_SUMMARY_FAILURE) {
      appendEvent({ event: 'failure', stage: 'summary', requestId, mode, pid: process.pid });
      return;
    }
    const summary = `mock-agent summary: ${message || '(empty)'}`;
    process.stdout.write(`${summary}\n`);
    appendEvent({ event: 'summary', requestId, message, mode, pid: process.pid });
  });
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
let messageLines = [];
let frame;

appendEvent({ event: 'ready', mode, pid: process.pid });

input.on('line', (line) => {
  if (mode === 'input-log') {
    appendEvent({ event: 'input', line, mode, pid: process.pid });
    return;
  }

  if (line === '[TMT-DURABLE-REPLY v1 BEGIN]') {
    frame = { requestId: undefined, receipt: undefined, command: undefined };
    return;
  }
  if (frame) {
    if (line === '[TMT-DURABLE-REPLY v1 END]') {
      const current = frame;
      frame = undefined;
      const message = messageLines.join('\n').trim();
      messageLines = [];
      if (
        !current.requestId ||
        !current.receipt ||
        !current.command ||
        current.command.requestId !== current.requestId ||
        current.command.receipt !== current.receipt
      ) {
        appendEvent({ event: 'failure', stage: 'frame', mode, pid: process.pid });
        return;
      }
      const requestId = current.requestId;
      const receipt = current.receipt;
      appendEvent({ event: 'request', message, requestId, receipt, mode, pid: process.pid });
      if (mode === 'silent') {
        appendEvent({ event: 'silent', message, requestId, mode, pid: process.pid });
        return;
      }
      if (mode === 'malformed') {
        setTimeout(
          () =>
            process.stdout.write(`mock-agent malformed response: ${message}\n`, () =>
              appendEvent({ event: 'malformed', message, requestId, mode, pid: process.pid })
            ),
          delayMs
        );
        return;
      }
      if (mode === 'fake-marker') {
        process.stdout.write(`RESPONSE-END-${requestId}\n`, () =>
          appendEvent({ event: 'fake-marker', message, requestId, mode, pid: process.pid })
        );
        return;
      }
      const body = mode === 'virtualized' ? virtualizedBody(message) : generatedBody(message);
      renderDurableSurface(body, requestId);
      scheduleReply(requestId, receipt, body, message);
      return;
    }
    const requestId = parseField(line, 'request-id');
    const receipt = parseField(line, 'receipt');
    if (requestId) frame.requestId = requestId;
    if (receipt) frame.receipt = receipt;
    const command = parseCommand(line);
    if (command) frame.command = command;
    return;
  }

  if (line.length > 0) messageLines.push(line);
});

process.on('exit', () => {
  for (const child of replyChildren) {
    try {
      killReplyChild(child);
    } catch {
      // Best effort during process teardown.
    }
  }
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    for (const child of replyChildren) {
      try {
        killReplyChild(child);
      } catch {
        // Best effort before terminating the mock process.
      }
    }
    process.exit(128 + ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal] ?? 1));
  });
}

input.on('close', () => appendEvent({ event: 'stopped', pid: process.pid }));
