import crypto from 'node:crypto';
import { TmuxDeliveryError } from './message-delivery.js';

const TMUX_SEND_TIMEOUT_MS = 1_000;
const TMUX_SEND_MAX_BUFFER = 64 * 1024;

type SendCommandOptions = {
  timeout: number;
  maxBuffer: number;
  killSignal: 'SIGKILL';
  stdio: ['pipe', 'pipe', 'pipe'];
};

type ExecuteSendCommand = (args: string[], options: SendCommandOptions) => void;

export interface TmuxMessageOptions {
  readonly paneId: string;
  readonly message: string;
  readonly enterDelayMs: number;
  readonly execute: ExecuteSendCommand;
  readonly sleep: (ms: number) => void;
}

function commandOptions(): SendCommandOptions {
  return {
    timeout: TMUX_SEND_TIMEOUT_MS,
    maxBuffer: TMUX_SEND_MAX_BUFFER,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function escapeExclamation(message: string): string {
  // Coding-agent shells can interpret ! before the provider receives input.
  return message.replace(/!/g, '\uff01');
}

function ensureTrailingNewline(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`;
}

function makeBufferName(): string {
  const nonce = crypto.randomBytes(4).toString('hex');
  return `tmt-${process.pid}-${Date.now()}-${nonce}`;
}

export function sendTmuxMessage(options: TmuxMessageOptions): void {
  const { paneId, message, enterDelayMs, execute, sleep } = options;
  const bufferName = makeBufferName();
  // The same protected payload is used by buffer paste and literal fallback.
  const payload = ensureTrailingNewline(escapeExclamation(message));

  const cleanupBuffer = (): void => {
    try {
      execute(['delete-buffer', '-b', bufferName], commandOptions());
    } catch {
      // Cleanup is best effort and must not change the delivery outcome.
    }
  };

  const submit = (): void => {
    try {
      sleep(enterDelayMs);
      execute(['send-keys', '-t', paneId, 'Enter'], commandOptions());
    } catch (error) {
      throw new TmuxDeliveryError('submit', { cause: error });
    }
  };

  try {
    execute(['set-buffer', '-b', bufferName, '--', payload], commandOptions());
  } catch {
    // Paste has not been invoked, so one literal fallback remains safe even if
    // set-buffer's subprocess outcome was uncertain.
    cleanupBuffer();
    try {
      execute(['send-keys', '-l', '-t', paneId, '--', payload], commandOptions());
    } catch (error) {
      throw new TmuxDeliveryError('literal', { cause: error });
    }
    submit();
    return;
  }

  try {
    execute(['paste-buffer', '-b', bufferName, '-d', '-t', paneId, '-p'], commandOptions());
  } catch (error) {
    cleanupBuffer();
    throw new TmuxDeliveryError('paste', { cause: error });
  }

  submit();
}
