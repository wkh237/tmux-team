/** Durable logical identity, independent from any currently reachable endpoint. */
export interface DurableIdentity {
  readonly id: string;
  readonly name: string;
  readonly canonicalName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public identity fields safe to include in command results. */
export type PublicIdentity = Pick<DurableIdentity, 'id' | 'name' | 'canonicalName'>;

export function publicIdentity(identity: DurableIdentity): PublicIdentity {
  return {
    id: identity.id,
    name: identity.name,
    canonicalName: identity.canonicalName,
  };
}

/** Transient evidence that a durable identity is bound to one tmux pane instance. */
export interface TmuxBinding {
  readonly id: string;
  readonly identityId: string;
  readonly transport: 'tmux';
  readonly paneId: string;
  readonly serverId: string;
  readonly socketPath: string;
  readonly serverPid: number;
  readonly serverStartTime: string;
  readonly panePid: number;
  readonly boundAt: string;
  readonly lastVerifiedAt: string;
}

/** Optional durable role profile attached to one identity. */
export interface RoleProfile {
  readonly content: string;
  readonly updatedAt: string;
}
