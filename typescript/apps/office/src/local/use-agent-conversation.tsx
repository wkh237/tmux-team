import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { SelectionAnchor } from '../rendering/selection-anchor.js';
import type { OfficeSelection } from '../rendering/office-selection.js';
import type { LocalRuntime } from './local-runtime.js';
import { AgentConversation } from './agent-conversation.js';
import type { ConversationTarget } from './agent-conversation.js';
import type { ConversationCue } from './conversation-cue.js';
import './agent-hud.css';

const targetKey = (target: ConversationTarget) => `${target.id}:${target.room?.id ?? ''}`;
type Tab = 'chat' | 'info';
interface Contents {
  info(target: ConversationTarget): ReactNode;
  portrait(target: ConversationTarget): ReactNode;
  closed(): void;
  suspended?: boolean;
  initial?: ConversationTarget;
}

/** A single retained non-modal session; minimization observes, closing pauses. */
export function useAgentConversation(
  runtime: Pick<LocalRuntime, 'dispatch' | 'requests'>,
  contents: Contents
) {
  const [target, setTarget] = useState<ConversationTarget | undefined>(contents.initial);
  const [nextTarget, setNextTarget] = useState<ConversationTarget>();
  const [mode, setMode] = useState<'closed' | 'expanded' | 'minimized'>(
    contents.initial ? 'expanded' : 'closed'
  );
  const [tab, setTab] = useState<Tab>(contents.initial ? 'info' : 'chat');
  const [dirty, setDirty] = useState(false);
  const [cue, setCue] = useState<ConversationCue>({ kind: 'idle', text: 'Open chat' });
  const heading = useRef<HTMLHeadingElement>(null);
  const bubble = useRef<HTMLButtonElement>(null);
  const key = target && targetKey(target);
  useEffect(() => {
    if (mode === 'expanded') heading.current?.focus({ preventScroll: true });
    if (mode === 'minimized') bubble.current?.focus({ preventScroll: true });
  }, [mode, key]);
  const updateCue = useCallback((next: ConversationCue) => {
    setCue((previous) =>
      previous.kind === next.kind &&
      previous.text === next.text &&
      previous.requestId === next.requestId
        ? previous
        : next
    );
  }, []);
  const open = useCallback(
    (identity: ConversationTarget, nextTab: Tab = 'chat') => {
      if (target && targetKey(target) !== targetKey(identity) && dirty) setNextTarget(identity);
      else {
        setTarget(identity);
        setNextTarget(undefined);
        setTab(nextTab);
      }
      setMode('expanded');
    },
    [dirty, target]
  );
  const anchorTarget = useMemo<Extract<OfficeSelection, { kind: 'agent' }> | undefined>(
    () =>
      target && mode !== 'closed' && !contents.suspended
        ? {
            kind: 'agent',
            identityId: target.id,
            ...(target.areaId ? { areaId: target.areaId } : {}),
          }
        : undefined,
    [target, mode, contents.suspended]
  );
  function close() {
    setMode('closed');
    contents.closed();
  }
  function render(anchor?: SelectionAnchor) {
    if (!target) return null;
    const style = anchor
      ? ({ '--agent-x': `${anchor.x}px`, '--agent-y': `${anchor.y}px` } as CSSProperties)
      : undefined;
    return (
      <div
        className="agent-hud-host"
        style={style}
        data-anchored={Boolean(anchor)}
        data-mode={mode}
        hidden={mode === 'closed' || contents.suspended}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
        }}
      >
        {mode === 'minimized' && (
          <button
            ref={bubble}
            className="agent-reply-cue"
            data-kind={cue.kind}
            onClick={() => {
              setMode('expanded');
              setTab('chat');
            }}
          >
            <span>{target.name}</span>
            <strong>{cue.text}</strong>
          </button>
        )}
        <aside aria-label="Agent details" hidden={mode !== 'expanded'}>
          <section
            className="agent-hud"
            role="dialog"
            aria-label="Agent conversation"
            aria-modal="false"
          >
            <header className="agent-hud-header">
              {contents.portrait(target)}
              <div>
                <h2 ref={heading} tabIndex={-1}>
                  {target.name}
                </h2>
                <small>{target.room?.name ?? 'Direct conversation'}</small>
              </div>
              <button aria-label="Minimize agent conversation" onClick={() => setMode('minimized')}>
                −
              </button>
              <button aria-label="Close agent conversation" onClick={close}>
                ×
              </button>
            </header>
            {nextTarget && (
              <section className="agent-hud-confirm" aria-label="Switch conversation confirmation">
                <h3>
                  Open conversation with {nextTarget.name}
                  {nextTarget.room ? ` in ${nextTarget.room.name}` : ''}?
                </h3>
                <p>
                  The unsent draft here will be discarded. Submitted work is not cancelled;
                  unconfirmed sends remain recoverable when you return.
                </p>
                <button
                  onClick={() => {
                    setTarget(nextTarget);
                    setNextTarget(undefined);
                    setDirty(false);
                    setTab('chat');
                  }}
                >
                  Switch conversation
                </button>
                <button onClick={() => setNextTarget(undefined)}>Keep this conversation</button>
              </section>
            )}
            <div className="agent-hud-tabs" role="tablist" aria-label="Agent view">
              <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
                Chat
              </button>
              <button role="tab" aria-selected={tab === 'info'} onClick={() => setTab('info')}>
                Info
              </button>
            </div>
            <div role="tabpanel" aria-label="Chat" hidden={tab !== 'chat' || Boolean(nextTarget)}>
              <AgentConversation
                key={targetKey(target)}
                target={target}
                runtime={runtime}
                compact
                active={
                  mode !== 'closed' &&
                  (tab === 'chat' || mode === 'minimized') &&
                  !nextTarget &&
                  !contents.suspended
                }
                reading={
                  mode === 'expanded' && tab === 'chat' && !nextTarget && !contents.suspended
                }
                minimized={mode === 'minimized'}
                onDirtyChange={setDirty}
                onCueChange={updateCue}
              />
            </div>
            <div role="tabpanel" aria-label="Info" hidden={tab !== 'info' || Boolean(nextTarget)}>
              {contents.info(target)}
              <button className="agent-info-message" onClick={() => setTab('chat')}>
                Message {target.name}
              </button>
            </div>
          </section>
        </aside>
      </div>
    );
  }
  return { open, render, anchorTarget };
}
