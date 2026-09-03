import { describe, expect, it } from 'vitest';
import { CliParseError, parseArgs } from './parser.js';

describe('declarative CLI parser', () => {
  it('parses global options independently of command position', () => {
    const parsed = parseArgs(['talk', 'claude', 'hello', '--timeout', '500ms', '--wait']);
    expect(parsed.flags).toMatchObject({ timeout: 0.5, wait: true });
    expect(parsed.invocation).toMatchObject({
      kind: 'talk',
      target: { value: 'claude', kind: 'identity' },
      message: 'hello',
    });
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

  it('supports nested command schemas and typed update options', () => {
    const config = parseArgs(['config', 'set', 'mode', 'wait', '--global']);
    expect(config.invocation).toMatchObject({
      kind: 'config',
      operation: 'set',
      key: 'mode',
      value: 'wait',
      global: true,
    });

    const update = parseArgs(['update', 'claude', '--pane=2.0', '--remark', 'new']);
    expect(update.invocation).toMatchObject({
      kind: 'update',
      name: 'claude',
      options: { pane: '2.0', remark: 'new' },
    });
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

  it('parses every nested mutation and preserves literal terminator values', () => {
    expect(parseArgs(['migrate', '--dry-run', '--cleanup']).invocation).toEqual({
      kind: 'migrate',
      dryRun: true,
      cleanup: true,
    });
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
    expect(parseArgs(['send', 'claude', 'hello']).metadata.commandPath).toEqual(['send']);
    expect(parseArgs(['ls']).invocation).toEqual({ kind: 'list' });
    expect(parseArgs(['rm', 'claude']).invocation).toEqual({ kind: 'remove', name: 'claude' });
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

  it('normalizes all common flags and records unsupported team scope', () => {
    const parsed = parseArgs([
      '--json',
      '--verbose',
      '--debug',
      '--force',
      '--config',
      '/tmp/tmt.json',
      '--delay',
      '250ms',
      '--wait',
      '--timeout',
      '3s',
      '--lines',
      '12',
      '--team',
      'legacy',
      'list',
    ]);
    expect(parsed.flags).toMatchObject({
      json: true,
      verbose: true,
      debug: true,
      force: true,
      config: '/tmp/tmt.json',
      delay: 0.25,
      wait: true,
      timeout: 3,
      lines: 12,
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
});
