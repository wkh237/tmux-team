import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { OfficeShell } from './shell.js';
import { HomePage } from './pages/home.js';
import { SetupPage } from './pages/setup.js';

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

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/setup', component: SetupPage }),
]);

export function createOfficeRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createOfficeRouter>;
  }
}
