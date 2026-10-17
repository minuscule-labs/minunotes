import { afterEach, expect, it, vi } from 'vitest';
import {
  folderListHistoryState,
  isFolderListHistoryState,
  readFolderViewPreference,
  resolveFolderEntryView,
  resolveFolderView,
  storeFolderViewPreference,
} from '../src/frontend/lib/folder-view-preferences';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it('defaults to List without a user, folder, storage or saved preference', () => {
  const storage = memoryStorage();
  expect(readFolderViewPreference('user', 'folder', storage)).toBe('list');
  expect(readFolderViewPreference('user', 'folder', null)).toBe('list');
  storeFolderViewPreference('', 'folder', 'board', storage);
  storeFolderViewPreference('user', '', 'board', storage);
  expect(storage.values.size).toBe(0);
});
it('persists List and Board independently per user and folder', () => {
  const storage = memoryStorage();
  storeFolderViewPreference('alice', 'project', 'board', storage);
  storeFolderViewPreference('alice', 'documents', 'list', storage);
  storeFolderViewPreference('bob', 'documents', 'board', storage);
  expect(readFolderViewPreference('alice', 'project', storage)).toBe('board');
  expect(readFolderViewPreference('bob', 'project', storage)).toBe('list');
  expect(readFolderViewPreference('alice', 'documents', storage)).toBe('list');
  expect(readFolderViewPreference('bob', 'documents', storage)).toBe('board');
  storeFolderViewPreference('alice', 'project', 'list', storage);
  expect(readFolderViewPreference('alice', 'project', storage)).toBe('list');
});
it('encodes identifiers without delimiter collisions', () => {
  const storage = memoryStorage();
  storeFolderViewPreference('a:b', 'c', 'board', storage);
  expect(readFolderViewPreference('a', 'b:c', storage)).toBe('list');
});
it('explicit links override saved choices without mutating preferences', () => {
  const storage = memoryStorage();
  storeFolderViewPreference('user', 'folder', 'board', storage);
  expect(resolveFolderView('list', 'user', 'folder', storage)).toBe('list');
  expect(resolveFolderView('board', 'user', 'folder', storage)).toBe('board');
  for (const invalid of [undefined, '', 'other', ['list'], null, 1])
    expect(resolveFolderView(invalid, 'user', 'folder', storage)).toBe('board');
  expect(readFolderViewPreference('user', 'folder', storage)).toBe('board');
});
it('rejects corrupt stored values instead of treating arbitrary truthy values as Board', () => {
  for (const value of ['true', 'BOARD', '{}', '["board"]', 'null', ''])
    expect(readFolderViewPreference('user', 'folder', { getItem: () => value, setItem: () => {} })).toBe('list');
});
it('storage denial never prevents explicit navigation or leaks another identity', () => {
  const denied = {
    getItem: () => {
      throw new Error('Denied');
    },
    setItem: () => {
      throw new Error('Quota');
    },
  };
  expect(readFolderViewPreference('user', 'folder', denied)).toBe('list');
  expect(() => storeFolderViewPreference('user', 'folder', 'board', denied)).not.toThrow();
  expect(resolveFolderView('board', 'user', 'folder', denied)).toBe('board');
  vi.stubGlobal(
    'window',
    Object.defineProperty({}, 'localStorage', {
      get() {
        throw new Error('Security');
      },
    })
  );
  expect(readFolderViewPreference('user', 'folder')).toBe('list');
  expect(() => storeFolderViewPreference('user', 'folder', 'list')).not.toThrow();
});

it('pins bare List history entries independently of later stored Board choices', () => {
  const storage = memoryStorage();
  const state = folderListHistoryState('alice', 'project');
  storeFolderViewPreference('alice', 'project', 'board', storage);
  expect(resolveFolderEntryView(undefined, 'alice', 'project', state, storage)).toBe('list');
  expect(resolveFolderEntryView('board', 'alice', 'project', state, storage)).toBe('board');
  expect(resolveFolderEntryView('list', 'alice', 'project', {}, storage)).toBe('list');
  expect(readFolderViewPreference('alice', 'project', storage)).toBe('board');
});
it('ignores history markers from another user/folder or invalid history data', () => {
  const storage = memoryStorage();
  storeFolderViewPreference('alice', 'project', 'board', storage);
  for (const state of [
    null,
    [],
    { minunotesFolderList: 'list' },
    folderListHistoryState('bob', 'project'),
    folderListHistoryState('alice', 'other'),
  ]) {
    expect(isFolderListHistoryState(state, 'alice', 'project')).toBe(false);
    expect(resolveFolderEntryView(undefined, 'alice', 'project', state, storage)).toBe('board');
  }
  expect(isFolderListHistoryState(folderListHistoryState('alice', 'project'), '', 'project')).toBe(false);
});
