import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api, type NoteListItem } from '../lib/api';
import { MoveNotesDialog } from './move-notes-dialog';
import { NoteActionsPopover } from './note-actions-popover';
import { type ResourceColumn, ResourceName, ResourceTable } from './resource-table';
import { TrashNotesDialog } from './trash-notes-dialog';
import { Button } from './ui/button';

export function NotesTable({
  notes,
  queryKey,
  folderTitles,
}: {
  notes: NoteListItem[];
  queryKey?: unknown[];
  folderTitles?: Record<string, string>;
}) {
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const remove = useMutation({
    mutationFn: ({ noteId }: { noteId: string }) => api.deleteNote(noteId),
    onSuccess: (_, variables) => {
      const note = notes.find((item) => item.id === variables.noteId);
      if (!note) return;
      qc.invalidateQueries({ queryKey: queryKey ?? ['notes', note.folderId] });
      qc.invalidateQueries({ queryKey: ['notes', 'recent'] });
      qc.removeQueries({ queryKey: ['note', note.id] });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
    },
  });

  const sortedNotes = useMemo(
    () =>
      [...notes].sort((a, b) => {
        const updatedDiff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        return updatedDiff || a.title.localeCompare(b.title);
      }),
    [notes]
  );
  const visibleIds = sortedNotes.map((note) => note.id);
  const selectedNotes = sortedNotes.filter((note) => selectedIds.has(note.id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  const toggleNote = (noteId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(noteId);
      else next.delete(noteId);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const columns: ResourceColumn<NoteListItem>[] = [
    {
      id: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all notes"
          checked={allVisibleSelected}
          ref={(input) => {
            if (input) input.indeterminate = someVisibleSelected && !allVisibleSelected;
          }}
          onChange={(event) => toggleAllVisible(event.currentTarget.checked)}
        />
      ),
      width: '3.5rem',
      cell: (note) => (
        <>
          <input
            type="checkbox"
            aria-label={`Select ${note.title}`}
            checked={selectedIds.has(note.id)}
            onChange={(event) => toggleNote(note.id, event.currentTarget.checked)}
          />
        </>
      ),
    },
    {
      id: 'title',
      header: 'Title',
      cell: (note) => (
        <>
          <div>
            <Link
              className="font-medium text-[var(--notes-text)] transition-colors hover:text-[var(--notes-blue)]"
              to="/notes/$noteId"
              params={{ noteId: note.id }}
            >
              <ResourceName>{note.title}</ResourceName>
            </Link>
            {folderTitles?.[note.folderId] ? (
              <Link
                to="/folders/$folderId"
                params={{ folderId: note.folderId }}
                className="mt-1 block text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]"
              >
                {folderTitles[note.folderId]}
              </Link>
            ) : null}
          </div>
        </>
      ),
    },
    {
      id: 'createdAt',
      header: 'Created',
      width: '10rem',
      cell: (note) => (
        <>
          <span className="text-[var(--notes-muted)] text-xs">{new Date(note.createdAt).toLocaleString()}</span>
        </>
      ),
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      width: '10rem',
      cell: (note) => (
        <>
          <span className="text-[var(--notes-muted)] text-xs">{new Date(note.updatedAt).toLocaleString()}</span>
        </>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      width: '5rem',
      align: 'right',
      cell: (note) => (
        <>
          <div className="flex justify-end">
            <NoteActionsPopover note={note} onDelete={() => remove.mutateAsync({ noteId: note.id })} />
          </div>
        </>
      ),
    },
  ];

  const bulkActions =
    selectedNotes.length > 0 ? (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] px-3 py-2 text-sm">
        <span className="text-[var(--notes-muted)]">
          {selectedNotes.length} {selectedNotes.length === 1 ? 'note' : 'notes'} selected
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
          <MoveNotesDialog
            notes={selectedNotes}
            onMoved={() => {
              setSelectedIds(new Set());
              if (queryKey) qc.invalidateQueries({ queryKey });
            }}
          />
          <TrashNotesDialog notes={selectedNotes} queryKey={queryKey} onTrashed={() => setSelectedIds(new Set())} />
        </div>
      </div>
    ) : null;

  return (
    <>
      {bulkActions}
      <ResourceTable
        items={sortedNotes}
        columns={columns}
        rowId={(note) => note.id}
        mobileRows={sortedNotes.map((note) => (
          <div key={note.id} className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`Select ${note.title}`}
                  checked={selectedIds.has(note.id)}
                  onChange={(event) => toggleNote(note.id, event.currentTarget.checked)}
                />
                <div className="min-w-0">
                  <Link
                    className="line-clamp-2 font-medium leading-snug [overflow-wrap:anywhere] hover:text-[var(--notes-blue)]"
                    title={note.title}
                    to="/notes/$noteId"
                    params={{ noteId: note.id }}
                  >
                    {note.title}
                  </Link>
                  {folderTitles?.[note.folderId] ? (
                    <Link
                      to="/folders/$folderId"
                      params={{ folderId: note.folderId }}
                      className="mt-1 block text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]"
                    >
                      {folderTitles[note.folderId]}
                    </Link>
                  ) : null}
                  <p className="mt-1 text-[var(--notes-muted)] text-xs">
                    Created {new Date(note.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-1 text-[var(--notes-muted)] text-xs">
                    Updated {new Date(note.updatedAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <NoteActionsPopover note={note} onDelete={() => remove.mutateAsync({ noteId: note.id })} />
            </div>
          </div>
        ))}
      />
    </>
  );
}
