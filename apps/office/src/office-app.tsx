import { RouterProvider } from '@tanstack/react-router';
import { createStore, Provider } from 'jotai';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { createOfficeRouter } from './router.js';
import { OfficeSessionContext, OfficeModeContext } from './auth/session-view.js';
import type { OfficeSession } from './auth/session.js';
import { WorldContext } from './worlds/world-view.js';
import type { WorldState } from './worlds/world-state.js';
import { BlockContext } from './blocks/block-view.js';
import type { BlockPort } from './blocks/block-contract.js';

export function OfficeApp({
  router,
  session,
  worlds,
  blocks,
  mode = 'emulator',
}: {
  router: ReturnType<typeof createOfficeRouter>;
  session?: OfficeSession;
  worlds?: WorldState;
  blocks?: BlockPort;
  mode?: string;
}): ReactElement {
  // A mounted app owns its UI state; tests and future embedded views cannot leak it.
  const [store] = useState(() => createStore());
  return (
    <Provider store={store}>
      <OfficeSessionContext value={session}>
        <OfficeModeContext value={mode}>
          <WorldContext value={worlds}>
            <BlockContext value={blocks}>
              <RouterProvider router={router} />
            </BlockContext>
          </WorldContext>
        </OfficeModeContext>
      </OfficeSessionContext>
    </Provider>
  );
}
