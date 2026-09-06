/* c8 ignore file */
import fs from 'node:fs';
import path from 'node:path';
import { createIdentityService } from '../../identity-service.js';
import { openIdentityRepository } from '../../storage/identity-repository.js';
import type { PaneInfo, Tmux } from '../../types.js';
import { waitForBarrier } from './barrier.js';

const [databaseFile, barrierDirectory, variant, mode = 'bind'] = process.argv.slice(2);
if (!databaseFile || !barrierDirectory || !variant) throw new Error('Invalid worker arguments.');
if (mode !== 'bind' && mode !== 'create') throw new Error('Invalid worker mode.');

const BARRIER_TIMEOUT_MS = 30_000;

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
} as unknown as Tmux;
fs.writeFileSync(path.join(barrierDirectory, `ready-${variant}`), 'ready');
waitForBarrier(path.join(barrierDirectory, 'go'), BARRIER_TIMEOUT_MS);

const repository = openIdentityRepository(databaseFile);
try {
  const service = createIdentityService({ tmux, repository });
  // The fullwidth spelling and its ASCII equivalent share the NFKC key.
  const name = variant === 'a' ? 'Ａｌｉｃｅ' : 'alice';
  if (mode === 'create') {
    const result = service.createIdentity(name);
    process.stdout.write(
      JSON.stringify({ ok: true, id: result.identity.id, created: result.created }) + '\n'
    );
  } else {
    const identity = service.bindCurrent(name);
    process.stdout.write(JSON.stringify({ ok: true, id: identity.id }) + '\n');
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  repository.close();
}
