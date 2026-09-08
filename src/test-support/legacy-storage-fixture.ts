import { CURRENT_MIGRATIONS } from '../storage/migrations.js';
import { openStorageWithMigrations } from '../storage/sqlite-adapter.js';

/** Initialize the legacy TypeScript schema for tests that arrange SQLite state directly. */
export function initializeDatabase(sandbox: { readonly database: string }): void {
  let storage: ReturnType<typeof openStorageWithMigrations> | undefined;
  try {
    storage = openStorageWithMigrations(sandbox.database, CURRENT_MIGRATIONS);
  } finally {
    storage?.close();
  }
}
