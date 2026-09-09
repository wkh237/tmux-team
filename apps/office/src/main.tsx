import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeApp } from './office-app.js';
import { createOfficeRouter } from './router.js';
import './styles.css';
import type { OfficeSession } from './auth/session.js';

const root = document.getElementById('root');
if (!root) throw new Error('Office root element is missing.');

const app = createRoot(root);
let session: OfficeSession | undefined;
let active = true;
import.meta.hot?.dispose(() => {
  active = false;
  app.unmount();
  void session?.dispose();
});

async function mount(): Promise<void> {
  try {
    // Vite removes this branch (and the SDK chunk) from the default build.
    if (import.meta.env.MODE === 'emulator') {
      const { startOfficeSession } = await import('./auth/firebase-session.js');
      if (!active) return;
      session = startOfficeSession(import.meta.env.MODE, location.hostname);
    }
  } catch {
    if (active)
      app.render(
        <p role="alert">
          Office could not initialize local sign-in. Use a loopback hostname and reload.
        </p>
      );
    return;
  }
  app.render(
    <StrictMode>
      <OfficeApp router={createOfficeRouter()} session={session} />
    </StrictMode>
  );
}

void mount();
