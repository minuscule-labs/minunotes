export const FOLDER_COPY_LIMITS = {
  folders: 100,
  notes: 100,
  bytes: 16 * 1024 * 1024,
  attachments: 200,
  attachmentBytes: 25 * 1024 * 1024,
} as const;
export class FolderDuplicationError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 413 | 428 | 503 = 409,
    public uncertain = false
  ) {
    super(message);
  }
}
export type FolderDuplicationRequest = {
  title: string;
  parentFolderId: string | null;
  requestId: string;
  // Optional only to recover pre-preview unresolved requests; new copies require it server-side.
  previewToken?: string;
};
export type FolderDuplicationCounts = { folders: number; notes: number; templates: number; attachments: number };
export type FolderDuplicationResult = {
  folder: { id: string; title: string; parentFolderId: string | null };
  counts: FolderDuplicationCounts;
  replayed: boolean;
};
export type FolderDuplicationPreview = {
  sourceFolderId: string;
  parentFolderId: string | null;
  token: string;
  counts: FolderDuplicationCounts;
  imageBytes: number;
};
export function confirmFolderDuplicationPreview(
  input: FolderDuplicationPreview,
  sourceFolderId: string,
  parentFolderId: string | null
): FolderDuplicationPreview {
  const count = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  if (
    !input ||
    input.sourceFolderId !== sourceFolderId ||
    input.parentFolderId !== parentFolderId ||
    typeof input.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.token) ||
    !input.counts ||
    !count(input.counts.folders, 1, FOLDER_COPY_LIMITS.folders) ||
    !count(input.counts.notes, 0, FOLDER_COPY_LIMITS.notes) ||
    !count(input.counts.templates, 0, FOLDER_COPY_LIMITS.notes) ||
    input.counts.notes + input.counts.templates > FOLDER_COPY_LIMITS.notes ||
    !count(input.counts.attachments, 0, FOLDER_COPY_LIMITS.attachments) ||
    !count(input.imageBytes, 0, FOLDER_COPY_LIMITS.attachmentBytes) ||
    (input.counts.attachments === 0) !== (input.imageBytes === 0)
  )
    throw new Error('Copy summary was not confirmed. Refresh the summary.');
  return input;
}
export function parseFolderDuplication(input: unknown): FolderDuplicationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new FolderDuplicationError('Invalid duplication request', 400);
  const value = input as Record<string, unknown>;
  if (
    ![3, 4].includes(Object.keys(value).length) ||
    Object.keys(value).some((key) => !['title', 'parentFolderId', 'requestId', 'previewToken'].includes(key))
  )
    throw new FolderDuplicationError('Unexpected duplication fields', 400);
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    [...value.title.trim()].length > 200 ||
    [...value.title].some((character) => character.charCodeAt(0) < 32)
  )
    throw new FolderDuplicationError('Choose a folder name of 1–200 characters', 400);
  if (
    value.parentFolderId !== null &&
    (typeof value.parentFolderId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.parentFolderId))
  )
    throw new FolderDuplicationError('Invalid destination', 400);
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.requestId))
    throw new FolderDuplicationError('Invalid duplication request ID', 400);
  if ('previewToken' in value && (typeof value.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewToken)))
    throw new FolderDuplicationError('Invalid copy summary', 400);
  return {
    ...('previewToken' in value ? { previewToken: value.previewToken as string } : {}),
    title: value.title.trim(),
    parentFolderId: value.parentFolderId as string | null,
    requestId: value.requestId,
  };
}
