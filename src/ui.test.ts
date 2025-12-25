import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ui', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
  });
});
