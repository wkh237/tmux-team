import { useState } from 'react';
import type { CatalogPack } from '../props/prop-contract.js';
import { PropThumbnail } from '../props/prop-thumbnail.js';

/** Browse the admitted catalog; choosing art still belongs to the world draft. */
export function WorldArtLibrary({
  catalog,
  choose,
}: {
  catalog: CatalogPack[];
  choose: (pack: CatalogPack, key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const groups = catalog
    .map((entry) => ({
      entry,
      props: entry.pack.props.filter((prop) => {
        const text = `${entry.pack.label} ${prop.label}`.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      }),
    }))
    .filter((group) => group.props.length > 0);
  return (
    <>
      <label>
        Search objects
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try desk, plant or window"
        />
      </label>
      {groups.length === 0 && (
        <div role="status">
          <p>No matching objects.</p>
          <button onClick={() => setQuery('')}>Clear search</button>
        </div>
      )}
      {groups.map(({ entry, props }) => (
        <div key={entry.digest}>
          <h4>{entry.pack.label}</h4>
          <div className="world-art-options">
            {props.map((prop) => (
              <button
                key={prop.key}
                className="world-art-option"
                onClick={() => choose(entry, prop.key)}
              >
                <PropThumbnail pack={entry.pack} prop={prop} />
                <span>{prop.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
