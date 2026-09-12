import type { DecodedIdToken } from 'firebase-admin/auth';
import {
  PairingError,
  UUID,
  parseApproval,
  parseClaim,
  parseRenewal,
  parseRevocation,
} from './pairing-contract.js';
import type { AgentIdentity, PairingStore } from './pairing-store.js';

export interface PairingAuthentication {
  verifyIdToken(token: string, checkRevoked: boolean): Promise<DecodedIdToken>;
  createCustomToken(uid: string, claims: Record<string, unknown>): Promise<string>;
}

export function createPairingService(store: PairingStore, auth: PairingAuthentication) {
  async function verified(authorization: string | undefined): Promise<DecodedIdToken> {
    if (!authorization || authorization.length > 8192 || !/^Bearer \S+$/.test(authorization))
      throw new PairingError('UNAUTHENTICATED');
    try {
      return await auth.verifyIdToken(authorization.slice(7), true);
    } catch {
      throw new PairingError('UNAUTHENTICATED');
    }
  }

  async function human(authorization: string | undefined): Promise<string> {
    const token = await verified(authorization);
    if (token.firebase.sign_in_provider !== 'google.com' || token.email_verified !== true)
      throw new PairingError('PERMISSION_DENIED');
    return token.uid;
  }

  async function agent(authorization: string | undefined): Promise<AgentIdentity> {
    const token = await verified(authorization);
    if (
      token.tmtOfficeAgent !== true ||
      typeof token.tmtInstallationId !== 'string' ||
      !UUID.test(token.tmtInstallationId) ||
      typeof token.tmtIdentityId !== 'string' ||
      !UUID.test(token.tmtIdentityId)
    )
      throw new PairingError('PERMISSION_DENIED');
    return {
      uid: token.uid,
      installationId: token.tmtInstallationId,
      identityId: token.tmtIdentityId,
    };
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
    async renew(input: unknown, authorization?: string) {
      const renewal = parseRenewal(input);
      const binding = await store.renew(
        await agent(authorization),
        renewal.pairingId,
        renewal.grantExpiresAt
      );
      return binding;
    },
    async revoke(input: unknown, authorization?: string) {
      const id = parseRevocation(input);
      await store.revoke(await human(authorization), id);
      return { version: 1, pairingId: id, revoked: true };
    },
  };
}
