import { RouterProvider } from '@tanstack/react-router';
import { createStore, Provider } from 'jotai';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { createOfficeRouter } from './router.js';
import { OfficeSessionContext, OfficeModeContext } from './auth/session-view.js';
import type { OfficeSession } from './auth/session.js';
import { WorldContext } from './worlds/world-view.js';
import type { WorldState } from './worlds/world-state.js';

export function OfficeApp({
  router,
  session,
  worlds,
  mode = 'emulator',
}: {
  router: ReturnType<typeof createOfficeRouter>;
  session?: OfficeSession;
  worlds?: WorldState;
  mode?: string;
}): ReactElement {
  // A mounted app owns its UI state; tests and future embedded views cannot leak it.
  const [store] = useState(() => createStore());
  return (
    <Provider store={store}>
      <OfficeSessionContext value={session}>
        <OfficeModeContext value={mode}>
          <WorldContext value={worlds}>
            <RouterProvider router={router} />
          </WorldContext>
        </OfficeModeContext>
      </OfficeSessionContext>
    </Provider>
  );
}
