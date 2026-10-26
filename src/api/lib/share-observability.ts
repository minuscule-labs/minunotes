import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';

const SAFE_CAUSE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_ERROR',
  'SERVER_ERROR',
]);

// Read only exact code properties, never messages, SQL, parameters or stacks.
export function publicShareCauseCodes(error: unknown) {
  const codes = new Set<string>();
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && SAFE_CAUSE_CODES.has(value.code)) codes.add(value.code);
    current = value.cause;
  }
  return codes.size ? [...codes] : ['UNKNOWN'];
}

export class ShareSnapshotMeasurement {
  readonly requestId = randomUUID();
  private readonly startedAt = performance.now();
  folderQueryCalls = 0;
  noteFetchBatches = 0;
  noteCount = 0;
  noteContentBytes = 0;
  noteFetchDurationMs = 0;

  async fetchNotes<T extends { content: string }>(fetch: () => PromiseLike<T[]>) {
    this.noteFetchBatches++;
    const startedAt = performance.now();
    try {
      const rows = await fetch();
      this.noteCount += rows.length;
      for (const row of rows) this.noteContentBytes += Buffer.byteLength(row.content, 'utf8');
      return rows;
    } finally {
      this.noteFetchDurationMs += performance.now() - startedAt;
    }
  }

  complete(status: number, error?: unknown) {
    console.info('[PUBLIC SHARE]', {
      operation: 'public_share.folder_snapshot',
      request_id: this.requestId,
      status,
      outcome: status >= 500 ? 'error' : status >= 400 ? 'denied' : 'success',
      duration_ms: performance.now() - this.startedAt,
      note_fetch_duration_ms: this.noteFetchDurationMs,
      folder_query_calls: this.folderQueryCalls,
      note_fetch_batches: this.noteFetchBatches,
      note_count: this.noteCount,
      note_content_bytes: this.noteContentBytes,
      ...(error ? { cause_codes: publicShareCauseCodes(error) } : {}),
    });
  }
}

export type ShareObservabilityEnv = {
  Variables: { shareSnapshotMeasurement?: ShareSnapshotMeasurement };
};

// Also mounted before rate limiting in the production app. The route-local
// registration supports standalone mounts without creating duplicate events.
export const shareSnapshotObservability = createMiddleware<ShareObservabilityEnv>(async (c, next) => {
  if (c.get('shareSnapshotMeasurement')) return next();
  const measurement = new ShareSnapshotMeasurement();
  c.set('shareSnapshotMeasurement', measurement);
  c.header('X-Request-Id', measurement.requestId);
  let failure: unknown;
  try {
    await next();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    measurement.complete(failure ? 500 : c.res.status, failure ?? c.error);
  }
});

export function isPublicSharePath(path: string) {
  return path === '/internal/share' || path.startsWith('/internal/share/');
}

export function reportPublicShareError(error: unknown, snapshot?: ShareSnapshotMeasurement) {
  const requestId = snapshot?.requestId ?? randomUUID();
  // The snapshot middleware emits the sole completion/error event for its request.
  if (!snapshot) {
    console.error('[PUBLIC SHARE]', {
      operation: 'public_share',
      request_id: requestId,
      status: 500,
      outcome: 'error',
      cause_codes: publicShareCauseCodes(error),
    });
  }
  return requestId;
}
