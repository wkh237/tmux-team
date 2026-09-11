import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  useLocation,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { OfficeShell } from './shell.js';
import { HomePage } from './pages/home.js';
import { SetupPage } from './pages/setup.js';
import { SelectedWorld, WorldGate } from './worlds/world-view.js';
import { PairingPanel } from './pairing/pairing-view.js';

const rootRoute = createRootRoute({
  component: OfficeShell,
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <p>This address is not part of the Office preview.</p>
      <Link to="/">Return to Office</Link>
    </section>
  ),
});

const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/worlds/$worldId',
  component: WorldPage,
});
function WorldPage() {
  const { worldId } = worldRoute.useParams();
  return <WorldGate>{(state) => <SelectedWorld state={state} id={worldId} />}</WorldGate>;
}

const pairingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/worlds/$worldId/pair',
  component: PairingPage,
});
function PairingPage() {
  const { worldId } = pairingRoute.useParams();
  const fragment = useLocation({ select: (location) => location.hash });
  return (
    <WorldGate>
      {(state) => (
        <SelectedWorld state={state} id={worldId}>
          {(world) => (
            <PairingPanel worldId={world.id} ownerUid={world.ownerUid} fragment={fragment} />
          )}
        </SelectedWorld>
      )}
    </WorldGate>
  );
}

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage }),
  worldRoute,
  pairingRoute,
]);

export function createOfficeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createOfficeRouter>;
  }
}
