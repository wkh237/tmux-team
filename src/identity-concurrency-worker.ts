/* c8 ignore file */
import fs from 'node:fs';
import path from 'node:path';
import { createIdentityService } from './identity-service.js';
import type { PaneInfo, Paths, Tmux } from './types.js';

const [databaseFile, barrierDirectory, variant] = process.argv.slice(2);
if (!databaseFile || !barrierDirectory || !variant) throw new Error('Invalid worker arguments.');

const pane: PaneInfo = {
  id: '%race',
  command: 'mock-agent',
  panePid: 4242,
  suggestedName: null,
};
const tmux = {
  getCurrentPaneId: () => pane.id,
  resolvePaneTarget: (target: string) => (target === pane.id ? pane.id : null),
  getEndpointSnapshot: () => ({
    server: {
      serverId: 'race-server',
      socketPath: '/tmp/race-server',
      serverPid: 77,
      serverStartTime: 'race-start',
    },
    panes: [pane],
  }),
  setDurableIdentity: (_paneId: string, identity: any, binding: any) => {
    pane.metadata = {
      version: 1,
      globalIdentity: {
        name: identity.name,
        canonicalName: identity.canonicalName,
        identityId: identity.id,
        bindingId: binding.id,
        serverId: binding.serverId,
        panePid: binding.panePid,
      },
    };
  },
  listGlobalIdentities: () => [],
} as unknown as Tmux;
const paths = {
  globalDir: path.dirname(databaseFile),
  databaseFile,
} as Paths;

fs.writeFileSync(path.join(barrierDirectory, `ready-${variant}`), 'ready');
while (!fs.existsSync(path.join(barrierDirectory, 'go'))) {
  // A short synchronous wait keeps both real processes behind the same
  // barrier without introducing a test-only synchronization primitive.
  const until = Date.now() + 5;
  while (Date.now() < until) {}
}

const service = createIdentityService({ tmux, paths });
try {
  const identity = service.bindCurrent(variant === 'a' ? 'Ａｌｉｃｅ' : 'alice');
  process.stdout.write(JSON.stringify({ ok: true, id: identity.id }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  service.close();
}
