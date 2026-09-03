/** Durable logical identity, independent from any currently reachable endpoint. */
export interface DurableIdentity {
  readonly id: string;
  readonly name: string;
  readonly canonicalName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
