import { useEffect, useMemo, useRef, useState } from 'react';
import { worldHistory } from './world-draft.js';
import { sameWorld } from './world-contract.js';
import type { WorldDocument } from './world-contract.js';
import type { SnapshotHistory } from '../editor/snapshot-history.js';
import { WorldConflict, WorldValidationError } from './world-port.js';
import type { WorldPort, WorldSnapshot, WorldPlacementIssue } from './world-port.js';

/** One mounted world's save fence and draft. No shadow store, autosave or implicit rebase. */
export function useWorldEditor(initial: WorldSnapshot, port: WorldPort) {
  const [saved, setSaved] = useState(initial);
  const [history, setHistory] = useState<SnapshotHistory<WorldDocument>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<readonly WorldPlacementIssue[]>([]);
  const request = useRef<AbortController | undefined>(undefined);
  const observed = useRef(initial);
  useEffect(() => () => request.current?.abort(), []);
  // Explicit overview refresh may update the saved projection without unmounting
  // panels. Never rebase an editing draft or roll back a locally confirmed save.
  useEffect(() => {
    if (observed.current === initial) return;
    observed.current = initial;
    if (!history && !busy)
      setSaved((current) => (initial.revision >= current.revision ? initial : current));
  }, [initial, history, busy]);
  const world = history ? worldHistory.current(history) : saved.layout;
  const dirty = useMemo(
    () => Boolean(history && !sameWorld(world, saved.layout)),
    [history, world, saved]
  );
  function clearError() {
    setError(undefined);
    setIssues([]);
  }
  function change(edit: (world: WorldDocument) => WorldDocument) {
    if (!history || request.current) return false;
    try {
      const next = worldHistory.commit(history, edit(world));
      setHistory(next);
      clearError();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This change is invalid.');
      return false;
    }
  }
  async function save() {
    if (!history || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    clearError();
    try {
      const result = await port.save(
        { expectedRevision: saved.revision, legacyBasis: saved.legacyBasis, layout: world },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setSaved(result);
      setHistory(undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        cause instanceof WorldValidationError || cause instanceof WorldConflict
          ? cause.message
          : 'Save was not confirmed. Your draft is kept. Resolve a conflict by explicitly reloading the saved layout; no changes were retried.'
      );
      if (cause instanceof WorldValidationError) setIssues(cause.issues);
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const latest = await port.show(controller.signal);
      if (!controller.signal.aborted) {
        setSaved(latest);
        setHistory(undefined);
        clearError();
      }
    } catch {
      if (!controller.signal.aborted) setError('Reload failed. Your draft is still kept.');
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return {
    world,
    saved,
    editing: Boolean(history),
    dirty,
    busy,
    error,
    issues,
    change,
    save,
    reload,
    begin() {
      if (!request.current) {
        setHistory(worldHistory.create(saved.layout));
        clearError();
      }
    },
    cancel() {
      if (!request.current) {
        setHistory(undefined);
        clearError();
      }
    },
    undo() {
      if (history && !request.current) {
        setHistory(worldHistory.undo(history));
        clearError();
      }
    },
    redo() {
      if (history && !request.current) {
        setHistory(worldHistory.redo(history));
        clearError();
      }
    },
    canUndo: Boolean(history && history.cursor > 0),
    canRedo: Boolean(history && history.cursor + 1 < history.entries.length),
  };
}
