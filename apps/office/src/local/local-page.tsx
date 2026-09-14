import { useContext, useEffect, useState } from 'react';
import { BlockPanel } from '../blocks/block-view.js';
import { LocalRuntimeContext } from './local-runtime.js';
import type { LocalBlockProjection } from './local-runtime.js';
import type { ProfileProjection, ProfileSnapshot } from '../profiles/profile-contract.js';
import { ProfilePanel } from '../profiles/profile-view.js';

export function LocalOfficePage() {
  const runtime = useContext(LocalRuntimeContext);
  const [blocks, setBlocks] = useState<LocalBlockProjection[]>([]);
  const [profiles, setProfiles] = useState<ProfileProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    if (!runtime) return;
    void Promise.all([runtime.list(), runtime.profiles.list()])
      .then(([items, identities]) => {
        if (!active) return;
        setBlocks(items);
        setProfiles(identities);
        setSelected(identities[0]?.identityId);
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
  if (profiles.length === 0)
    return (
      <section>
        <h1>Your local office</h1>
        <p>
          No active identity exists yet. Create or bind one with <code>tmt name NAME</code>.
        </p>
      </section>
    );
  const profile = profiles.find((item) => item.identityId === selected) ?? profiles[0];
  const block = blocks.find((item) => item.identityId === profile.identityId);
  function profileChanged(snapshot: ProfileSnapshot) {
    setProfiles((items) =>
      items.map((item) =>
        item.identityId === snapshot.identityId ? { ...snapshot, online: item.online } : item
      )
    );
  }
  return (
    <section>
      <h1>Your local office</h1>
      {profiles.length > 1 && (
        <label>
          Agent identity
          <select value={profile.identityId} onChange={(event) => setSelected(event.target.value)}>
            {profiles.map((item) => (
              <option key={item.identityId} value={item.identityId}>
                {item.identityName}
                {item.online ? '' : ' · offline'}
              </option>
            ))}
          </select>
        </label>
      )}
      {!profile.online && (
        <p className="offline-note">
          Offline — this saved identity is not shown as present in the room.
        </p>
      )}
      <ProfilePanel
        key={profile.identityId}
        initial={profile}
        port={runtime.profiles}
        changed={profileChanged}
      />
      {block ? (
        <BlockPanel
          key={block.blockId}
          worldId={block.blockId}
          blockPort={runtime.blocks}
          label={`${block.identityName.toUpperCase()} / LOCAL BLOCK`}
          avatar={
            profile.online
              ? {
                  appearance: profile.profile.appearance,
                  name: profile.identityName,
                  displayLabel: profile.profile.displayLabel,
                }
              : undefined
          }
        />
      ) : (
        <p>
          This identity has no saved layout. Create one with{' '}
          <code>
            tmt office block apply --local --identity NAME --file layout.json --if-revision 0
          </code>
          .
        </p>
      )}
    </section>
  );
}
