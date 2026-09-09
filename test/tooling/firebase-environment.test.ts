import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('Firebase configuration isolation', () => {
  it('ignores local settings and secrets but keeps shared setup trackable', () => {
    const ignored = [
      '.firebaserc',
      'services/office/.firebaserc',
      'services/office/.env.local',
      'apps/office/.env.production',
      'services/office/.firebase/cache.json',
      'services/office/.firebase-local/export/data.json',
      'services/office/.secrets/arbitrary-name.json',
      'services/office/project-firebase-adminsdk-fixture.json',
      'services/office/service-account.json',
      'services/office/application_default_credentials.json',
      'services/office/private.pem',
      'services/office/private.key',
    ];
    const shared = [
      'services/office/.firebaserc.example',
      'services/office/.env.example',
      'services/office/firebase.json',
      'services/office/firestore.rules',
      'services/office/compose.yaml',
      'services/office/Dockerfile',
    ];
    // Test only the versioned rules; local/global excludes could mask a missing
    // rule in the developer checkout and produce a false pass.
    const fixture = mkdtempSync(path.join(tmpdir(), 'tmt-firebase-ignore-'));
    try {
      const initialized = spawnSync('git', ['init', '--quiet', '--template=', fixture], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(initialized.status).toBe(0);
      copyFileSync(path.join(root, '.gitignore'), path.join(fixture, '.gitignore'));
      const result = spawnSync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '-z', '--stdin'],
        {
          cwd: fixture,
          input: [...ignored, ...shared].join('\0') + '\0',
          encoding: 'utf8',
          timeout: 5000,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(new Set(result.stdout.split('\0').filter(Boolean))).toEqual(new Set(ignored));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps owner mapping opt-in with no real-project default in the shared template', () => {
    const template = JSON.parse(
      readFileSync(new URL('../../services/office/.firebaserc.example', import.meta.url), 'utf8')
    );
    expect(template).toEqual({ projects: { owner: 'replace-with-your-project-id' } });
    const config = JSON.parse(
      readFileSync(new URL('../../services/office/firebase.json', import.meta.url), 'utf8')
    );
    expect(Object.keys(config.emulators).sort()).toEqual([
      'auth',
      'firestore',
      'hub',
      'logging',
      'singleProjectMode',
      'ui',
    ]);
    expect(config.firestore.rules).toBe('firestore.rules');
    expect(config.emulators.ui.enabled).toBe(false);
    expect(config.emulators.singleProjectMode).toBe(true);
    expect(config.hosting).toBeUndefined();
    expect(config.functions).toBeUndefined();
  });
});
