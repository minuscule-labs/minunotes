import { BoardValidationError } from '../../shared/board';
import { parsePageRequest } from '../lib/pagination';
import { parseFolderQueryRequest } from './folder-query';

/** Both signed-in and public folder views use the same board read contract. */
export function parseBoardLaneRequest(params: URLSearchParams) {
  const query = parseFolderQueryRequest(params);
  for (const key of ['version', 'lane', 'page', 'limit', 'schemaId', 'schemaRevision']) {
    if (params.getAll(key).length > 1) throw new BoardValidationError(`Repeated ${key} parameter`);
  }
  const version = params.get('version') ?? undefined;
  if (version !== undefined && (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))))
    throw new BoardValidationError('Invalid configuration version');
  if (['tag', 'boardTags', 'includeTags', 'excludeTags'].some((key) => params.has(key)))
    throw new BoardValidationError('Board tag filters are no longer supported. Refresh the property-only board.');
  const page = parsePageRequest(params.get('page') ?? undefined, params.get('limit') ?? undefined, {
    defaultLimit: 25,
  });
  if (!Number.isSafeInteger(page.offset) || page.offset > 1000000)
    throw new BoardValidationError('Page is out of range');
  return {
    ...query,
    lane: params.get('lane') ?? '',
    version: version === undefined ? undefined : Number(version),
    page,
  };
}
