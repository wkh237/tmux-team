import { Link, Outlet } from '@tanstack/react-router';
import { atom, useAtom } from 'jotai';
import type { ReactElement } from 'react';
import { SessionPanel } from './auth/session-view.js';

const showPreviewNotesAtom = atom(false);

export function OfficeShell(): ReactElement {
  const [showNotes, setShowNotes] = useAtom(showPreviewNotesAtom);
  return (
    <div className="office-shell">
      <a className="skip-link" href="#main">
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
        <span className="preview-badge">Local preview</span>
      </header>
      <main id="main">
        <SessionPanel />
        <Outlet />
      </main>
      <footer>
        <span>No cloud connection · No agents connected</span>
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
            This shell does not create a world, read local TMT data or send work to agents. Local
            sign-in is available only in explicit emulator mode.
          </p>
        )}
      </footer>
    </div>
  );
}
