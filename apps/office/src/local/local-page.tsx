import { useContext, useEffect, useState } from 'react';
import { BlockPanel } from '../blocks/block-view.js';
import { LocalRuntimeContext } from './local-runtime.js';
import type { LocalBlockProjection } from './local-runtime.js';

export function LocalOfficePage() {
  const runtime = useContext(LocalRuntimeContext);
  const [blocks, setBlocks] = useState<LocalBlockProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    if (!runtime) return;
    void runtime
      .list()
      .then((items) => {
        if (!active) return;
        setBlocks(items);
        setSelected(items[0]?.blockId);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError('Local Office could not load. Rerun tmt office start.');
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);
  if (!runtime) return <p role="alert">This build does not provide the local Office runtime.</p>;
  if (loading) return <p>Loading your local office…</p>;
  if (error) return <p role="alert">{error}</p>;
  if (blocks.length === 0)
    return (
      <section>
        <h1>Your local office</h1>
        <p>
          No active agent block exists yet. Create one with{' '}
          <code>
            tmt office block apply --local --identity NAME --file layout.json --if-revision 0
          </code>
          .
        </p>
      </section>
    );
  const block = blocks.find((item) => item.blockId === selected) ?? blocks[0];
  return (
    <section>
      <h1>Your local office</h1>
      {blocks.length > 1 && (
        <label>
          Agent block
          <select value={block.blockId} onChange={(event) => setSelected(event.target.value)}>
            {blocks.map((item) => (
              <option key={item.blockId} value={item.blockId}>
                {item.identityName}
              </option>
            ))}
          </select>
        </label>
      )}
      <BlockPanel
        key={block.blockId}
        worldId={block.blockId}
        blockPort={runtime.blocks}
        label={`${block.identityName.toUpperCase()} / LOCAL BLOCK`}
      />
    </section>
  );
}
