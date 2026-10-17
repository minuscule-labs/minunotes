export type FolderViewPreference = 'list' | 'board';

// This marker pins only this history entry, not the saved folder preference.
export function folderListHistoryState(userId: string, folderId: string) {
  return { minunotesFolderList: { userId, folderId } };
}

export function isFolderListHistoryState(state: unknown, userId: string, folderId: string) {
  if (!userId || !folderId || !state || typeof state !== 'object' || !('minunotesFolderList' in state)) return false;
  const marker = state.minunotesFolderList;
  return (
    !!marker &&
    typeof marker === 'object' &&
    'userId' in marker &&
    'folderId' in marker &&
    marker.userId === userId &&
    marker.folderId === folderId
  );
}

export function resolveFolderEntryView(
  explicit: unknown,
  userId: string,
  folderId: string,
  state: unknown,
  storage = browserStorage()
): FolderViewPreference {
  if (explicit === 'board' || explicit === 'list') return explicit;
  return isFolderListHistoryState(state, userId, folderId)
    ? 'list'
    : readFolderViewPreference(userId, folderId, storage);
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function preferenceKey(userId: string, folderId: string) {
  return `minunotes:folder-view:${encodeURIComponent(userId)}:${encodeURIComponent(folderId)}`;
}

export function readFolderViewPreference(
  userId: string,
  folderId: string,
  storage = browserStorage()
): FolderViewPreference {
  if (!userId || !folderId) return 'list';
  try {
    return storage?.getItem(preferenceKey(userId, folderId)) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function storeFolderViewPreference(
  userId: string,
  folderId: string,
  view: FolderViewPreference,
  storage = browserStorage()
) {
  if (!userId || !folderId || (view !== 'list' && view !== 'board')) return;
  try {
    storage?.setItem(preferenceKey(userId, folderId), view);
  } catch {
    // Explicit URL navigation still works when browser storage is unavailable.
  }
}

export function resolveFolderView(
  explicit: unknown,
  userId: string,
  folderId: string,
  storage = browserStorage()
): FolderViewPreference {
  return explicit === 'list' || explicit === 'board' ? explicit : readFolderViewPreference(userId, folderId, storage);
}
