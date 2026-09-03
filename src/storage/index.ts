export { openStorage } from './sqlite-adapter.js';
export type { CheckpointMode, StorageHandle, StorageHealth, StorageLocation } from './ports.js';
export { StorageError, type StorageErrorCode } from './errors.js';
export { openIdentityRepository, type IdentityRepository } from './identity-repository.js';
export type { DurableIdentity, TmuxBinding } from '../domain/identity.js';
