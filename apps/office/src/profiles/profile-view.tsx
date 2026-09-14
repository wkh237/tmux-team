import { useEffect, useState } from 'react';
import type { Profile, ProfilePort, ProfileSnapshot } from './profile-contract.js';
import { PROFILE_CATALOG, ProfileConflict, validProfile } from './profile-contract.js';
import { Avatar } from './avatar.js';
import './profile.css';

const draftKey = (id: string) => `tmt-office-profile-draft:${id}`;
const fieldLabel = {
  hairStyle: 'Hair style',
  hairColor: 'Hair color',
  skinTone: 'Skin tone',
  shirtColor: 'Shirt color',
} as const;
function restoredDraft(snapshot: ProfileSnapshot): Profile {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(draftKey(snapshot.identityId)) ?? 'null'
    );
    return validProfile(value) ? value : snapshot.profile;
  } catch {
    return snapshot.profile;
  }
}
export function ProfilePanel({
  initial,
  port,
  changed,
}: {
  initial: ProfileSnapshot;
  port: ProfilePort;
  changed(snapshot: ProfileSnapshot): void;
}) {
  const [remote, setRemote] = useState(initial);
  const [draft, setDraft] = useState<Profile>(() => restoredDraft(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setRemote(initial);
    setDraft(restoredDraft(initial));
  }, [initial]);
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(remote.profile))
      localStorage.removeItem(draftKey(initial.identityId));
    else localStorage.setItem(draftKey(initial.identityId), JSON.stringify(draft));
  }, [draft, initial.identityId, remote.profile]);
  const setAppearance = (key: keyof Profile['appearance'], value: string) =>
    setDraft((current) => ({ ...current, appearance: { ...current.appearance, [key]: value } }));
  async function save() {
    if (!validProfile(draft) || busy) {
      setError('Keep profile text within the limits and choose catalog values.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = await port.apply(initial.identityId, remote.revision, draft);
      setRemote(saved);
      setDraft(saved.profile);
      localStorage.removeItem(draftKey(initial.identityId));
      changed(saved);
    } catch (cause) {
      if (cause instanceof ProfileConflict) setError(cause.message);
      else
        setError('Save could not be confirmed. Your draft is preserved; reread before retrying.');
      try {
        const latest = await port.show(initial.identityId);
        setRemote(latest);
        changed(latest);
      } catch {
        /* draft remains authoritative locally when reread also fails */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="profile-editor" aria-label="Agent appearance editor">
      <div className="profile-preview">
        <svg viewBox="-8 -7 16 15" role="img">
          <Avatar appearance={draft.appearance} name={remote.identityName} />
        </svg>
        <p>
          {remote.exists
            ? `Saved · revision ${remote.revision}`
            : 'Deterministic default · revision 0'}
        </p>
      </div>
      <div className="profile-fields">
        <label>
          Display label
          <input
            value={draft.displayLabel}
            onChange={(event) => setDraft({ ...draft, displayLabel: event.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <div className="profile-options">
          {(['hairStyle', 'hairColor', 'skinTone', 'shirtColor'] as const).map((key) => (
            <label key={key}>
              {fieldLabel[key]}
              <select
                value={draft.appearance[key]}
                onChange={(event) => setAppearance(key, event.target.value)}
              >
                {PROFILE_CATALOG[
                  `${key}s` as 'hairStyles' | 'hairColors' | 'skinTones' | 'shirtColors'
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label>
          Shirt mark
          <input
            value={draft.appearance.shirtMark}
            onChange={(event) => setAppearance('shirtMark', event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="profile-actions">
          <button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save appearance'}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setDraft(remote.profile);
              localStorage.removeItem(draftKey(initial.identityId));
              setError(undefined);
            }}
          >
            Discard draft
          </button>
        </div>
      </div>
    </section>
  );
}
