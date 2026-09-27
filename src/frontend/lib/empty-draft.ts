import type { Note } from './api';

type EmptyDraft = { createdAt: string; updatedAt: string };

const key = (noteId: string) => `minunotes:empty-draft:${noteId}`;

export function markEmptyDraft(note: Note) {
  if (note.type !== 'note' || note.documentType !== 'markdown' || note.title !== 'Untitled note' || note.content)
    return;
  try {
    window.sessionStorage.setItem(
      key(note.id),
      JSON.stringify({ createdAt: note.createdAt, updatedAt: note.updatedAt })
    );
  } catch {
    // If session storage is unavailable, leave the note intact rather than blocking creation.
  }
}

export function getEmptyDraft(noteId: string): EmptyDraft | null {
  try {
    const value = window.sessionStorage.getItem(key(noteId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<EmptyDraft>;
    return typeof parsed.createdAt === 'string' && typeof parsed.updatedAt === 'string'
      ? { createdAt: parsed.createdAt, updatedAt: parsed.updatedAt }
      : null;
  } catch {
    return null;
  }
}

export function forgetEmptyDraft(noteId: string) {
  try {
    window.sessionStorage.removeItem(key(noteId));
  } catch {
    // Cleanup is best-effort; a missing session store must not block note editing.
  }
}
