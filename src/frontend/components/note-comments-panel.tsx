import { Check, MessageSquare, MoreHorizontal, RotateCcw, Trash2, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { CommentReactionEmoji, CommentThread } from '../lib/api';
import { CommentMarkdownPreview } from './comment-markdown-preview';
import { formatCommentTime, NoteCommentDiscussion } from './note-comment-discussion';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './ui/popover';
import { QuickTooltip } from './ui/tooltip';

export { formatCommentTime } from './note-comment-discussion';

export function NoteCommentsPanel({
  open,
  threads,
  selectedThreadId,
  busy,
  error,
  onClose,
  onSelect,
  onReply,
  onStatusChange,
  onEditMessage,
  onDeleteMessage,
  onDeleteThread,
  onToggleReaction,
  canManageAnyThread,
  canModerate,
  inline = false,
  onCreate,
  composerRef,
  loading = false,
}: {
  open: boolean;
  inline?: boolean;
  onCreate?: (body: string) => Promise<void>;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  loading?: boolean;
  canManageAnyThread: boolean;
  canModerate: boolean;
  threads: CommentThread[];
  selectedThreadId: string | null;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSelect: (thread: CommentThread) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onStatusChange: (thread: CommentThread) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onToggleReaction: (threadId: string, messageId: string, emoji: CommentReactionEmoji) => Promise<void>;
}) {
  const [replyBody, setReplyBody] = useState('');
  const [body, setBody] = useState('');
  const submitting = useRef(false);

  useEffect(() => setReplyBody(''), [selectedThreadId]);

  const list = (
    <div
      className={
        inline
          ? 'space-y-3'
          : 'notes-modal-scroll max-h-[calc(82dvh-4.5rem)] space-y-3 overflow-y-auto p-3 md:max-h-[calc(100dvh-4.5rem)]'
      }
    >
      {error ? (
        <p className="rounded-md border border-[var(--notes-button-destructive-border)] bg-[var(--notes-button-destructive-bg)] px-2 py-1.5 text-[var(--notes-button-destructive-text)] text-xs">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p role="status" className="text-[var(--notes-muted)] text-sm">
          Loading…
        </p>
      ) : null}
      {!loading && !error && threads.length === 0 ? (
        <div className="py-8 text-center text-[var(--notes-muted)] text-sm">
          <MessageSquare className="mx-auto mb-2 h-5 w-5" />
          <p>No comments yet.</p>
        </div>
      ) : null}

      {threads.map((thread) => {
        const selected = thread.id === selectedThreadId;
        const canChangeStatus = canManageAnyThread || thread.authoredByCurrentActor;
        const canDeleteThread = canModerate || thread.authoredByCurrentActor;
        return (
          <section
            key={thread.id}
            className={`rounded-lg border p-3 ${
              selected
                ? 'border-[var(--notes-button-secondary-border)] bg-[var(--notes-hover)]'
                : 'border-[var(--notes-border)] bg-[var(--notes-bg)]'
            } ${thread.status === 'resolved' ? 'opacity-70' : ''}`}
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <button type="button" className="min-w-0 text-left" onClick={() => onSelect(thread)}>
                <span className="block truncate font-semibold text-xs">{thread.createdBy.label}</span>
                <span className="block text-[11px] text-[var(--notes-muted)]">
                  {thread.target === 'text' && thread.anchor.detached
                    ? 'Detached'
                    : thread.status === 'resolved'
                      ? 'Resolved'
                      : 'Open'}{' '}
                  · {formatCommentTime(thread.updatedAt)}
                </span>
              </button>
              {canChangeStatus || canDeleteThread ? (
                <div className="flex shrink-0 gap-0.5">
                  {canChangeStatus ? (
                    <QuickTooltip label={thread.status === 'resolved' ? 'Reopen comment' : 'Resolve comment'}>
                      <button
                        type="button"
                        className="rounded p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-panel)] hover:text-[var(--notes-text)]"
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
                    <Popover>
                      <QuickTooltip label="More discussion actions">
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="rounded p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-panel)] hover:text-[var(--notes-text)]"
                            aria-label="More discussion actions"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </PopoverTrigger>
                      </QuickTooltip>
                      <PopoverContent align="end" className="w-44">
                        <PopoverClose asChild>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[var(--notes-button-destructive-text)] text-sm hover:bg-[var(--notes-button-destructive-soft-hover)]"
                            onClick={() => void onDeleteThread(thread.id).catch(() => undefined)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete discussion
                          </button>
                        </PopoverClose>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              ) : null}
            </div>

            {thread.target !== 'text' ? null : thread.anchor.detached ? (
              <p className="mb-3 rounded bg-[var(--notes-panel-muted)] px-2 py-1 text-[var(--notes-muted)] text-xs">
                The commented text changed and could not be reattached.
              </p>
            ) : (
              <blockquote className="mb-3 line-clamp-3 whitespace-pre-line border-[var(--notes-border)] border-l-2 pl-2 text-[var(--notes-muted)] text-xs">
                <CommentMarkdownPreview value={thread.anchor.quote} />
              </blockquote>
            )}

            <NoteCommentDiscussion
              thread={thread}
              busy={busy}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
              onToggleReaction={onToggleReaction}
              canModerate={canModerate}
            />

            {selected && thread.status === 'open' ? (
              <form
                className="mt-3 border-[var(--notes-border)] border-t pt-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !replyBody.trim()) return;
                  void onReply(thread.id, replyBody)
                    .then(() => setReplyBody(''))
                    .catch(() => undefined);
                }}
              >
                <textarea
                  className="min-h-20 w-full resize-y rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg)] p-2 text-sm outline-none focus:border-[var(--notes-blue)]"
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  placeholder="Reply…"
                />
                <div className="mt-1 flex justify-end">
                  <button
                    type="submit"
                    className="rounded border border-[var(--notes-button-secondary-border)] bg-[var(--notes-button-secondary-bg)] px-2.5 py-1 font-medium text-[var(--notes-button-secondary-text)] text-xs hover:bg-[var(--notes-button-secondary-hover)] disabled:opacity-50"
                    disabled={busy || !replyBody.trim()}
                  >
                    Reply
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  if (inline)
    return (
      <section
        aria-label="Discussion"
        className="mx-auto max-w-3xl scroll-mt-20 border-[var(--notes-border)] border-t px-4 py-6 sm:px-6"
      >
        <h2 className="mb-4 font-semibold text-sm">Discussion</h2>
        <form
          className="mb-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || loading || submitting.current || !body.trim() || !onCreate) return;
            submitting.current = true;
            void onCreate(body)
              .then(() => setBody(''))
              .catch(() => undefined)
              .finally(() => {
                submitting.current = false;
              });
          }}
        >
          <textarea
            ref={composerRef}
            aria-label="New discussion comment"
            placeholder="Write a comment…"
            maxLength={10_000}
            disabled={busy}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-24 w-full resize-y rounded-md border border-[var(--notes-border)] bg-[var(--notes-bg)] p-2 text-sm outline-none focus:border-[var(--notes-blue)]"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={busy || loading || !body.trim()}
              className="rounded border border-[var(--notes-button-secondary-border)] bg-[var(--notes-button-secondary-bg)] px-3 py-1.5 text-[var(--notes-button-secondary-text)] text-xs hover:bg-[var(--notes-button-secondary-hover)] disabled:opacity-50"
            >
              Post
            </button>
          </div>
        </form>
        {list}
      </section>
    );

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        className="inset-x-0 bottom-0 max-h-[82dvh] overflow-hidden rounded-t-2xl md:inset-y-0 md:right-0 md:left-auto md:h-full md:max-h-none md:w-[28rem] md:rounded-none md:border-y-0 md:border-r-0"
        aria-label="Review comments"
      >
        <div className="flex items-start justify-between gap-3 border-[var(--notes-border)] border-b px-4 py-4">
          <div>
            <DialogTitle className="flex items-center gap-2 font-semibold text-sm">
              <MessageSquare className="h-4 w-4 text-[var(--notes-muted)]" />
              Review
            </DialogTitle>
            <DialogDescription className="notes-muted mt-1 text-xs">
              {threads.length} comment thread{threads.length === 1 ? '' : 's'}
            </DialogDescription>
          </div>
          <QuickTooltip label="Close Review">
            <DialogClose asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--notes-muted)] hover:bg-[var(--notes-hover)] hover:text-[var(--notes-text)]"
                aria-label="Close Review"
              >
                <X className="h-4 w-4" />
              </button>
            </DialogClose>
          </QuickTooltip>
        </div>
        {list}
      </DialogContent>
    </Dialog>
  );
}
