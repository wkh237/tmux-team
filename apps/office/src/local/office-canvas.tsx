import { useEffect, useRef, useState } from 'react';
import type {
  OfficeSceneModel,
  OfficeSceneEditor,
  createOfficeScene,
} from '../rendering/office-scene.js';

type Scene = NonNullable<Awaited<ReturnType<typeof createOfficeScene>>>;

export function OfficeCanvas({
  model,
  selectedId,
  select,
  editor,
}: {
  model: OfficeSceneModel;
  selectedId?: string;
  select: (identityId: string) => void;
  editor?: OfficeSceneEditor;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | undefined>(undefined);
  const latest = useRef({ model, selectedId, select, editor });
  const synchronize = useRef(() => {});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    latest.current = { model, selectedId, select, editor };
    synchronize.current();
  }, [model, selectedId, select, editor]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const controller = new AbortController();
    let applied: typeof latest.current | undefined;
    function fail() {
      if (controller.signal.aborted) return;
      scene.current = undefined;
      controller.abort();
      setReady(false);
      setError(true);
    }
    function flush() {
      const current = scene.current;
      if (!current || controller.signal.aborted || document.hidden) return;
      const next = latest.current;
      try {
        if (applied?.model !== next.model) current.update(next.model);
        if (!applied || applied.selectedId !== next.selectedId) current.selection(next.selectedId);
        if (!applied || applied.editor !== next.editor) current.editing(next.editor);
        applied = next;
        setReady(true);
      } catch {
        fail();
      }
    }
    synchronize.current = flush;
    document.addEventListener('visibilitychange', flush);
    void import('../rendering/office-scene.js')
      .then(({ createOfficeScene }) =>
        createOfficeScene(element, controller.signal, (id) => latest.current.select(id))
      )
      .then((created) => {
        if (!created) return;
        if (controller.signal.aborted) {
          created.dispose();
          return;
        }
        scene.current = created;
        flush();
      })
      .catch(fail);
    return () => {
      synchronize.current = () => {};
      document.removeEventListener('visibilitychange', flush);
      controller.abort();
      scene.current = undefined;
    };
  }, []);
  return (
    <div className="office-map" data-scene-ready={ready}>
      <div
        ref={host}
        className="office-canvas"
        role="img"
        aria-label="Office map. Drag to pan; scroll to zoom. Use the agent directory for keyboard selection."
      />
      {!ready && (
        <p className="scene-status" role={error ? 'alert' : 'status'}>
          {error
            ? 'The map could not initialize. Your rooms are still accessible from the agent directory.'
            : 'Opening the workshop…'}
        </p>
      )}
      {ready && (
        <button className="scene-fit" onClick={() => scene.current?.fit()}>
          Fit office
        </button>
      )}
    </div>
  );
}
