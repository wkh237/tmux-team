import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ui', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
  });

  it('colors functions apply ANSI codes when isTTY is true', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    vi.resetModules();
    const { colors } = await import('./ui.js');

    expect(colors.red('test')).toContain('\x1b[31m');
    expect(colors.green('test')).toContain('\x1b[32m');
    expect(colors.yellow('test')).toContain('\x1b[33m');
    expect(colors.blue('test')).toContain('\x1b[34m');
    expect(colors.cyan('test')).toContain('\x1b[36m');
    expect(colors.dim('test')).toContain('\x1b[2m');
  });

  it('colors functions return plain text when isTTY is false', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    vi.resetModules();
    const { colors } = await import('./ui.js');

    expect(colors.red('test')).toBe('test');
    expect(colors.green('test')).toBe('test');
    expect(colors.yellow('test')).toBe('test');
    expect(colors.blue('test')).toBe('test');
    expect(colors.cyan('test')).toBe('test');
    expect(colors.dim('test')).toBe('test');
  });

  it('createUI(jsonMode=true) suppresses human output and emits JSON errors', async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createUI } = await import('./ui.js');
    const ui = createUI(true);

    ui.info('x');
    ui.success('x');
    ui.warn('x');
    ui.table(['A'], [['B']]);
    expect(logSpy).not.toHaveBeenCalled();

    ui.error('boom');
    expect(errSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }));

    ui.json({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true }, null, 2));
  });

  it('createUI(jsonMode=false) prints messages and table', async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { createUI } = await import('./ui.js');
    const ui = createUI(false);

    ui.info('hello');
    ui.success('ok');
    ui.warn('warn');
    ui.error('err');

    expect(logSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();

    logSpy.mockClear();
    ui.table(
      ['Name', 'Pane'],
      [
        ['claude', '1.0'],
        ['codex', '1.1'],
      ]
    );
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Name');
    expect(output).toContain('Pane');
    expect(output).toContain('claude');
    expect(output).toContain('1.0');

    logSpy.mockClear();
    ui.json({ data: 'test' });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ data: 'test' }, null, 2));
  });

  it('table handles empty cells and null values', async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { createUI } = await import('./ui.js');
    const ui = createUI(false);

    ui.table(['Name', 'Value'], [['test', ''], ['empty', null as unknown as string]]);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Empty cells should be rendered as '-'
    expect(output).toContain('-');
  });
});
