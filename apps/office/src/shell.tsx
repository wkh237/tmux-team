import { Link, Outlet } from '@tanstack/react-router';
import { atom, useAtom } from 'jotai';
import { useContext } from 'react';
import type { ReactElement } from 'react';
import { SessionPanel, OfficeModeContext, OfficeSessionContext } from './auth/session-view.js';

const showPreviewNotesAtom = atom(false);

export function OfficeShell(): ReactElement {
  const [showNotes, setShowNotes] = useAtom(showPreviewNotesAtom);
  const session = useContext(OfficeSessionContext);
  const mode = useContext(OfficeModeContext);
  return (
    <div className="office-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header>
        <Link className="brand" to="/">
          tmt <span>office</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/" activeOptions={{ exact: true }}>
            Office
          </Link>
          <Link to="/setup">Setup</Link>
        </nav>
        <span className="preview-badge">
          {session ? (mode === 'cloud' ? 'Private pilot' : 'Local emulator') : 'Local preview'}
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        <SessionPanel />
        <Outlet />
      </main>
      <footer>
        <span>
          {session && mode === 'cloud' ? 'Cloud pilot' : 'No cloud connection'} · No agents
          connected
        </span>
        <button
          type="button"
          aria-expanded={showNotes}
          aria-controls="preview-notes"
          onClick={() => setShowNotes((visible) => !visible)}
        >
          Preview details
        </button>
        {showNotes && (
          <p id="preview-notes">
            {session
              ? 'Approved users can create private worlds. No local TMT data or agent execution is connected.'
              : 'This shell does not create a world, read local TMT data or send work to agents. Choose an explicit connected mode to sign in.'}
          </p>
        )}
      </footer>
    </div>
  );
}
