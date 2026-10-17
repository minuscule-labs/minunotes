import { PropertyError } from '../../shared/properties';
import { db } from '../db/client';
export type MetadataTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type MetadataExecutor = typeof db | MetadataTx;
// Only serializes the singleton connection; database transactions protect independent clients.
let pending: Promise<unknown> = Promise.resolve();
export function metadataTransaction<T>(run: (tx: MetadataTx) => Promise<T>): Promise<T> {
  const result = pending
    .then(() => db.transaction(run))
    .catch((error: unknown) => {
      // Drizzle may wrap libSQL's lock error as the cause of a query error.
      let cause = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
        if (/SQLITE_BUSY|SQLITE_LOCKED/.test(cause.message))
          throw new PropertyError('Metadata is busy; retry the unchanged request', 409);
        cause = cause.cause;
      }
      throw error;
    });
  pending = result.catch(() => undefined);
  return result;
}
