import { describe, expect, it } from 'vitest';
import { resolveIdentityContext, type IdentityContext } from './identity-context.js';

const registration = (name: string, paneId: string) => ({
  name,
  canonicalName: name.toLowerCase(),
  paneId,
});

describe('resolveIdentityContext', () => {
  it('resolves the single identity proven to be on the current pane', () => {
    const context: IdentityContext = {
      currentPaneId: '%1',
      registrations: [registration('Codex', '%1')],
    };
    expect(resolveIdentityContext(context)).toMatchObject({
      status: 'bound',
      registration: { name: 'Codex' },
    });
  });

  it('distinguishes outside-tmux and an unbound current pane', () => {
    expect(resolveIdentityContext({ currentPaneId: null, registrations: [] })).toEqual({
      status: 'outside-tmux',
    });
    expect(resolveIdentityContext({ currentPaneId: '%2', registrations: [] })).toEqual({
      status: 'unbound',
    });
  });

  it('reports ambiguity and resolves an explicit identity independently of the current pane', () => {
    const context: IdentityContext = {
      currentPaneId: '%1',
      registrations: [registration('Codex', '%1'), registration('Gemini', '%2')],
    };
    expect(
      resolveIdentityContext(context, { value: 'gemini', kind: 'identity', explicit: true })
    ).toMatchObject({ status: 'bound', registration: { name: 'Gemini' } });
    expect(
      resolveIdentityContext({
        currentPaneId: '%1',
        registrations: [registration('A', '%1'), registration('a', '%1')],
      })
    ).toMatchObject({ status: 'ambiguous' });
  });

  it('uses the shared identity normalization rules and distinguishes a missing selector', () => {
    const context: IdentityContext = {
      currentPaneId: null,
      registrations: [registration('ＡＬＩＣＥ', '%3')],
    };
    expect(
      resolveIdentityContext(context, { value: ' alice ', kind: 'identity', explicit: true })
    ).toMatchObject({ status: 'bound', registration: { paneId: '%3' } });
    expect(
      resolveIdentityContext(context, { value: 'missing', kind: 'identity', explicit: true })
    ).toEqual({ status: 'not-found' });
  });
});
