export type RecentKind = 'folder' | 'note';
export type PersonalVisit = { kind: RecentKind; id: string };
export const RECENTS_LIMIT = 24;
export const personalRecentsKey = (userId: string) => `minunotes:personal-recents:${userId}`;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function readPersonalRecents(userId: string, storage?: Storage): PersonalVisit[] {
  try {
    const value: unknown = JSON.parse((storage ?? window.localStorage).getItem(personalRecentsKey(userId)) ?? '[]');
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
      .filter((item): item is PersonalVisit => {
        if (
          !item ||
          (item.kind !== 'folder' && item.kind !== 'note') ||
          typeof item.id !== 'string' ||
          !item.id ||
          item.id.length > 100
        )
          return false;
        const key = `${item.kind}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, RECENTS_LIMIT)
      .map(({ kind, id }) => ({ kind, id }));
  } catch {
    return [];
  }
}

export function recordPersonalVisit(userId: string, visit: PersonalVisit, storage?: Storage) {
  try {
    const target = storage ?? window.localStorage;
    const previous = readPersonalRecents(userId, target);
    target.setItem(
      personalRecentsKey(userId),
      JSON.stringify(
        [
          { kind: visit.kind, id: visit.id },
          ...previous.filter((item) => item.kind !== visit.kind || item.id !== visit.id),
        ].slice(0, RECENTS_LIMIT)
      )
    );
  } catch {
    // Browsing must still work when storage is disabled or full.
  }
}
