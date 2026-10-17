import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api, type Note, type NoteListItem } from '../lib/api';
import { DeleteConfirmDialog } from './delete-confirm-dialog';
import { MoveNoteDialog } from './move-note-dialog';
import { NoteDetailsDialog } from './note-details-dialog';
import { NoteShareDialog } from './note-share-dialog';
import { NoteVersionsDialog } from './note-versions-dialog';
import { ActionMenuButton, ActionMenuIconButton, ActionMenuItemLabel } from './ui/action-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function NoteActionsPopover({
  note,
  onDelete,
  onToggleApiEditable,
  onNoteUpdated,
  editorMode,
  onEditorModeChange,
  icon = 'more',
  ownerControls = true,
  canTrash = ownerControls,
  onProperties,
  propertiesOpen = false,
  propertiesOnly = false,
}: {
  note: NoteListItem;
  onDelete: () => unknown | Promise<unknown>;
  onToggleApiEditable?: () => void;
  onNoteUpdated?: (response: { note: Note; contentHash: string }) => void;
  editorMode?: 'live' | 'source';
  onEditorModeChange?: (mode: 'live' | 'source') => void;
  icon?: 'more' | 'settings';
  ownerControls?: boolean;
  canTrash?: boolean;
  onProperties?: (trigger: HTMLButtonElement | null) => void;
  propertiesOpen?: boolean;
  propertiesOnly?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const copyNoteLink = async () => {
    const url = `${window.location.origin}/notes/${note.id}`;
    await navigator.clipboard.writeText(url);
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 1600);
    setOpen(false);
  };

  const duplicate = useMutation({
    mutationFn: async () => {
      const content =
        'content' in note && typeof note.content === 'string' ? note.content : (await api.note(note.id)).note.content;
      return api.createNote(note.folderId, {
        title: `${note.title} copy`,
        content,
        type: note.type,
        documentType: note.documentType,
      });
    },
    onSuccess: ({ note: duplicateNote }) => {
      qc.invalidateQueries({
        queryKey: [duplicateNote.type === 'template' ? 'templates' : 'notes', duplicateNote.folderId],
      });
      if (duplicateNote.type === 'template') qc.invalidateQueries({ queryKey: ['templates'] });
      navigate({ to: '/notes/$noteId', params: { noteId: duplicateNote.id } });
    },
  });

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild ref={triggerRef}>
          <ActionMenuIconButton icon={icon} aria-label="Open note actions" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-44 p-1"
          onCloseAutoFocus={(event) => {
            if (propertiesOpen) event.preventDefault();
          }}
        >
          {onProperties ? (
            <ActionMenuButton
              onClick={() => {
                onProperties(triggerRef.current);
                setOpen(false);
              }}
            >
              Properties
            </ActionMenuButton>
          ) : null}
          {!propertiesOnly ? (
            <>
              <ActionMenuButton onClick={() => void copyNoteLink()}>
                {copiedLink ? 'Copied link' : 'Copy note link'}
              </ActionMenuButton>
              <ActionMenuButton
                onClick={() => {
                  setDetailsOpen(true);
                  setOpen(false);
                }}
              >
                Details
              </ActionMenuButton>
              {ownerControls ? (
                <ActionMenuButton
                  onClick={() => {
                    setShareOpen(true);
                    setOpen(false);
                  }}
                >
                  Share
                </ActionMenuButton>
              ) : null}
              {editorMode && onEditorModeChange ? (
                <ActionMenuButton
                  onClick={() => {
                    onEditorModeChange(editorMode === 'live' ? 'source' : 'live');
                    setOpen(false);
                  }}
                >
                  {editorMode === 'live' ? 'Source mode' : 'Live mode'}
                </ActionMenuButton>
              ) : null}
              {ownerControls ? (
                <>
                  <MoveNoteDialog
                    note={note}
                    onOpenChange={setOpen}
                    trigger={<ActionMenuItemLabel>Move note</ActionMenuItemLabel>}
                  />
                  <ActionMenuButton
                    disabled={duplicate.isPending}
                    onClick={() => {
                      duplicate.mutate();
                      setOpen(false);
                    }}
                  >
                    Duplicate
                  </ActionMenuButton>
                  <ActionMenuButton
                    onClick={() => {
                      setVersionsOpen(true);
                      setOpen(false);
                    }}
                  >
                    Version history
                  </ActionMenuButton>
                  <ActionMenuButton
                    onClick={() => {
                      navigate({ to: '/notes/$noteId/activity', params: { noteId: note.id } });
                      setOpen(false);
                    }}
                  >
                    View activity
                  </ActionMenuButton>
                  {onToggleApiEditable ? (
                    <ActionMenuButton
                      onClick={() => {
                        onToggleApiEditable();
                        setOpen(false);
                      }}
                    >
                      {note.isApiEditable ? 'Disable API edits' : 'Enable API edits'}
                    </ActionMenuButton>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {!propertiesOnly && canTrash ? (
            <DeleteConfirmDialog
              label="note"
              heading="Move note to Trash?"
              warning={
                ownerControls
                  ? 'You can restore this note later from Trash. Public share links will be revoked.'
                  : 'This note will move to the owner’s Trash. Only the owner can restore or permanently delete it.'
              }
              actionLabel="Move to Trash"
              requiresTypedConfirmation={false}
              onConfirm={onDelete}
              onOpenChange={setOpen}
              trigger={<ActionMenuItemLabel destructive>Move to Trash</ActionMenuItemLabel>}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <NoteDetailsDialog
        note={note}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        onNoteUpdated={onNoteUpdated}
        ownerControls={ownerControls}
      />
      {ownerControls ? <NoteShareDialog note={note} open={shareOpen} onOpenChange={setShareOpen} /> : null}
      {ownerControls ? (
        <NoteVersionsDialog
          note={note}
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          onNoteUpdated={onNoteUpdated}
        />
      ) : null}
    </>
  );
}
