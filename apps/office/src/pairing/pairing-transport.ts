import {
  parseApprovedPairing,
  parseRevokedPairing,
  PairingActionError,
} from './pairing-contract.js';
import type { PairingPort } from './pairing-contract.js';

/** Deployment configuration is trusted input; pairing links never select an endpoint. */
export function pairingEndpoint(
  mode: string,
  settings: Record<string, unknown>
): string | undefined {
  if (mode === 'emulator') return 'http://127.0.0.1:5001/demo-tmt-office/us-central1/officePairing';
  if (
    mode !== 'cloud' ||
    settings.VITE_OFFICE_PAIRING_URL === undefined ||
    settings.VITE_OFFICE_PAIRING_URL === ''
  )
    return undefined;
  const value = settings.VITE_OFFICE_PAIRING_URL;
  if (typeof value !== 'string') throw new Error('Invalid Office pairing service configuration.');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new Error('Invalid Office pairing service configuration.');
  return url.href.replace(/\/$/, '');
}

async function responseBody(response: Response): Promise<unknown> {
  if (
    !response.headers.get('content-type')?.match(/^application\/json(?:\s*;|$)/i) ||
    !response.body
  )
    throw new PairingActionError('uncertain');
  const reader = response.body.getReader();
  const bytes: number[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > 4096) {
        await reader.cancel();
        throw new PairingActionError('uncertain');
      }
      bytes.push(...value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)));
}

interface TokenSession {
  readonly currentUser: { uid: string; getIdToken(): Promise<string> } | null;
}

export function createPairingPort(
  auth: TokenSession,
  endpoint: string,
  send: typeof fetch = fetch
): PairingPort {
  async function post(operation: 'approve' | 'revoke', input: unknown, ownerUid: string) {
    const user = auth.currentUser;
    if (!user || user.uid !== ownerUid) throw new PairingActionError('denied');
    try {
      const token = await user.getIdToken();
      if (auth.currentUser !== user) throw new PairingActionError('denied');
      const response = await send(`${endpoint}/${operation}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const failure =
        auth.currentUser !== user || [400, 401, 403].includes(response.status)
          ? 'denied'
          : response.status === 404
            ? 'unavailable'
            : response.status === 409
              ? 'conflict'
              : response.status !== 200
                ? 'uncertain'
                : undefined;
      if (failure) {
        await response.body?.cancel();
        throw new PairingActionError(failure);
      }
      return await responseBody(response);
    } catch (error) {
      if (error instanceof PairingActionError) throw error;
      throw new PairingActionError('uncertain');
    }
  }
  return {
    async approve(request, ownerUid) {
      return parseApprovedPairing(await post('approve', request, ownerUid), request);
    },
    async revoke(pairingId, ownerUid) {
      parseRevokedPairing(await post('revoke', { version: 1, pairingId }, ownerUid), pairingId);
    },
  };
}
