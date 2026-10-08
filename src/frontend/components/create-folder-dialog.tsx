import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api, type Folder } from '../lib/api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';
import { ModalCloseButton } from './ui/modal-close-button';

export function CreateFolderDialog({
  parentFolder,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onCreated,
}: {
  parentFolder?: Folder;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCreated?: (folder: Folder) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const qc = useQueryClient();
  const mutation = useMutation({ mutationFn: (title: string) => api.createFolder(title, parentFolder?.id ?? null) });
  const form = useForm({
    defaultValues: { title: '' },
    onSubmit: async ({ value }) => {
      const title = value.title.trim();
      if (!title) return;
      const result = await mutation.mutateAsync(title);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['folders'] }),
        ...(parentFolder
          ? [
              qc.invalidateQueries({ queryKey: ['folder-detail', parentFolder.id] }),
              qc.invalidateQueries({ queryKey: ['shared-folder-navigation-roots'] }),
              qc.invalidateQueries({ queryKey: ['shared-folder-navigation-children'] }),
            ]
          : []),
      ]);
      form.reset();
      setOpen(false);
      onCreated?.(result.folder);
    },
  });
  const close = () => {
    mutation.reset();
    form.reset();
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          mutation.reset();
          form.reset();
          setOpen(true);
        } else close();
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="inset-x-0 bottom-0 rounded-t-xl p-4 sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(28rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle className="font-semibold text-lg">
              {parentFolder ? 'Create subfolder' : 'Create top-level folder'}
            </DialogTitle>
            <DialogDescription className="mt-1 text-[var(--notes-muted)] text-sm">
              {parentFolder ? `Add a folder under ${parentFolder.title}.` : 'Add a folder at the workspace root.'}
            </DialogDescription>
          </div>
          <ModalCloseButton label="Close folder dialog" disabled={mutation.isPending} onClick={close} />
        </div>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="title">
            {(field) => (
              <>
                <label htmlFor="new-folder-title" className="font-medium text-sm">
                  Folder name
                </label>
                <input
                  id="new-folder-title"
                  autoFocus
                  className="notes-input mt-2 w-full rounded-md px-3 py-2"
                  placeholder={parentFolder ? 'Subfolder name' : 'Folder name'}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Button type="button" onClick={close}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={mutation.isPending || !field.state.value.trim()}>
                    {mutation.isPending ? 'Creating...' : 'Create folder'}
                  </Button>
                </div>
              </>
            )}
          </form.Field>
          {mutation.error ? (
            <p className="mt-3 text-red-600 text-sm" role="alert">
              {mutation.error instanceof Error ? mutation.error.message : 'Unable to create folder.'}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
