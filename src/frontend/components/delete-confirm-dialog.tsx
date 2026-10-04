import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';
import { ModalCloseButton } from './ui/modal-close-button';

export function DeleteConfirmDialog({
  label,
  heading,
  warning,
  actionLabel = 'Delete',
  triggerLabel,
  requiresTypedConfirmation = true,
  onConfirm,
  trigger,
  onOpenChange,
  open: controlledOpen,
  hideTrigger = false,
  returnFocusRef,
}: {
  label: string;
  heading?: string;
  warning: string;
  actionLabel?: string;
  triggerLabel?: string;
  requiresTypedConfirmation?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
  trigger?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  hideTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLButtonElement | null>(null);
  const confirmationInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeOpen = (nextOpen: boolean) => {
    if (pending && !nextOpen) return;
    setOpen(nextOpen);
    if (!nextOpen) window.setTimeout(() => (returnFocusRef?.current ?? previousFocusRef.current)?.focus(), 0);
    setValue('');
    setError(null);
    onOpenChange?.(nextOpen);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      changeOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${actionLabel.toLowerCase()}`);
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {hideTrigger ? null : trigger ? (
        <button
          ref={triggerRef}
          type="button"
          className="rounded-md"
          aria-haspopup="dialog"
          onClick={(event) => {
            previousFocusRef.current = event.currentTarget;
            changeOpen(true);
          }}
        >
          {trigger}
        </button>
      ) : (
        <DialogTrigger asChild>
          <Button variant="destructive">{triggerLabel ?? actionLabel}</Button>
        </DialogTrigger>
      )}
      <DialogContent
        role="alertdialog"
        className="left-1/2 top-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg notes-modal-scroll p-4 sm:p-5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          window.requestAnimationFrame(() =>
            (requiresTypedConfirmation ? confirmationInputRef.current : cancelButtonRef.current)?.focus()
          );
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current ?? previousFocusRef.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle className="font-semibold text-lg">{heading ?? `Delete ${label}`}</DialogTitle>
            <DialogDescription className="notes-muted mt-2 text-sm">{warning}</DialogDescription>
          </div>
          <ModalCloseButton label={`Close delete ${label}`} disabled={pending} onClick={() => changeOpen(false)} />
        </div>
        {requiresTypedConfirmation ? (
          <>
            <p className="mt-4 text-sm">
              Type <strong>delete</strong> to confirm.
            </p>
            <input
              ref={confirmationInputRef}
              className="notes-input mt-2 w-full rounded-md px-3 py-2"
              value={value}
              disabled={pending}
              aria-label={`Type delete to confirm ${label}`}
              onChange={(event) => setValue(event.target.value)}
            />
          </>
        ) : null}
        {error ? (
          <p className="mt-3 text-red-500 text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelButtonRef} disabled={pending} onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || (requiresTypedConfirmation && value !== 'delete')}
            variant="destructive"
            onClick={() => void confirm()}
          >
            {pending ? 'Working…' : actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
