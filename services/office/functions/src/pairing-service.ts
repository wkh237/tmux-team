import type { DecodedIdToken } from 'firebase-admin/auth';
import { PairingError, parseApproval, parseClaim, parseRevocation } from './pairing-contract.js';
import type { PairingStore } from './pairing-store.js';

export interface PairingAuthentication {
  verifyIdToken(token: string, checkRevoked: boolean): Promise<DecodedIdToken>;
  createCustomToken(uid: string, claims: Record<string, unknown>): Promise<string>;
}

export function createPairingService(store: PairingStore, auth: PairingAuthentication) {
  async function human(authorization: string | undefined): Promise<string> {
    if (!authorization || authorization.length > 8192 || !/^Bearer \S+$/.test(authorization))
      throw new PairingError('UNAUTHENTICATED');
    let token: DecodedIdToken;
    try {
      token = await auth.verifyIdToken(authorization.slice(7), true);
    } catch {
      throw new PairingError('UNAUTHENTICATED');
    }
    if (token.firebase.sign_in_provider !== 'google.com' || token.email_verified !== true)
      throw new PairingError('PERMISSION_DENIED');
    return token.uid;
  }

  return {
    async approve(input: unknown, authorization?: string) {
      const request = parseApproval(input);
      return store.approve(await human(authorization), request);
    },
    async claim(input: unknown) {
      const id = parseClaim(input);
      const binding = await store.reserveClaim(id);
      let customToken: string;
      try {
        customToken = await auth.createCustomToken(binding.principalUid, {
          tmtOfficeAgent: true,
          tmtInstallationId: binding.installationId,
          tmtIdentityId: binding.identityId,
        });
      } catch {
        throw new PairingError('UNAVAILABLE');
      }
      await store.confirmClaim(id);
      return { ...binding, customToken };
    },
    async revoke(input: unknown, authorization?: string) {
      const id = parseRevocation(input);
      await store.revoke(await human(authorization), id);
      return { version: 1, pairingId: id, revoked: true };
    },
  };
}
