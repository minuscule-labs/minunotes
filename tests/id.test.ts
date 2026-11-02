import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../src/api/lib/id';

afterEach(() => vi.restoreAllMocks());

describe('createId', () => {
  it.each([
    'note',
    'folder',
    'tag',
    'comment_thread',
    'note_version',
    'oauth_token',
    'att',
  ])('preserves the %s prefix with a full compact UUIDv7', (prefix) => {
    const id = createId(prefix);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(id.slice(prefix.length + 1)).toMatch(/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  });

  it('encodes the current Unix millisecond timestamp', () => {
    const before = Date.now();
    const id = createId('note');
    const after = Date.now();
    const timestamp = Number.parseInt(id.slice('note_'.length, 'note_'.length + 12), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('generates distinct IDs during a burst in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const ids = Array.from({ length: 1_000 }, () => createId('note'));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
