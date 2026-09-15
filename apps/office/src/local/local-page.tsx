import { Link } from '@tanstack/react-router';
import { useId, useMemo, useRef, useState } from 'react';
import { resolveAvatar } from '../avatars/avatar-catalog.js';
import { useLocalOffice } from './use-local-office.js';
import { OfficeCanvas } from './office-canvas.js';
import { officeSceneModel } from './office-scene-model.js';
import '../blocks/block.css';
import './office-floor.css';

export function LocalOfficePage() {
  const { load, refresh } = useLocalOffice();
  const [selectedId, selectRoom] = useState<string>();
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const directoryId = useId();
  const directoryToggle = useRef<HTMLButtonElement>(null);
  const directoryTriggers = useRef(new Map<string, HTMLButtonElement>());
  const sceneModel = useMemo(
    () =>
      load.status === 'ready'
        ? officeSceneModel(load.profiles, load.blocks, load.avatars, load.props)
        : undefined,
    [load]
  );
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  function closeDetails() {
    selectRoom(undefined);
    (directoryOpen ? selectionTrigger.current : directoryToggle.current)?.focus();
  }
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
  const selected = load.profiles.find((profile) => profile.identityId === selectedId);
  return (
    <section
      className="office-overview"
      aria-label="Office overview"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected) {
          event.stopPropagation();
          closeDetails();
        }
      }}
    >
      <div className="office-heading">
        <div>
          <p className="eyebrow">A LITTLE SPACE FOR BIG IDEAS</p>
          <h1>Your office</h1>
          <p>Different minds. One place to make things.</p>
        </div>
        <button onClick={refresh}>Refresh office</button>
        <button
          ref={directoryToggle}
          aria-expanded={directoryOpen}
          aria-controls={directoryId}
          onClick={() => setDirectoryOpen(!directoryOpen)}
        >
          Agents · {load.profiles.length}
        </button>
      </div>
      <div className="office-workspace">
        {sceneModel && (
          <OfficeCanvas
            model={sceneModel}
            selectedId={selected?.identityId}
            select={(id) => {
              selectionTrigger.current = directoryTriggers.current.get(id) ?? null;
              selectRoom(id);
            }}
          />
        )}
        <div className="office-floor" id={directoryId} hidden={!directoryOpen}>
          <div className="office-corridor">
            <span className="office-building-sign">
              TMT WORKSHOP <small>LOCAL OFFICE / FLOOR 01</small>
            </span>
            <span>
              {load.profiles.length} {load.profiles.length === 1 ? 'space' : 'spaces'} · {online}{' '}
              online
            </span>
          </div>
          {load.profiles.length === 0 ? (
            <div className="office-empty">
              <h2>Your first room starts with an identity.</h2>
              <p>
                Create a saved identity, then refresh this office. No room is saved until you
                furnish it.
              </p>
              <code>tmt identity create alice</code>
            </div>
          ) : (
            <div className="office-rooms">
              {load.profiles.map((profile, index) => {
                const block = rooms.get(profile.identityId);
                const avatar = resolveAvatar(profile.profile.avatarRef, load.avatars);
                return (
                  <article
                    className={`office-room ${selectedId === profile.identityId ? 'is-selected' : ''}`}
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
                    <button
                      className="room-select"
                      ref={(element) => {
                        if (element) directoryTriggers.current.set(profile.identityId, element);
                        else directoryTriggers.current.delete(profile.identityId);
                      }}
                      aria-label={`Select ${profile.identityName}'s room`}
                      aria-pressed={selectedId === profile.identityId}
                      aria-controls={
                        selectedId === profile.identityId ? 'office-room-details' : undefined
                      }
                      onClick={(event) => {
                        selectionTrigger.current = event.currentTarget;
                        selectRoom(profile.identityId);
                      }}
                    >
                      Inspect space
                    </button>
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
          )}
          <div className="office-corridor office-lobby">
            <div>
              <span className="eyebrow">MEET AT THE COMMONS</span>
              <h2>Good ideas don’t stay at your desk.</h2>
              <p>Leave a discovery. Share a work in progress. Say hello.</p>
            </div>
            <Link to="/local/board">
              Visit the board <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
        {selected && (
          <aside id="office-room-details" className="office-inspector" aria-label="Room details">
            <button
              className="inspector-close"
              aria-label="Close room details"
              onClick={closeDetails}
            >
              ×
            </button>
            <p className="eyebrow">SELECTED SPACE</p>
            <h2>{selected.identityName}</h2>
            <p className="inspector-presence">
              {selected.online ? 'Online · in the office' : 'Offline · their space is still here'}
            </p>
            {selected.profile.displayLabel && <p>{selected.profile.displayLabel}</p>}
            <p>
              {rooms.has(selected.identityId)
                ? 'A saved layout, ready to make your own.'
                : 'This space is ready. Nothing is saved until you save a layout.'}
            </p>
            <Link to="/local/agents/$identityId" params={{ identityId: selected.identityId }}>
              Customize this space →
            </Link>
            <div className="office-inspector-note">
              <span aria-hidden="true">⌂</span>
              <p>Your office stays on this computer. Exploring does not change anyone’s space.</p>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
