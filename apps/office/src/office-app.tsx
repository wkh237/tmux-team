import { RouterProvider } from '@tanstack/react-router';
import { createStore, Provider } from 'jotai';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { createOfficeRouter } from './router.js';
import { OfficeSessionContext } from './auth/session-view.js';
import type { OfficeSession } from './auth/session.js';

export function OfficeApp({
  router,
  session,
}: {
  router: ReturnType<typeof createOfficeRouter>;
  session?: OfficeSession;
}): ReactElement {
  // A mounted app owns its UI state; tests and future embedded views cannot leak it.
  const [store] = useState(() => createStore());
  return (
    <Provider store={store}>
      <OfficeSessionContext value={session}>
        <RouterProvider router={router} />
      </OfficeSessionContext>
    </Provider>
  );
}
