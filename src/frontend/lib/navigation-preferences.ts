const SIDEBAR_COLLAPSED_KEY = 'minunotes:navigation:sidebar-collapsed';
const EXPANDED_FOLDERS_KEY = 'minunotes:navigation:expanded-folders';
const EXPANDED_SHARED_FOLDERS_KEY = 'minunotes:navigation:expanded-shared-folders';

function localStorageOrNull() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getStoredSidebarCollapsed() {
  try {
    return localStorageOrNull()?.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function storeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorageOrNull()?.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Navigation remains usable when storage is unavailable.
  }
}

export function getStoredExpandedFolderIds() {
  try {
    const value = JSON.parse(localStorageOrNull()?.getItem(EXPANDED_FOLDERS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

export function storeExpandedFolderIds(folderIds: Set<string>) {
  try {
    localStorageOrNull()?.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...folderIds]));
  } catch {
    // Navigation remains usable when storage is unavailable.
  }
}

export function getStoredExpandedSharedFolderIds() {
  try {
    const value = JSON.parse(localStorageOrNull()?.getItem(EXPANDED_SHARED_FOLDERS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

export function storeExpandedSharedFolderIds(folderIds: Set<string>) {
  try {
    localStorageOrNull()?.setItem(EXPANDED_SHARED_FOLDERS_KEY, JSON.stringify([...folderIds]));
  } catch {
    // Navigation remains usable when storage is unavailable.
  }
}
