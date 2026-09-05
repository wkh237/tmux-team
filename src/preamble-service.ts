import type { DurableIdentity } from './domain/identity.js';
import {
  normalizePreambleContent,
  type PreambleProfile,
  type PreambleResult,
  type StoredPreambleResult,
} from './domain/preamble.js';
import {
  requireDurableIdentity,
  type DurableIdentityContext,
  type IdentitySelector,
} from './identity-context.js';

export interface PreambleRepository {
  findByCanonicalName(canonicalName: string): DurableIdentity | undefined;
  findPreamble(identityId: string): PreambleProfile | undefined;
  setPreamble(identityId: string, content: string): PreambleProfile;
  clearPreamble(identityId: string): boolean;
  listPreambles(): StoredPreambleResult[];
}

export interface PreambleService {
  show(name: string): PreambleResult;
  set(name: string, content: string): StoredPreambleResult;
  clear(name: string): PreambleResult & { readonly cleared: boolean };
  list(): StoredPreambleResult[];
}

function selector(name: string): IdentitySelector {
  return { value: name, kind: 'identity', explicit: true };
}

function resolveIdentity(repository: PreambleRepository, name: string): DurableIdentity {
  const context: DurableIdentityContext = {
    findByCanonicalName: (canonicalName) => repository.findByCanonicalName(canonicalName),
    currentIdentity: () => undefined,
  };
  return requireDurableIdentity(context, selector(name));
}

function result(identity: DurableIdentity, preamble: PreambleProfile | undefined): PreambleResult {
  return { identity, preamble: preamble ?? null };
}

function storedResult(identity: DurableIdentity, preamble: PreambleProfile): StoredPreambleResult {
  return { identity, preamble };
}

export function createPreambleService(options: {
  readonly repository: PreambleRepository;
}): PreambleService {
  const { repository } = options;
  return {
    show(name) {
      const identity = resolveIdentity(repository, name);
      return result(identity, repository.findPreamble(identity.id));
    },
    set(name, content) {
      const identity = resolveIdentity(repository, name);
      const preamble = repository.setPreamble(identity.id, normalizePreambleContent(content));
      return storedResult(identity, preamble);
    },
    clear(name) {
      const identity = resolveIdentity(repository, name);
      const cleared = repository.clearPreamble(identity.id);
      return { ...result(identity, undefined), cleared };
    },
    list() {
      return repository.listPreambles();
    },
  };
}
