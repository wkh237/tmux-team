import { useContext, useEffect, useState } from 'react';
import { LocalRuntimeContext } from '../local/local-runtime.js';
import type { CatalogPack } from './prop-contract.js';
import { IndexedProp } from './indexed-prop.js';

export function PropPreviewPage({ previewId }: { previewId: string }) {
  const runtime = useContext(LocalRuntimeContext);
  const [catalog, setCatalog] = useState<CatalogPack>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!runtime) return;
    void runtime
      .preview(previewId)
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [previewId, runtime]);
  if (!runtime || failed) return <p role="alert">This prop preview is unavailable or expired.</p>;
  if (!catalog) return <p>Loading prop preview…</p>;
  return (
    <section className="prop-preview">
      <p className="eyebrow">DATA-ONLY PROP PREVIEW</p>
      <h1>{catalog.pack.label}</h1>
      <p>
        {catalog.pack.credit} · {catalog.pack.license}
      </p>
      <div className="prop-preview-grid">
        {catalog.pack.props.map((prop) => (
          <article key={prop.key}>
            <svg
              viewBox={`0 0 ${prop.footprint.width} ${prop.footprint.height}`}
              role="img"
              aria-label={prop.label}
            >
              <IndexedProp pack={catalog.pack} prop={prop} />
            </svg>
            <h2>{prop.label}</h2>
            <p>
              {prop.footprint.width} × {prop.footprint.height} tiles
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
