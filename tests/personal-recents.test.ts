import { describe, expect, it } from 'vitest';
import {
  personalRecentsKey,
  RECENTS_LIMIT,
  readPersonalRecents,
  recordPersonalVisit,
} from '../src/frontend/lib/personal-recents';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('personal recents', () => {
  it('orders explicit opens/visits, deduplicates and isolates users', () => {
    const storage = memoryStorage();
    recordPersonalVisit('a', { kind: 'note', id: 'one' }, storage);
    recordPersonalVisit('a', { kind: 'folder', id: 'folder' }, storage);
    recordPersonalVisit('a', { kind: 'note', id: 'two' }, storage);
    recordPersonalVisit('a', { kind: 'note', id: 'one' }, storage);
    expect(readPersonalRecents('a', storage)).toEqual([
      { kind: 'note', id: 'one' },
      { kind: 'note', id: 'two' },
      { kind: 'folder', id: 'folder' },
    ]);
    expect(readPersonalRecents('b', storage)).toEqual([]);
    expect(storage.getItem(personalRecentsKey('a'))).not.toMatch(/title|content|updatedAt/);
    storage.setItem(
      personalRecentsKey('a'),
      JSON.stringify([{ kind: 'note', id: 'one', title: 'Stale title', subtitle: 'Hidden folder' }])
    );
    expect(readPersonalRecents('a', storage)).toEqual([{ kind: 'note', id: 'one' }]);
  });

  it('bounds storage', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 40; i++) recordPersonalVisit('a', { kind: 'note', id: String(i) }, storage);
    expect(readPersonalRecents('a', storage)).toHaveLength(RECENTS_LIMIT);
    expect(readPersonalRecents('a', storage)[0].id).toBe('39');
  });

  it('ignores malformed values and duplicates', () => {
    const storage = memoryStorage();
    storage.setItem(personalRecentsKey('a'), 'not json');
    expect(readPersonalRecents('a', storage)).toEqual([]);
    storage.setItem(
      personalRecentsKey('a'),
      JSON.stringify([
        null,
        3,
        {},
        { kind: 'other', id: 'bad' },
        { kind: 'note', id: '' },
        { kind: 'note', id: 'ok' },
        { kind: 'note', id: 'ok' },
      ])
    );
    expect(readPersonalRecents('a', storage)).toEqual([{ kind: 'note', id: 'ok' }]);
  });

  it('tolerates blocked reads and writes', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPersonalRecents('a', storage)).toEqual([]);
    expect(() => recordPersonalVisit('a', { kind: 'note', id: 'one' }, storage)).not.toThrow();
  });
});
