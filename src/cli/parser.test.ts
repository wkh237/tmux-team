import { describe, expect, it } from 'vitest';
import { CliParseError, getCliCommandMetadata, parseArgs } from './parser.js';
import { encodeReplyReceipt } from '../reply-receipt.js';
import {
  MAX_CAPTURE_LINES,
  MAX_OBSERVER_TIMEOUT_SECONDS,
  MAX_TIMER_DELAY_MS,
} from '../domain/interaction-limits.js';

const receipt = encodeReplyReceipt({
  version: 1,
  requestId: 'request-1',
  attemptId: 'attempt-1',
  endpoint: {
    serverId: 'server-1',
    socketPath: '/tmp/tmt.sock',
    serverPid: 1234,
    serverStartTime: 'start',
    paneId: '%1',
    panePid: 5678,
  },
});

describe('declarative CLI parser', () => {
  it('parses global options independently of command position', () => {
    const parsed = parseArgs(['talk', 'claude', 'hello', '--timeout', '500ms']);
    expect(parsed.flags).toMatchObject({ timeout: 0.5 });
    expect(parsed.invocation).toMatchObject({
      kind: 'talk',
      target: { value: 'claude', kind: 'identity' },
      message: 'hello',
    });
  });

  it('parses an explicit talk originator as a typed request field', () => {
    const parsed = parseArgs(['talk', '--identity=Alice', 'claude', 'hello']);
    expect(parsed.invocation).toEqual({
      kind: 'talk',
      target: { value: 'claude', kind: 'identity', explicit: false },
      message: 'hello',
      originator: { value: 'Alice', kind: 'identity', explicit: true },
    });
    expect(parsed.flags).toEqual({ json: false, verbose: false });
    expect(parsed.flags).not.toHaveProperty('identity');
    expect(parsed.flags).not.toHaveProperty('originator');
  });

  it('keeps the last repeated originator option and supports the send alias', () => {
    expect(
      parseArgs(['talk', 'peer', 'hello', '--identity', 'Alice', '--identity=Bob']).invocation
    ).toEqual({
      kind: 'talk',
      target: { value: 'peer', kind: 'identity', explicit: false },
      message: 'hello',
      originator: { value: 'Bob', kind: 'identity', explicit: true },
    });
    expect(parseArgs(['send', 'peer', 'hello', '--identity', 'Alice']).invocation).toEqual({
      kind: 'talk',
      target: { value: 'peer', kind: 'identity', explicit: false },
      message: 'hello',
      originator: { value: 'Alice', kind: 'identity', explicit: true },
    });
  });

  it('preserves option-looking originator values and literal terminators', () => {
    expect(() => parseArgs(['talk', 'peer', '--identity', '--json', 'hello'])).toThrow(
      'Usage: tmux-team talk <target> <message>'
    );
    expect(parseArgs(['talk', 'peer', '--identity=--json', 'hello']).invocation).toMatchObject({
      originator: { value: '--json', kind: 'identity', explicit: true },
    });
    expect(parseArgs(['talk', 'peer', '--identity', 'Alice', '--', '--identity Bob'])).toEqual(
      expect.objectContaining({
        invocation: {
          kind: 'talk',
          target: { value: 'peer', kind: 'identity', explicit: false },
          message: '--identity Bob',
          originator: { value: 'Alice', kind: 'identity', explicit: true },
        },
      })
    );
  });

  it('keeps originator local to talk and preserves missing-argument usage', () => {
    expect(() => parseArgs(['talk', 'peer', 'hello', '--identity'])).toThrow(CliParseError);
    expect(() => parseArgs(['--identity', 'Alice', 'talk', 'peer', 'hello'])).toThrow(
      "unknown option '--identity'"
    );
    expect(() => parseArgs(['list', 'peer', '--identity', 'Alice'])).toThrow(
      "unknown option '--identity'"
    );
    expect(() => parseArgs(['talk', 'peer', '--identity', 'Alice'])).toThrow(
      'Usage: tmux-team talk <target> <message>'
    );
  });

  it('keeps role selectors explicit and preserves dash-prefixed profile literals', () => {
    const parsed = parseArgs(['role', '--identity=show', 'set', '--', '--json profile']);
    expect(parsed.invocation).toEqual({
      kind: 'role',
      operation: 'set',
      content: '--json profile',
      selector: { value: 'show', kind: 'identity', explicit: true },
    });
    expect(parsed.flags.json).toBe(false);
    expect(parsed.metadata.capability).toBe('storage');
    expect(parseArgs(['role', 'show']).metadata.capability).toBe('storage');
    for (const args of [
      ['role'],
      ['role', 'Alice', 'show'],
      ['role', 'show', 'Alice'],
      ['role', 'show', '--file', 'profile.md'],
      ['role', 'clear', '--file', 'profile.md'],
      ['role', 'list'],
      ['role', 'show', '--identity'],
    ])
      expect(() => parseArgs(args)).toThrow(CliParseError);
  });

  it('preserves dash-prefixed literals after the terminator', () => {
    const parsed = parseArgs(['talk', 'claude', '--', '--json is part of the message']);
    expect(parsed.flags.json).toBe(false);
    expect(parsed.invocation).toMatchObject({
      kind: 'talk',
      message: '--json is part of the message',
    });
  });

  it('supports nested command schemas', () => {
    const config = parseArgs(['config', 'set', 'mode', 'wait', '--global']);
    expect(config.invocation).toMatchObject({
      kind: 'config',
      operation: 'set',
      key: 'mode',
      value: 'wait',
      global: true,
    });
  });

  it('parses detach and rejects retired wait/lines options before effects', () => {
    expect(parseArgs(['talk', 'claude', 'hello', '--detach']).flags).toMatchObject({
      detach: true,
    });
    expect(() => parseArgs(['talk', 'claude', 'hello', '--wait'])).toThrow(CliParseError);
    expect(() => parseArgs(['talk', 'claude', 'hello', '--lines', '10'])).toThrow(CliParseError);
    expect(() => parseArgs(['check', 'claude', '--lines', '10'])).not.toThrow();
  });

  it('bounds capture lines for both positional and explicit options', () => {
    expect(parseArgs(['check', 'claude', '0']).invocation).toMatchObject({ lines: 0 });
    expect(parseArgs(['check', 'claude', '--lines', String(MAX_CAPTURE_LINES)])).toMatchObject({
      flags: { lines: MAX_CAPTURE_LINES },
    });
    expect(
      parseArgs(['check', 'claude', '0', '--lines', String(MAX_CAPTURE_LINES)]).invocation
    ).toMatchObject({ lines: 0 });
    for (const args of [
      ['check', 'claude', String(MAX_CAPTURE_LINES + 1)],
      ['check', 'claude', '--lines', String(MAX_CAPTURE_LINES + 1)],
      ['check', 'claude', '--lines', '999999999999999999999999999999'],
      ['check', 'claude', '--lines', '10junk'],
    ]) {
      expect(() => parseArgs(args)).toThrow(CliParseError);
    }
  });

  it('accepts timing limits at their supported boundaries', () => {
    expect(
      parseArgs(['talk', 'claude', 'hello', '--timeout', `${MAX_OBSERVER_TIMEOUT_SECONDS}s`]).flags
        .timeout
    ).toBe(MAX_OBSERVER_TIMEOUT_SECONDS);
    expect(
      parseArgs(['talk', 'claude', 'hello', '--delay', `${MAX_TIMER_DELAY_MS}ms`]).flags.delay
    ).toBe(MAX_TIMER_DELAY_MS / 1000);
    expect(() =>
      parseArgs(['talk', 'claude', 'hello', '--delay', `${MAX_TIMER_DELAY_MS + 1}ms`])
    ).toThrow(CliParseError);
    expect(() =>
      parseArgs(['talk', 'claude', 'hello', '--timeout', `${MAX_OBSERVER_TIMEOUT_SECONDS + 1}s`])
    ).toThrow(CliParseError);
  });

  it('applies no-preamble regardless of whether it appears before or after talk', () => {
    expect(parseArgs(['--no-preamble', 'talk', 'claude', 'hello']).flags.noPreamble).toBe(true);
    expect(parseArgs(['talk', 'claude', 'hello', '--no-preamble']).flags.noPreamble).toBe(true);
  });

  it('does not reinterpret a required option value as another option', () => {
    const parsed = parseArgs(['talk', 'peer', '--team', '--no-preamble', 'message']);
    expect(parsed.invocation).toMatchObject({ kind: 'talk', message: 'message' });
    expect(parsed.flags.noPreamble).toBeUndefined();
    expect(parsed.metadata.unsupportedTeam).toBe(true);
  });

  it('rejects the unconsumed config option at the selected command boundary', () => {
    expect(() => parseArgs(['learn', '--config', '/tmp/tmt.json'])).toThrow(
      "Unknown option '--config' for learn."
    );
    expect(() => parseArgs(['role', 'show', '--timeout', '2'])).toThrow(
      "Unknown option '--timeout' for show."
    );
  });

  it('enforces command-local option ownership while retaining aliases and root placement', () => {
    expect(parseArgs(['talk', 'peer', 'message', '--force']).flags.force).toBe(true);
    expect(parseArgs(['install', '--force']).flags.force).toBe(true);
    expect(parseArgs(['--timeout', '2', 'send', 'peer', 'message']).flags.timeout).toBe(2);
    expect(parseArgs(['read', 'peer', '--lines', '0']).invocation).toMatchObject({ lines: 0 });
    for (const args of [
      ['list', '--force'],
      ['name', 'Alice', '--force'],
      ['role', 'show', '--force'],
      ['list', '--delay', '1'],
      ['role', 'show', '--no-preamble'],
      ['read', 'peer', '--timeout', '2'],
    ]) {
      expect(() => parseArgs(args)).toThrow(CliParseError);
    }
  });

  it('projects help and completion metadata from the Commander tree', () => {
    const metadata = getCliCommandMetadata();
    const talk = metadata.commands.find((command) => command.name === 'talk');
    const check = metadata.commands.find((command) => command.name === 'check');
    expect(talk?.description).toBe('Send a message to an identity or pane');
    expect(check?.description).toBe('Capture output from an agent pane');
    expect(talk?.options.some((option) => option.long === '--timeout')).toBe(true);
    expect(talk?.options.some((option) => option.long === '--lines')).toBe(false);
    expect(check?.options.some((option) => option.long === '--lines')).toBe(true);
    expect(
      metadata.commands
        .find((command) => command.name === 'learn')
        ?.options.some((option) => option.long === '--config')
    ).toBe(false);
    expect(metadata.options.some((option) => option.long === '--timeout')).toBe(true);
    expect(metadata.options.some((option) => option.long === '--config')).toBe(true);
    expect(metadata.options.find((option) => option.long === '--config')).toMatchObject({
      hidden: true,
      rootRecognized: true,
      rootAllowed: false,
    });
    expect(metadata.commands.find((command) => command.name === 'team')?.hidden).toBe(true);
  });

  it.each([
    ['0', 'zero'],
    ['-1', 'negative'],
    ['NaN', 'non-finite'],
    ['86400.001s', 'over the 24-hour maximum'],
  ])('rejects %s timeout (%s)', (value) => {
    expect(() => parseArgs(['talk', 'claude', 'hello', '--timeout', value])).toThrow(CliParseError);
  });

  it('rejects detach together with an explicit timeout', () => {
    expect(() => parseArgs(['talk', 'claude', 'hello', '--detach', '--timeout', '1s'])).toThrow(
      CliParseError
    );
  });

  it('classifies existing positional targets without introducing future selector syntax', () => {
    expect(parseArgs(['list', 'all']).invocation).toMatchObject({
      target: { value: 'all', kind: 'identity' },
    });
    expect(parseArgs(['list', '1.0']).invocation).toMatchObject({
      target: { value: '1.0', kind: 'pane' },
    });
    expect(() => parseArgs(['list', '--identity', 'all'])).toThrow(CliParseError);
  });

  it('rejects unknown options before creating command context', () => {
    expect(() => parseArgs(['list', '--nope'])).toThrow(CliParseError);
  });

  it('reports surplus positional arguments through the schema', () => {
    expect(() => parseArgs(['whoami', 'extra'])).toThrow(CliParseError);
    expect(() => parseArgs(['config', 'show', 'extra'])).toThrow(CliParseError);
  });

  it('parses nested mutations and preserves literal terminator values', () => {
    expect(parseArgs(['preamble', 'show', 'gemini']).invocation).toEqual({
      kind: 'preamble',
      operation: 'show',
      agent: 'gemini',
    });
    expect(parseArgs(['preamble', 'set', 'gemini', '--', '--json', '--wait']).invocation).toEqual({
      kind: 'preamble',
      operation: 'set',
      agent: 'gemini',
      preamble: '--json --wait',
    });
    expect(parseArgs(['preamble', 'clear', 'gemini']).invocation).toEqual({
      kind: 'preamble',
      operation: 'clear',
      agent: 'gemini',
    });
    expect(parseArgs(['config', 'clear', 'mode']).invocation).toEqual({
      kind: 'config',
      operation: 'clear',
      key: 'mode',
      global: false,
    });
    expect(() => parseArgs(['config', 'clear', 'mode', '--global'])).toThrow(CliParseError);
    expect(parseArgs(['install', 'codex']).invocation).toEqual({
      kind: 'install',
      target: 'codex',
    });
  });

  it('selects resource capabilities and preserves aliases', () => {
    expect(parseArgs(['help']).metadata).toMatchObject({ capability: 'none' });
    expect(parseArgs(['completion', 'zsh']).metadata).toMatchObject({ capability: 'none' });
    expect(parseArgs(['learn']).metadata).toMatchObject({ capability: 'none' });
    expect(parseArgs(['config']).metadata).toMatchObject({ capability: 'storage' });
    for (const args of [
      ['preamble', 'show', 'claude'],
      ['preamble', 'set', 'claude', 'Be concise'],
      ['preamble', 'clear', 'claude'],
    ]) {
      expect(parseArgs(args).metadata).toMatchObject({ capability: 'storage' });
    }
    for (const args of [['name', 'Alice'], ['this', 'Alice'], ['whoami'], ['unbind']]) {
      expect(parseArgs(args).metadata).toMatchObject({ capability: 'storage' });
    }
    expect(parseArgs(['send', 'claude', 'hello']).metadata.commandPath).toEqual(['send']);
    expect(parseArgs(['ls']).invocation).toEqual({ kind: 'list' });
  });

  it.each([
    {
      args: ['update', 'claude', '--pane', '2.0', '--remark', 'new'],
      command: 'update',
      json: false,
    },
    { args: ['--json', 'remove', 'claude'], command: 'remove', json: true },
    { args: ['rm', 'claude'], command: 'rm', json: false },
    { args: ['migrate', '--dry-run', '--cleanup'], command: 'migrate', json: false },
  ])('rejects retired command $command before dispatch', ({ args, command, json }) => {
    try {
      parseArgs(args);
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'CliParseError',
        flags: { json },
      });
      expect((error as Error).message).toBe(
        `Unknown command: ${command}. Run 'tmux-team help' for usage.`
      );
    }
  });

  it('preserves retired command words as talk data', () => {
    expect(parseArgs(['talk', 'claude', 'update remove migrate']).invocation).toMatchObject({
      kind: 'talk',
      message: 'update remove migrate',
    });
    expect(parseArgs(['talk', 'claude', '--', 'update remove migrate']).invocation).toMatchObject({
      kind: 'talk',
      message: 'update remove migrate',
    });
  });

  it('returns structured parse failures for invalid values and unknown options', () => {
    expect(() => parseArgs(['talk', 'claude', 'hello', '--delay', 'later'])).toThrow(
      'Invalid time format: later'
    );
    expect(() => parseArgs(['check', 'claude', 'not-lines'])).toThrow(CliParseError);
    try {
      parseArgs(['--json', 'config', 'set', 'mode', 'wait', '--nope']);
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'CliParseError',
        flags: { json: true },
      });
      expect((error as Error).message).toContain("unknown option '--nope'");
    }
    expect(() => parseArgs(['--json', 'config', 'set', 'mode'])).toThrow(CliParseError);
  });

  it('does not mistake a later command-shaped operand for the unknown command', () => {
    expect(() => parseArgs(['no-command', 'talk'])).toThrow(
      "Unknown command: no-command. Run 'tmux-team help' for usage."
    );
    expect(() => parseArgs(['--timeout', 'check', 'talk', 'peer', 'message'])).toThrow(
      'Invalid time format: check'
    );
    expect(() => parseArgs(['send'])).toThrow('Usage: tmux-team send <target> <message>');
  });

  it('rejects command-local options before a command and preserves diagnostic flags', () => {
    for (const args of [
      ['--receipt', 'receipt', 'reply', 'request-1'],
      ['--dir', '/tmp/skills', 'install'],
      ['--identity', 'Alice', 'role', 'show'],
      ['--bogus', 'hello'],
    ]) {
      expect(() => parseArgs(args)).toThrow(`unknown option '${args[0]}'`);
    }
    try {
      parseArgs(['--json', 'list', '--nope', '--debug', '--verbose']);
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'CliParseError',
        flags: { json: true, debug: true, verbose: true },
      });
    }
  });

  it('supports top-level help and version with options before the special flag', () => {
    expect(parseArgs(['--json', '--help'])).toMatchObject({
      invocation: { kind: 'help', showIntro: false },
      flags: { json: true },
    });
    expect(parseArgs(['--verbose', '--version'])).toMatchObject({
      invocation: { kind: 'version' },
      flags: { verbose: true },
    });
  });

  it('does not reinterpret command arguments as top-level help or version flags', () => {
    expect(() => parseArgs(['talk', 'claude', '--help'])).toThrow(CliParseError);
    expect(() => parseArgs(['talk', 'claude', '--version'])).toThrow(CliParseError);
    expect(parseArgs(['talk', 'claude', '--', '--help']).invocation).toMatchObject({
      kind: 'talk',
      message: '--help',
    });
  });

  it('normalizes true globals and records unsupported team scope', () => {
    const parsed = parseArgs(['--json', '--verbose', '--debug', '--team', 'legacy', 'list']);
    expect(parsed.flags).toMatchObject({
      json: true,
      verbose: true,
      debug: true,
    });
    expect(parsed.metadata).toMatchObject({ unsupportedTeam: true, commandPath: ['list'] });
  });

  it('parses action-first role commands and enforces one set input source', () => {
    expect(parseArgs(['role', 'show', '--identity', 'Alice']).invocation).toMatchObject({
      kind: 'role',
      operation: 'show',
      selector: { value: 'Alice', kind: 'identity', explicit: true },
    });
    expect(parseArgs(['role', 'set', 'text', '--identity', 'Alice']).invocation).toMatchObject({
      kind: 'role',
      operation: 'set',
      content: 'text',
      selector: { value: 'Alice', kind: 'identity', explicit: true },
    });
    expect(parseArgs(['role', 'set', '--file', '/tmp/role.txt']).invocation).toMatchObject({
      kind: 'role',
      operation: 'set',
      file: '/tmp/role.txt',
    });
    expect(parseArgs(['role', 'clear']).invocation).toEqual({ kind: 'role', operation: 'clear' });
    expect(() => parseArgs(['role', 'set'])).toThrow(CliParseError);
    expect(() => parseArgs(['role', 'set', 'text', '--file', '/tmp/role.txt'])).toThrow(
      CliParseError
    );
    expect(() => parseArgs(['role', 'set', 'a', 'b'])).toThrow(CliParseError);
  });

  it('parses skill viewing and custom install directories', () => {
    expect(parseArgs(['learn', '--skill']).invocation).toEqual({ kind: 'learn', skill: true });
    expect(parseArgs(['install', '--dir', 'relative skills']).invocation).toEqual({
      kind: 'install',
      directory: 'relative skills',
    });
    expect(() => parseArgs(['install', '--dir', '   '])).toThrow(CliParseError);
    expect(() => parseArgs(['install', 'codex', '--dir', '/tmp/skills'])).toThrow(CliParseError);
    expect(() => parseArgs(['install', 'all', '--dir', '/tmp/skills'])).toThrow(CliParseError);
  });

  it('parses storage-only reply/result commands with explicit input and no tmux capability', () => {
    expect(
      parseArgs(['reply', 'request-1', '--receipt', receipt, '--file', '/tmp/reply.txt', '--json'])
    ).toEqual(
      expect.objectContaining({
        invocation: {
          kind: 'reply',
          requestId: 'request-1',
          receipt,
          file: '/tmp/reply.txt',
        },
        metadata: expect.objectContaining({ capability: 'storage', commandPath: ['reply'] }),
      })
    );
    expect(parseArgs(['reply', 'request-1', '--receipt', receipt, '--stdin']).invocation).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt,
      stdin: true,
    });
    expect(
      parseArgs(['reply', 'request-1', '--receipt', receipt, '--message', 'inline response'])
        .invocation
    ).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt,
      message: 'inline response',
    });
    expect(
      parseArgs(['reply', 'request-1', '--receipt', receipt, '--message', '']).invocation
    ).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt,
      message: '',
    });
    expect(
      parseArgs(['reply', 'request-1', '--receipt', receipt, '--message=-leading text']).invocation
    ).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt,
      message: '-leading text',
    });
    expect(
      parseArgs(['reply', 'request-1', '--receipt', receipt, '--message=--json']).invocation
    ).toEqual({
      kind: 'reply',
      requestId: 'request-1',
      receipt,
      message: '--json',
    });
    expect(parseArgs(['result', 'request-1', '--json'])).toMatchObject({
      invocation: { kind: 'result', requestId: 'request-1' },
      metadata: expect.objectContaining({ capability: 'storage', commandPath: ['result'] }),
    });
  });

  it('rejects reply input ambiguity, missing receipt, invalid IDs, and result input flags', () => {
    const invalid = [
      ['reply', 'request-1', '--receipt', receipt],
      ['reply', 'request-1', '--receipt', receipt, '--file', '/tmp/reply', '--stdin'],
      ['reply', 'request-1', '--receipt', receipt, '--file', '/tmp/reply', '--message', 'inline'],
      ['reply', 'request-1', '--receipt', receipt, '--stdin', '--message', 'inline'],
      ['reply', 'request-1', '--receipt', receipt, '--wait', '--stdin'],
      ['reply', 'request-1', '--receipt', receipt, '--team', 'legacy', '--stdin'],
      ['--wait', 'reply', 'request-1', '--receipt', receipt, '--stdin'],
      ['reply', 'request-1', '--receipt', receipt, '--stdin', '--no-preamble'],
      ['--timeout', '5s', 'result', 'request-1'],
      ['result', 'request-1', '--no-preamble'],
      ['result', 'request-1', '--file', '/tmp/reply'],
      ['result', 'request-1', '--stdin'],
      ['reply', '', '--receipt', receipt, '--stdin'],
      ['reply', 'x'.repeat(257), '--receipt', receipt, '--stdin'],
    ];
    for (const args of invalid) expect(() => parseArgs(args)).toThrow(CliParseError);
  });
});
