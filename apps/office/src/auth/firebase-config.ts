import type { FirebaseOptions } from 'firebase/app';

export function officeFirebaseConfig(
  mode: string,
  hostname: string,
  settings: Record<string, unknown> = {}
): FirebaseOptions | undefined {
  if (mode === 'emulator') {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
      throw new Error('Local sign-in is only available on loopback.');
    return {
      apiKey: 'demo-tmt-office',
      projectId: 'demo-tmt-office',
      authDomain: 'demo-tmt-office.firebaseapp.com',
    };
  }
  if (mode !== 'cloud') return undefined;
  const {
    VITE_FIREBASE_API_KEY: apiKey,
    VITE_FIREBASE_PROJECT_ID: projectId,
    VITE_FIREBASE_AUTH_DOMAIN: authDomain,
    VITE_FIREBASE_APP_ID: appId,
  } = settings;
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    typeof projectId !== 'string' ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
    projectId.startsWith('demo-') ||
    typeof authDomain !== 'string' ||
    authDomain !== `${projectId}.firebaseapp.com` ||
    typeof appId !== 'string' ||
    !appId.trim()
  ) {
    throw new Error('Cloud mode requires complete Firebase web app configuration.');
  }
  return { apiKey, projectId, authDomain, appId };
}
