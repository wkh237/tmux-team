import { Link } from '@tanstack/react-router';
import { BlockPanel } from '../blocks/block-view.js';
import { ProfilePanel } from '../profiles/profile-view.js';
import { resolveAvatar } from '../avatars/avatar-catalog.js';
import { useLocalOffice } from './use-local-office.js';

export function LocalSpacePage({ identityId }: { identityId: string }) {
  const { load, refresh, profileChanged } = useLocalOffice();
  if (load.status === 'loading') return <p role="status">Opening your room…</p>;
  if (load.status === 'error')
    return (
      <section>
        <p role="alert">This room could not load.</p>
        <button onClick={refresh}>Try again</button>
        <Link to="/local">Back to office</Link>
      </section>
    );
  const profile = load.profiles.find((item) => item.identityId === identityId);
  if (!profile)
    return (
      <section>
        <h1>Room unavailable</h1>
        <p>This identity is no longer active.</p>
        <Link to="/local">Back to office</Link>
      </section>
    );
  const avatar = resolveAvatar(profile.profile.avatarRef, load.avatars);
  return (
    <section className="personal-space">
      <Link to="/local">← Back to office</Link>
      <h1>{profile.identityName}'s space</h1>
      {!profile.online && (
        <p className="offline-note">Offline — this identity is not shown as present in the room.</p>
      )}
      <BlockPanel
        worldId={identityId}
        blockPort={load.runtime.blocks}
        label={`${profile.identityName.toUpperCase()} / PERSONAL SPACE`}
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
      <ProfilePanel
        initial={profile}
        port={load.runtime.profiles}
        changed={profileChanged}
        avatarCatalog={load.avatars}
      />
    </section>
  );
}
