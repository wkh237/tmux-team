import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { FURNITURE, OBJECT_LIMIT } from './block-contract.js';
import type { Asset, BlockPort, Furniture } from './block-contract.js';
import { createBlockState } from './block-state.js';
import type { BlockState } from './block-state.js';
import { BlockScene } from './block-scene.js';
import './block.css';

export const BlockContext = createContext<BlockPort | undefined>(undefined);
export function BlockPanel({
  worldId,
  blockPort,
  label,
}: {
  worldId: string;
  blockPort?: BlockPort;
  label?: string;
}) {
  const defaultPort = useContext(BlockContext);
  const port = blockPort ?? defaultPort;
  const [state, setState] = useState<BlockState>();
  useEffect(() => {
    if (!port) return;
    const next = createBlockState(port, worldId);
    setState(next);
    return () => next.dispose();
  }, [port, worldId]);
  return state ? <BlockEditor state={state} label={label} /> : null;
}
export function BlockEditor({
  state,
  label = 'YOUR SPACE / HOME BLOCK',
}: {
  state: BlockState;
  label?: string;
}) {
  const { remote, draft, ready, busy, error } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot
  );
  const [selected, setSelected] = useState<number | null>(null);
  const objects = draft?.objects ?? remote?.objects ?? [];
  const item = selected === null ? undefined : objects[selected];
  function update(changes: Partial<Furniture>) {
    if (!item) return;
    state.edit(
      objects.map((value, index) => (index === selected ? { ...value, ...changes } : value))
    );
  }
  function add(asset: Asset) {
    state.edit([...objects, { asset, x: 14, y: 14, rotation: 0 }]);
    setSelected(objects.length);
  }
  return (
    <section className="block-editor" aria-label="Office block editor">
      <div className="block-heading">
        <div>
          <p className="eyebrow">{label}</p>
          <h2>Make room for your team.</h2>
        </div>
        <span role="status">
          {!ready
            ? error
              ? 'Block unavailable'
              : 'Connecting…'
            : busy
              ? 'Saving…'
              : draft
                ? 'Unsaved changes'
                : remote
                  ? `Saved · revision ${remote.revision}`
                  : 'No saved layout yet'}
        </span>
      </div>
      {error && <p role="alert">{error}</p>}
      {ready && (
        <div className="block-workbench">
          <BlockScene
            objects={objects}
            selected={selected}
            select={setSelected}
            move={(x, y) => update({ x, y })}
          />
          <aside className="block-tools" aria-label="Furniture controls">
            <h3>Small things, your space.</h3>
            <p>
              Add a piece, then select a tile to move it. Nothing is saved until you choose Save.
            </p>
            <div className="furniture-catalog">
              {(Object.keys(FURNITURE) as Asset[]).map((asset) => (
                <button
                  key={asset}
                  disabled={busy || objects.length >= OBJECT_LIMIT}
                  onClick={() => add(asset)}
                >
                  Add {FURNITURE[asset].label.toLowerCase()}
                </button>
              ))}
            </div>
            <p>
              {objects.length} / {OBJECT_LIMIT} pieces · 32 × 32 tiles
            </p>
            <ol className="furniture-list">
              {objects.map((object, index) => (
                <li key={index}>
                  <button aria-pressed={selected === index} onClick={() => setSelected(index)}>
                    {FURNITURE[object.asset].label} {index + 1}
                  </button>
                </li>
              ))}
            </ol>
            {item && (
              <fieldset disabled={busy}>
                <legend>Selected {item.asset}</legend>
                <label>
                  Tile X
                  <input
                    type="number"
                    min="0"
                    max="31"
                    value={item.x}
                    onChange={(event) => update({ x: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Tile Y
                  <input
                    type="number"
                    min="0"
                    max="31"
                    value={item.y}
                    onChange={(event) => update({ y: Number(event.target.value) })}
                  />
                </label>
                <button onClick={() => update({ rotation: (item.rotation + 1) % 4 })}>
                  Rotate clockwise
                </button>
                <button
                  onClick={() => {
                    state.edit(objects.filter((_, index) => index !== selected));
                    setSelected(null);
                  }}
                >
                  Remove selected
                </button>
              </fieldset>
            )}
            <div className="block-actions">
              <button
                className="block-save"
                disabled={busy || !draft}
                onClick={() => void state.save()}
              >
                Save layout
              </button>
              <button
                disabled={busy || !draft}
                onClick={() => {
                  state.reset();
                  setSelected(null);
                }}
              >
                Load latest layout
              </button>
            </div>
            <p className="block-note">
              Private to your office. Only the owner and an explicitly assigned agent can access
              this block.
            </p>
          </aside>
        </div>
      )}
    </section>
  );
}
