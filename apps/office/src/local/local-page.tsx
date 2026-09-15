import { Link } from '@tanstack/react-router';
import { BlockScene } from '../blocks/block-scene.js';
import { resolveAvatar } from '../avatars/avatar-catalog.js';
import { useLocalOffice } from './use-local-office.js';
import '../blocks/block.css';
import './office-floor.css';

export function LocalOfficePage() {
  const { load, refresh } = useLocalOffice();
  if (load.status === 'loading') return <p role="status">Opening your office…</p>;
  if (load.status === 'error')
    return (
      <section>
        <h1>Your office</h1>
        <p role="alert">Local Office could not load. Check the service or try again.</p>
        <button onClick={refresh}>Try again</button>
      </section>
    );
  const rooms = new Map(load.blocks.map((block) => [block.identityId, block]));
  const online = load.profiles.filter((profile) => profile.online).length;
  return (
    <section className="office-overview" aria-label="Office overview">
      <div className="office-heading">
        <div>
          <p className="eyebrow">YOUR TEAM / ONE PLACE</p>
          <h1>Your office</h1>
          <p>Pick a room. Make it yours.</p>
        </div>
        <button onClick={refresh}>Refresh office</button>
      </div>
      {load.profiles.length === 0 ? (
        <div className="office-empty">
          <h2>Your first room starts with an identity.</h2>
          <p>
            Create a saved identity, then refresh this office. No room is saved until you furnish
            it.
          </p>
          <code>tmt identity create alice</code>
        </div>
      ) : (
        <div className="office-floor">
          <div className="office-corridor">
            <span>TMT / LOCAL OFFICE</span>
            <span>
              {load.profiles.length} {load.profiles.length === 1 ? 'space' : 'spaces'} · {online}{' '}
              online
            </span>
          </div>
          <div className="office-rooms">
            {load.profiles.map((profile, index) => {
              const block = rooms.get(profile.identityId);
              const avatar = resolveAvatar(profile.profile.avatarRef, load.avatars);
              return (
                <article
                  className="office-room"
                  key={profile.identityId}
                  aria-label={`${profile.identityName}'s room`}
                >
                  <div className="room-nameplate">
                    <span className="room-number">{String(index + 1).padStart(2, '0')}</span>
                    <h2>{profile.identityName}</h2>
                    <span className={`room-presence ${profile.online ? 'is-online' : ''}`}>
                      {profile.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <BlockScene
                    objects={block?.layout.objects ?? []}
                    catalog={load.props}
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
                  <div className="room-doorway">
                    <span>
                      {block
                        ? `${block.layout.objects.length} ${block.layout.objects.length === 1 ? 'piece' : 'pieces'} · saved`
                        : 'Unfurnished · not saved'}
                    </span>
                    <Link
                      to="/local/agents/$identityId"
                      params={{ identityId: profile.identityId }}
                      aria-label={`Enter ${profile.identityName}'s room`}
                    >
                      Enter room <span aria-hidden="true">↗</span>
                    </Link>
                  </div>
                  {avatar.status === 'unavailable' && (
                    <p className="room-art-note">
                      Selected avatar unavailable; saved default appearance retained.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          <div className="office-corridor office-lobby">
            <span>THE COMMONS</span>
            <Link to="/local/board">
              Visit the board <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
