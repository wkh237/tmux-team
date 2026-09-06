import { publicIdentity, type DurableIdentity, type RoleProfile } from './domain/identity.js';
import {
  requireDurableIdentity,
  type DurableIdentityContext,
  type IdentitySelector,
} from './identity-context.js';
import { normalizeRoleContent } from './domain/role.js';
import type { RoleResult, RoleService } from './types.js';

/** Application-owned persistence port for optional durable role profiles. */
export interface RoleRepository {
  findByCanonicalName(canonicalName: string): DurableIdentity | undefined;
  findRole(identityId: string): RoleProfile | undefined;
  setRole(identityId: string, content: string): RoleProfile;
  clearRole(identityId: string): null;
}

export interface RoleServiceOptions {
  readonly repository: RoleRepository;
  readonly currentIdentity: DurableIdentityContext['currentIdentity'];
}

function resolveIdentity(
  repository: RoleRepository,
  currentIdentity: RoleServiceOptions['currentIdentity'],
  selector?: IdentitySelector
): DurableIdentity {
  return requireDurableIdentity(
    { findByCanonicalName: (name) => repository.findByCanonicalName(name), currentIdentity },
    selector
  );
}

export function createRoleService(options: RoleServiceOptions): RoleService {
  const resolve = (selector?: IdentitySelector): DurableIdentity =>
    resolveIdentity(options.repository, options.currentIdentity, selector);
  const result = (identity: DurableIdentity): RoleResult => ({
    identity: publicIdentity(identity),
    role: options.repository.findRole(identity.id) ?? null,
  });
  return {
    show(selector) {
      return result(resolve(selector));
    },
    set(selector, content) {
      const identity = resolve(selector);
      return {
        identity: publicIdentity(identity),
        role: options.repository.setRole(identity.id, normalizeRoleContent(content)),
      };
    },
    clear(selector) {
      const identity = resolve(selector);
      options.repository.clearRole(identity.id);
      return {
        identity: publicIdentity(identity),
        role: null,
      };
    },
  };
}
