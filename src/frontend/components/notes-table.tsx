import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { api, type NoteListItem } from '../lib/api';
import { MoveNotesDialog } from './move-notes-dialog';
import { NoteActionsPopover } from './note-actions-popover';
import { TrashNotesDialog } from './trash-notes-dialog';
import { Button } from './ui/button';

const columnHelper = createColumnHelper<NoteListItem>();

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

  const columns = [
    columnHelper.display({
      id: 'select',
      header: () => (
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
      cell: (info) => (
        <input
          type="checkbox"
          aria-label={`Select ${info.row.original.title}`}
          checked={selectedIds.has(info.row.original.id)}
          onChange={(event) => toggleNote(info.row.original.id, event.currentTarget.checked)}
        />
      ),
    }),
    columnHelper.accessor('title', {
      header: 'Title',
      cell: (info) => (
        <div>
          <Link
            className="font-medium text-[var(--notes-text)] transition-colors hover:text-[var(--notes-blue)]"
            to="/notes/$noteId"
            params={{ noteId: info.row.original.id }}
          >
            {info.getValue()}
          </Link>
          {folderTitles?.[info.row.original.folderId] ? (
            <Link
              to="/folders/$folderId"
              params={{ folderId: info.row.original.folderId }}
              className="mt-1 block text-[var(--notes-muted)] text-xs hover:text-[var(--notes-text)]"
            >
              {folderTitles[info.row.original.folderId]}
            </Link>
          ) : null}
        </div>
      ),
    }),
    columnHelper.accessor('createdAt', {
      header: 'Created',
      cell: (info) => (
        <span className="text-[var(--notes-muted)] text-xs">{new Date(info.getValue()).toLocaleString()}</span>
      ),
    }),
    columnHelper.accessor('updatedAt', {
      header: 'Updated',
      cell: (info) => (
        <span className="text-[var(--notes-muted)] text-xs">{new Date(info.getValue()).toLocaleString()}</span>
      ),
    }),
    columnHelper.display({
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      cell: (info) => (
        <div className="flex justify-end">
          <NoteActionsPopover
            note={info.row.original}
            onDelete={() => remove.mutateAsync({ noteId: info.row.original.id })}
          />
        </div>
      ),
    }),
  ];

  const table = useReactTable({
    data: sortedNotes,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

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
      <div className="space-y-2 md:hidden">
        {sortedNotes.map((note) => (
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
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] md:block">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-[var(--notes-table-header-bg)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    className="border-[var(--notes-border)] border-b px-4 py-2.5 text-left font-medium text-[var(--notes-muted)] text-xs uppercase tracking-wide first:pl-5 last:pr-5"
                    key={h.id}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-[var(--notes-table-row-hover)]">
                {row.getVisibleCells().map((cell) => (
                  <td
                    className="border-[var(--notes-table-row-border)] border-b px-4 py-3 align-middle first:pl-5 last:pr-5 last:text-right"
                    key={cell.id}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
