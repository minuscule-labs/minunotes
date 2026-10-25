import type { EditorCommentAnchor } from '@dpklabs/minueditor';
import { Check, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommentReactionEmoji, CommentThread } from '../lib/api';
import { CommentMarkdownPreview } from './comment-markdown-preview';
import { NoteCommentDiscussion } from './note-comment-discussion';
import { QuickTooltip } from './ui/tooltip';

export type CommentDialogPosition = { top: number; left: number; placement: 'above' | 'below' };

export function NoteCommentDialog({
  open,
  position,
  thread,
  draftAnchor,
  busy,
  error,
  onClose,
  onCreate,
  onReply,
  onStatusChange,
  onEditMessage,
  onDeleteMessage,
  onDeleteThread,
  onToggleReaction,
  canManageAnyThread,
  canModerate,
}: {
  open: boolean;
  canManageAnyThread: boolean;
  canModerate: boolean;
  position: CommentDialogPosition | null;
  thread: CommentThread | null;
  draftAnchor: EditorCommentAnchor | null;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onCreate: (body: string, anchor: EditorCommentAnchor) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onStatusChange: (thread: CommentThread) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onToggleReaction: (threadId: string, messageId: string, emoji: CommentReactionEmoji) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setBody(''), [draftAnchor, thread?.id]);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, draftAnchor, thread?.id]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const closeOnClickAway = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || dialogRef.current?.contains(target)) return;
      if (target.closest('[data-radix-popper-content-wrapper], .me-comment-anchor, .me-comment-gutter-badge')) return;
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnClickAway);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnClickAway);
    };
  }, [onClose, open]);

  if (!open || (!draftAnchor && !thread)) return null;

  const submit = async () => {
    if (busy || !body.trim()) return;
    if (draftAnchor) await onCreate(body, draftAnchor);
    else if (thread) await onReply(thread.id, body);
    setBody('');
  };
  const quote = draftAnchor?.quote ?? thread?.anchor?.quote ?? '';
  const canChangeStatus = Boolean(thread && (canManageAnyThread || thread.authoredByCurrentActor));
  const canDeleteThread = Boolean(thread && (canModerate || thread.authoredByCurrentActor));
  const anchoredStyle =
    position && typeof window !== 'undefined' && window.innerWidth >= 640
      ? {
          top: position.top,
          left: position.left,
          transform: position.placement === 'above' ? 'translateY(-100%)' : undefined,
          maxHeight:
            position.placement === 'above'
              ? `min(70dvh, 34rem, ${Math.max(0, position.top - 12)}px)`
              : `min(70dvh, 34rem, calc(100dvh - ${position.top + 12}px))`,
        }
      : undefined;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-label={draftAnchor ? 'Add comment' : 'Comment thread'}
      className="fixed inset-x-3 bottom-3 z-50 flex max-h-[min(70dvh,34rem)] flex-col overflow-hidden rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] text-[var(--notes-text)] shadow-2xl sm:inset-x-auto sm:bottom-auto sm:w-[28rem]"
      style={anchoredStyle}
    >
      <header className="flex items-center justify-between border-[var(--notes-border)] border-b px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-[var(--notes-muted)]" />
          <p className="truncate font-semibold text-sm">{draftAnchor ? 'Add comment' : 'Comment'}</p>
        </div>
        <QuickTooltip label="Close comment">
          <button
            type="button"
            className="rounded-md p-1 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
            onClick={onClose}
            aria-label="Close comment"
          >
            <X className="h-4 w-4" />
          </button>
        </QuickTooltip>
      </header>

      <div className="notes-modal-scroll space-y-3 overflow-y-auto p-3">
        <blockquote className="line-clamp-3 whitespace-pre-line border-[var(--notes-border)] border-l-2 pl-2 text-[var(--notes-muted)] text-xs">
          <CommentMarkdownPreview value={quote} />
        </blockquote>

        {thread?.anchor?.detached ? (
          <p className="rounded bg-[var(--notes-panel-muted)] px-2 py-1.5 text-[var(--notes-muted)] text-xs">
            The original text could not be reattached.
          </p>
        ) : null}

        {thread ? (
          <NoteCommentDiscussion
            thread={thread}
            busy={busy}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            onToggleReaction={onToggleReaction}
            canModerate={canModerate}
          />
        ) : null}

        {error ? (
          <p className="rounded-md border border-[var(--notes-button-destructive-border)] bg-[var(--notes-button-destructive-bg)] px-2 py-1.5 text-[var(--notes-button-destructive-text)] text-xs">
            {error}
          </p>
        ) : null}

        {draftAnchor || thread?.status === 'open' ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit().catch(() => undefined);
            }}
          >
            <textarea
              ref={inputRef}
              className="min-h-20 w-full resize-y rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg)] p-2 text-sm outline-none focus:border-[var(--notes-blue)]"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={draftAnchor ? 'Leave a comment…' : 'Reply…'}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              {thread && (canChangeStatus || canDeleteThread) ? (
                <div className="flex gap-1">
                  {canChangeStatus ? (
                    <QuickTooltip label={thread.status === 'resolved' ? 'Reopen comment' : 'Resolve comment'}>
                      <button
                        type="button"
                        className="rounded p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                        onClick={() => void onStatusChange(thread).catch(() => undefined)}
                        aria-label={thread.status === 'resolved' ? 'Reopen comment' : 'Resolve comment'}
                      >
                        {thread.status === 'resolved' ? (
                          <RotateCcw className="h-3.5 w-3.5" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </QuickTooltip>
                  ) : null}
                  {canDeleteThread ? (
                    <QuickTooltip label="Delete comment thread">
                      <button
                        type="button"
                        className="rounded p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-button-destructive-soft-hover)] hover:text-[var(--notes-button-destructive-text)]"
                        onClick={() => void onDeleteThread(thread.id).catch(() => undefined)}
                        aria-label="Delete comment thread"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </QuickTooltip>
                  ) : null}
                </div>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded px-2 py-1 text-[var(--notes-muted)] text-xs hover:bg-[var(--notes-hover)]"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded border border-[var(--notes-button-secondary-border)] bg-[var(--notes-button-secondary-bg)] px-2.5 py-1 font-medium text-[var(--notes-button-secondary-text)] text-xs hover:bg-[var(--notes-button-secondary-hover)] disabled:opacity-50"
                  disabled={busy || !body.trim()}
                >
                  {draftAnchor ? 'Comment' : 'Reply'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--notes-muted)] text-xs">Resolved</span>
            {canChangeStatus ? (
              <button
                type="button"
                className="rounded border border-[var(--notes-button-secondary-border)] bg-[var(--notes-button-secondary-bg)] px-2 py-1 text-[var(--notes-button-secondary-text)] text-xs hover:bg-[var(--notes-button-secondary-hover)]"
                onClick={() => void (thread ? onStatusChange(thread) : Promise.resolve()).catch(() => undefined)}
              >
                Reopen
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
