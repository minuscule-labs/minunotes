import { describe, expect, it } from 'vitest';
import { createInternalNoteUrlPasteResolver } from '../src/frontend/lib/note-urls';

const resolver = createInternalNoteUrlPasteResolver({
  browserOrigin: 'http://localhost:5173',
  additionalOrigins: ['https://notes.minusculelabs.com', 'https://notes.dpklabs.com'],
});

describe('internal note URL paste resolver', () => {
  it.each([
    'note_f47ac10b58cc4372a5670e02b2c3d479',
    'note_01941f297c0075f4a310744d2167fc5b',
  ])('resolves both UUIDv4 and UUIDv7 note IDs: %s', (target) => {
    expect(resolver(`https://notes.minusculelabs.com/notes/${target}`, { selectedText: '', mode: 'live' })).toEqual({
      target,
    });
  });

  it.each([
    'http://localhost:5173/notes/note_abc123',
    'http://localhost:5173/notes/note_abc123/',
    'https://notes.minusculelabs.com/notes/note_abc123',
    'https://notes.dpklabs.com/notes/note_abc123',
    'https://notes.minusculelabs.com/notes/note_abc-123_test',
  ])('resolves an exact note URL from an approved origin: %s', (sourceUrl) => {
    const target = sourceUrl.includes('abc-123_test') ? 'note_abc-123_test' : 'note_abc123';
    expect(resolver(sourceUrl, { selectedText: '', mode: 'live' })).toEqual({ target });
  });

  it.each([
    'https://example.com/notes/note_abc123',
    'https://evilnotes.minusculelabs.com/notes/note_abc123',
    'https://notes.minusculelabs.com/notes/note_abc123?review=open',
    'https://notes.minusculelabs.com/notes/note_abc123#heading',
    'https://user:password@notes.minusculelabs.com/notes/note_abc123',
    'https://notes.minusculelabs.com/folders/note_abc123',
    'https://notes.minusculelabs.com/notes/note_',
    'https://notes.minusculelabs.com/notes/note_abc123/more',
  ])('does not resolve an unrecognized or inexact URL: %s', (sourceUrl) => {
    expect(resolver(sourceUrl, { selectedText: '', mode: 'source' })).toBeNull();
  });

  it('ignores malformed and path-bearing configured origins', () => {
    const strictResolver = createInternalNoteUrlPasteResolver({
      browserOrigin: 'not a URL',
      additionalOrigins: ['https://notes.minusculelabs.com/app', 'javascript:alert(1)'],
    });

    expect(
      strictResolver('https://notes.minusculelabs.com/notes/note_abc123', {
        selectedText: '',
        mode: 'live',
      })
    ).toBeNull();
  });
});
