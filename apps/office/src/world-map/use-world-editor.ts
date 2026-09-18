import { useCallback, useEffect, useRef, useState } from 'react';
import { worldHistory } from './world-draft.js';
import { sameWorld } from './world-contract.js';
import type { WorldDocument } from './world-contract.js';
import { WorldConflict, WorldValidationError } from './world-port.js';
import type { WorldPort, WorldSnapshot, WorldPlacementIssue } from './world-port.js';

/** One local history and one serialized, revision-fenced auto-apply queue. */
export function useWorldEditor(initial: WorldSnapshot, port: WorldPort) {
  const [saved, setSaved] = useState(initial);
  const [history, setHistory] = useState(() => worldHistory.create(initial.layout));
  const current = useRef({ saved, history });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<readonly WorldPlacementIssue[]>([]);
  const request = useRef<AbortController | undefined>(undefined);
  const observed = useRef(initial);
  useEffect(() => () => request.current?.abort(), []);
  const world = worldHistory.current(history);
  const dirty = !sameWorld(world, saved.layout);
  function replaceHistory(next: typeof history) {
    current.current.history = next;
    setHistory(next);
  }
  function acknowledge(next: WorldSnapshot) {
    current.current.saved = next;
    setSaved(next);
  }
  useEffect(() => {
    if (observed.current === initial) return;
    observed.current = initial;
    const state = current.current;
    if (
      !request.current &&
      !blocked &&
      sameWorld(worldHistory.current(state.history), state.saved.layout) &&
      initial.revision > state.saved.revision
    ) {
      acknowledge(initial);
      replaceHistory(worldHistory.create(initial.layout));
    }
  }, [initial, blocked]);
  function change(edit: (world: WorldDocument) => WorldDocument) {
    if (busy) return false;
    try {
      const history = current.current.history;
      replaceHistory(worldHistory.commit(history, edit(worldHistory.current(history))));
      if (!blocked) {
        setError(undefined);
        setIssues([]);
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This change is invalid.');
      return false;
    }
  }
  const apply = useCallback(async () => {
    if (request.current || busy) return;
    const { saved, history } = current.current;
    const layout = worldHistory.current(history);
    if (sameWorld(layout, saved.layout)) {
      setBlocked(false);
      setError(undefined);
      setIssues([]);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError(undefined);
    setIssues([]);
    try {
      const result = await port.save(
        { expectedRevision: saved.revision, legacyBasis: saved.legacyBasis, layout },
        controller.signal
      );
      if (controller.signal.aborted) return;
      acknowledge(result);
      setBlocked(false);
      // Keep newer local changes and undo history; the next write uses this acknowledgement.
    } catch (cause) {
      if (controller.signal.aborted) return;
      setBlocked(true);
      setError(
        cause instanceof WorldValidationError || cause instanceof WorldConflict
          ? cause.message
          : 'Changes were not confirmed. Local changes are kept. Retry explicitly or reload the saved layout.'
      );
      if (cause instanceof WorldValidationError) setIssues(cause.issues);
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setSaving(false);
    }
  }, [busy, port]);
  useEffect(() => {
    if (!dirty || saving || busy || blocked) return;
    const timer = window.setTimeout(() => void apply(), 300);
    return () => window.clearTimeout(timer);
  }, [history, saved, dirty, saving, busy, blocked, apply]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);
  async function reload() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const latest = await port.show(controller.signal);
      if (!controller.signal.aborted) {
        acknowledge(latest);
        replaceHistory(worldHistory.create(latest.layout));
        setBlocked(false);
        setError(undefined);
        setIssues([]);
      }
    } catch {
      if (!controller.signal.aborted) setError('Reload failed. Local changes are still kept.');
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return {
    world,
    saved,
    dirty,
    busy,
    saving,
    blocked,
    error,
    issues,
    change,
    reload,
    retry: apply,
    undo() {
      if (!busy) replaceHistory(worldHistory.undo(current.current.history));
    },
    redo() {
      if (!busy) replaceHistory(worldHistory.redo(current.current.history));
    },
    canUndo: history.cursor > 0,
    canRedo: history.cursor + 1 < history.entries.length,
  };
}
