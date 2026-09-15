import { useContext, useEffect, useState } from 'react';
import { BlockPanel } from '../blocks/block-view.js';
import { LocalRuntimeContext } from './local-runtime.js';
import type { LocalBlockProjection, LocalRuntime } from './local-runtime.js';
import type { ProfileProjection, ProfileSnapshot } from '../profiles/profile-contract.js';
import { ProfilePanel } from '../profiles/profile-view.js';
import type { AvatarCatalog } from '../avatars/avatar-catalog.js';
import { resolveAvatar } from '../avatars/avatar-catalog.js';

type LocalLoadState =
  | { status: 'loading'; runtime: LocalRuntime | undefined }
  | {
      status: 'ready';
      runtime: LocalRuntime;
      blocks: LocalBlockProjection[];
      profiles: ProfileProjection[];
      avatarCatalog: AvatarCatalog;
    }
  | { status: 'error'; runtime: LocalRuntime };

export function LocalOfficePage() {
  const runtime = useContext(LocalRuntimeContext);
  const [load, setLoad] = useState<LocalLoadState>({ status: 'loading', runtime });
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    let active = true;
    if (!runtime) return;
    setLoad({ status: 'loading', runtime });
    setSelected(undefined);
    void Promise.all([runtime.list(), runtime.profiles.list(), runtime.avatars.list()])
      .then(([items, identities, avatars]) => {
        if (!active) return;
        setLoad({
          status: 'ready',
          runtime,
          blocks: items,
          profiles: identities,
          avatarCatalog: avatars,
        });
        setSelected(identities[0]?.identityId);
      })
      .catch(() => {
        if (active) setLoad({ status: 'error', runtime });
      });
    return () => {
      active = false;
    };
  }, [runtime]);
  if (!runtime) return <p role="alert">This build does not provide the local Office runtime.</p>;
  if (load.runtime !== runtime || load.status === 'loading')
    return <p>Loading your local office…</p>;
  if (load.status === 'error')
    return <p role="alert">Local Office could not load. Rerun tmt office start.</p>;
  const { blocks, profiles, avatarCatalog } = load;
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
  const avatar = resolveAvatar(profile.profile.avatarRef, avatarCatalog);
  function profileChanged(snapshot: ProfileSnapshot) {
    setLoad((current) =>
      current.status === 'ready' && current.runtime === runtime
        ? {
            ...current,
            profiles: current.profiles.map((item) =>
              item.identityId === snapshot.identityId ? { ...snapshot, online: item.online } : item
            ),
          }
        : current
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
        avatarCatalog={avatarCatalog}
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
                  customArt: avatar.status === 'available' ? avatar.art : undefined,
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
