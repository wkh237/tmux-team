import { useContext } from 'react';
import { LocalRuntimeContext } from '../local/local-runtime.js';
import type { LocalRuntime } from '../local/local-runtime.js';
import { usePreview } from '../local/use-preview.js';
import { IndexedProp } from './indexed-prop.js';

const requestPreview = (runtime: LocalRuntime, id: string) => runtime.preview(id);

export function PropPreviewPage({ previewId }: { previewId: string }) {
  const runtime = useContext(LocalRuntimeContext);
  const state = usePreview(runtime, previewId, requestPreview);
  if (state.kind === 'failed')
    return <p role="alert">This prop preview is unavailable or expired.</p>;
  if (state.kind === 'loading') return <p>Loading prop preview…</p>;
  const catalog = state.value;
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
