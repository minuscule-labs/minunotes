import { useEffect, useRef } from 'react';
import { type RecentKind, recordPersonalVisit } from './personal-recents';

export function usePersonalVisit(userId: string | undefined, kind: RecentKind, id: string, ready: boolean) {
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    const key = `${userId}:${kind}:${id}`;
    if (!ready || !userId || recorded.current === key) return;
    recordPersonalVisit(userId, { kind, id });
    recorded.current = key;
  }, [userId, kind, id, ready]);
}
