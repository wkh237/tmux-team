import { deleteApp, initializeApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  connectAuthEmulator,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { createSession } from './session.js';
import type { OfficeSession } from './session.js';

/** Called by the entry point, never during a React render or with cloud credentials. */
export function startOfficeSession(mode: string, hostname: string): OfficeSession | undefined {
  if (mode !== 'emulator') return undefined;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error('Local sign-in is only available on loopback.');
  }
  const app = initializeApp(
    {
      apiKey: 'demo-tmt-office',
      projectId: 'demo-tmt-office',
      authDomain: 'demo-tmt-office.firebaseapp.com',
    },
    `office-${crypto.randomUUID()}`
  );
  const auth = initializeAuth(app, {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  connectAuthEmulator(auth, 'http://127.0.0.1:9099');
  return createSession({
    observe: (changed) =>
      onAuthStateChanged(auth, (user) =>
        changed(user ? { uid: user.uid, displayName: user.displayName } : null)
      ),
    signIn: async () => {
      await signInWithPopup(auth, new GoogleAuthProvider());
    },
    signOut: () => signOut(auth),
    dispose: () => deleteApp(app),
  });
}
