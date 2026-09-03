import type { Paths } from '../types.js';

export type CheckpointMode = 'passive' | 'truncate';

export interface StorageHealth {
  readonly path: string;
  readonly open: boolean;
  readonly schemaVersion: number;
  readonly journalMode: 'wal';
  readonly foreignKeys: true;
  readonly busyTimeoutMs: number;
  readonly synchronous: 'normal';
  readonly fts5: true;
}

/** Narrow lifecycle port. Domain repositories are added separately by their owning tickets. */
export interface StorageHandle {
  readonly path: string;
  health(): StorageHealth;
  checkpoint(mode?: CheckpointMode): void;
  close(): void;
}

export type StorageLocation = Pick<Paths, 'globalDir' | 'databaseFile'> | string;
