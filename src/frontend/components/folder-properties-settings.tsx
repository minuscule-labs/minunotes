import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowUp, CalendarDays, ListFilter, Pencil, Plus, Trash2, Type } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PropertyDefinition, PropertyMutation, PropertyType } from '../../shared/properties';
import { ApiError, api } from '../lib/api';
import { ActionMenuButton, ActionMenuIconButton } from './ui/action-menu';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// Visible movement skips archived entries, but every historical ID remains in the request.
function activeNeighborIndex(items: { id: string; archived: boolean }[], id: string, direction: -1 | 1) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return -1;
  for (let neighbor = index + direction; neighbor >= 0 && neighbor < items.length; neighbor += direction) {
    if (!items[neighbor].archived) return neighbor;
  }
  return -1;
}
type Editor = {
  revision: number;
  field?: PropertyDefinition;
  optionId?: string;
  mode: 'field' | 'option';
  label: string;
  fieldType: PropertyType;
  options: string;
};
export function FolderPropertiesSettings({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['folder-properties', folderId],
    queryFn: () => api.folderProperties(folderId),
    retry: false,
  });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [actions, setActions] = useState<{ fieldId: string; optionId?: string } | null>(null);
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  const [deletion, setDeletion] = useState<{ fieldId: string; optionId: string; label: string } | null>(null);
  const deletionReturnFocus = useRef<{ fieldId: string; optionId: string } | null>(null);
  const [deletionError, setDeletionError] = useState('');
  const [needsDeletionReview, setNeedsDeletionReview] = useState(false);
  const deletionPreview = useQuery({
    queryKey: ['option-deletion-preview', folderId, deletion?.fieldId, deletion?.optionId],
    queryFn: () => {
      if (!deletion) throw new Error('No option selected');
      return api.previewOptionDeletion(folderId, deletion.fieldId, deletion.optionId);
    },
    enabled: !!deletion,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: 'always',
  });
  const invalidateDeletionDependents = () => {
    for (const key of [
      'note-properties',
      'board',
      'notes',
      'note',
      'note-events',
      'template-defaults',
      'template-default-schema',
      'folder-templates',
      'assigned-template-preview',
    ])
      void qc.invalidateQueries({ queryKey: [key] });
  };
  const removeOption = useMutation({
    mutationFn: (preview: NonNullable<typeof deletionPreview.data>) =>
      api.deletePropertyOption(folderId, preview.propertyId, preview.optionId, {
        schemaId: preview.schemaId,
        expectedRevision: preview.expectedRevision,
        impactToken: preview.impactToken,
      }),
    retry: false,
    onSuccess: (result, preview) => {
      qc.setQueryData(['folder-properties', folderId], result);
      setDeletion(null);
      setManagedId(preview.propertyId);
      setDeletionError('');
      invalidateDeletionDependents();
    },
    onError: (e: Error) => {
      setDeletionError(e.message);
      setNeedsDeletionReview(true);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        setDeletion(null);
        setManagedId(null);
      }
      // A lost response may have committed: refresh reads, never retry deletion automatically.
      void query.refetch();
      invalidateDeletionDependents();
    },
  });
  useEffect(() => {
    const active = query.data?.definitions.filter((field) => !field.archived);
    if (managedId && (query.error || !active?.some((field) => field.id === managedId))) setManagedId(null);
    if (actions) {
      const field = active?.find((field) => field.id === actions.fieldId);
      if (
        query.error ||
        !field ||
        (actions.optionId && !field.options.some((option) => option.id === actions.optionId && !option.archived))
      )
        setActions(null);
    }
    if (deletion) {
      const field = active?.find((field) => field.id === deletion.fieldId);
      if (query.error || !field?.options.some((option) => option.id === deletion.optionId && !option.archived))
        setDeletion(null);
    }
  }, [query.data, query.error, managedId, actions, deletion]);
  useEffect(() => {
    if (deletionPreview.error instanceof ApiError && [401, 403, 404].includes(deletionPreview.error.status)) {
      setDeletion(null);
      setManagedId(null);
      void query.refetch();
    }
  }, [deletionPreview.error]);
  const save = useMutation({
    mutationFn: ({ expectedRevision, mutation }: { expectedRevision: number; mutation: PropertyMutation }) =>
      api.mutateFolderProperties(folderId, { expectedRevision, mutation }),
    onSuccess: (result, { mutation }) => {
      qc.setQueryData(['folder-properties', folderId], result);
      if (mutation.type === 'add_option') setManagedId(mutation.propertyId);
      void qc.invalidateQueries({ queryKey: ['note-properties'] });
      setEditor(null);
      setError('');
    },
    onError: (e: Error) => {
      setError(`${e.message}. Draft preserved; refresh the schema, review changes, then retry.`);
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) setEditor(null);
      void query.refetch();
    },
  });
  const refreshEditor = async () => {
    if (!editor || refreshing || save.isPending) return;
    setRefreshing(true);
    const fresh = await query.refetch();
    setRefreshing(false);
    // A failed refetch can still contain cached data. It must not advance the draft revision.
    if (fresh.isError || !fresh.data) {
      setError('Schema refresh failed. Draft preserved; refresh successfully and review before retrying.');
      if (fresh.error instanceof ApiError && [401, 403, 404].includes(fresh.error.status)) setEditor(null);
      return;
    }
    const field = editor.field ? fresh.data.definitions.find((d) => d.id === editor.field?.id) : undefined;
    if (editor.field && (!field || field.archived || field.type !== editor.field.type)) {
      setError('This property is archived or unavailable. Draft preserved; it cannot be applied to this target.');
      return;
    }
    if (editor.optionId && !field?.options.some((o) => o.id === editor.optionId && !o.archived)) {
      setError('This option is archived or unavailable. Draft preserved; it cannot be applied to this target.');
      return;
    }
    const revision = fresh.data.revision;
    // Inputs remain editable during the read; retain their latest values, not the captured draft.
    setEditor((current) => (current ? { ...current, field, revision } : current));
    setError('');
  };
  if (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status)) return null;
  const schema = query.data;
  const mutate = (mutation: PropertyMutation) => schema && save.mutate({ expectedRevision: schema.revision, mutation });
  const begin = (field?: PropertyDefinition, optionId?: string, mode: 'field' | 'option' = 'field') => {
    if (!schema || editor || deletion || save.isPending || removeOption.isPending) return;
    editorReturnFocus.current = field
      ? document.getElementById(`folder-property-${folderId}-${field.id}`)
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setManagedId(null);
    setActions(null);
    setError('');
    setEditor({
      revision: schema.revision,
      field,
      optionId,
      mode,
      label: optionId
        ? (field?.options.find((o) => o.id === optionId)?.label ?? '')
        : mode === 'option'
          ? ''
          : (field?.label ?? ''),
      fieldType: field?.type ?? 'text',
      options: '',
    });
  };
  return (
    <section className="rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4">
      <h3 className="font-semibold">Properties</h3>
      <p className="notes-muted mt-1 text-xs">Properties for notes in this folder.</p>
      {query.isLoading ? <p className="notes-muted text-sm">Loading properties...</p> : null}
      {query.error ? <p role="alert">Properties could not load.</p> : null}
      <ul aria-label="Folder properties" className="mt-3 space-y-0.5">
        {schema?.definitions
          .filter((d) => !d.archived)
          .map((field) => {
            const index = schema.definitions.findIndex((d) => d.id === field.id);
            const previous = activeNeighborIndex(schema.definitions, field.id, -1);
            const next = activeNeighborIndex(schema.definitions, field.id, 1);
            const Icon = field.type === 'select' ? ListFilter : field.type === 'date' ? CalendarDays : Type;
            const typeLabel = { text: 'Text', select: 'Select', date: 'Date' }[field.type];
            return (
              <li
                key={field.id}
                className="flex min-w-0 items-start gap-2 rounded-md focus-within:bg-[var(--notes-hover)] hover:bg-[var(--notes-hover)]"
              >
                <Popover
                  open={!query.error && !editor && !deletion && managedId === field.id}
                  onOpenChange={(open) => {
                    setManagedId(open ? field.id : null);
                    if (open) setActions(null);
                  }}
                >
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      id={`folder-property-${folderId}-${field.id}`}
                      aria-label={`Manage ${field.label}`}
                      disabled={save.isPending || !!editor || !!deletion}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
                    >
                      <Icon aria-hidden="true" className="notes-muted mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 break-words">{field.label}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    collisionPadding={12}
                    aria-label={`Manage property ${field.label}`}
                    onOpenAutoFocus={(event) => {
                      const target = deletionReturnFocus.current;
                      if (!target || target.fieldId !== field.id) return;
                      event.preventDefault();
                      const option = document.getElementById(
                        `folder-property-${folderId}-${field.id}-option-${target.optionId}`
                      );
                      const rename = document.getElementById(`folder-property-${folderId}-${field.id}-rename`);
                      (option ?? rename)?.focus();
                      deletionReturnFocus.current = null;
                    }}
                    className="max-h-[min(28rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-24px)] overflow-y-auto p-3 text-sm"
                    onCloseAutoFocus={(event) => {
                      if (editor || deletion) event.preventDefault();
                    }}
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <h4 className="break-words font-medium">{field.label}</h4>
                        <p className="notes-muted mt-1 text-xs">{typeLabel}</p>
                      </div>
                      <button
                        type="button"
                        id={`folder-property-${folderId}-${field.id}-rename`}
                        aria-label={`Rename ${field.label}`}
                        disabled={save.isPending}
                        onClick={() => begin(field)}
                        className="rounded p-2 hover:bg-[var(--notes-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
                      >
                        <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {field.type === 'select' ? (
                      <>
                        <ul aria-label={`Options for ${field.label}`} className="mt-3 space-y-0.5">
                          {field.options
                            .filter((o) => !o.archived)
                            .map((option) => (
                              <li
                                key={option.id}
                                className="flex min-w-0 items-start gap-1 rounded-md focus-within:bg-[var(--notes-hover)] hover:bg-[var(--notes-hover)]"
                              >
                                <button
                                  type="button"
                                  aria-label={`Rename option ${option.label}`}
                                  disabled={save.isPending}
                                  onClick={() => begin(field, option.id, 'option')}
                                  className="min-w-0 flex-1 break-words rounded px-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
                                >
                                  {option.label}
                                </button>
                                <Popover
                                  open={
                                    !editor &&
                                    !query.error &&
                                    actions?.fieldId === field.id &&
                                    actions?.optionId === option.id
                                  }
                                  onOpenChange={(open) =>
                                    setActions(open ? { fieldId: field.id, optionId: option.id } : null)
                                  }
                                >
                                  <PopoverTrigger asChild>
                                    <ActionMenuIconButton
                                      id={`folder-property-${folderId}-${field.id}-option-${option.id}`}
                                      aria-label={`Actions for option ${option.label}`}
                                      disabled={save.isPending}
                                      className="shrink-0 hover:bg-transparent!"
                                    />
                                  </PopoverTrigger>
                                  <PopoverContent
                                    align="end"
                                    collisionPadding={12}
                                    aria-label={`Actions for option ${option.label}`}
                                    className="max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[calc(100vw-24px)] overflow-y-auto"
                                    onCloseAutoFocus={(event) => {
                                      if (editor || deletion) event.preventDefault();
                                    }}
                                  >
                                    <ActionMenuButton
                                      disabled={save.isPending || activeNeighborIndex(field.options, option.id, -1) < 0}
                                      aria-label={`Move option ${option.label} up`}
                                      onClick={() => {
                                        const previous = activeNeighborIndex(field.options, option.id, -1);
                                        if (previous < 0) return;
                                        const ids = field.options.map((o) => o.id),
                                          index = ids.indexOf(option.id);
                                        [ids[previous], ids[index]] = [ids[index], ids[previous]];
                                        setActions(null);
                                        mutate({ type: 'reorder_options', propertyId: field.id, optionIds: ids });
                                      }}
                                    >
                                      <ArrowUp aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                                      Move up
                                    </ActionMenuButton>
                                    <ActionMenuButton
                                      disabled={save.isPending || activeNeighborIndex(field.options, option.id, 1) < 0}
                                      aria-label={`Move option ${option.label} down`}
                                      onClick={() => {
                                        const next = activeNeighborIndex(field.options, option.id, 1);
                                        if (next < 0) return;
                                        const ids = field.options.map((o) => o.id),
                                          index = ids.indexOf(option.id);
                                        [ids[next], ids[index]] = [ids[index], ids[next]];
                                        setActions(null);
                                        mutate({ type: 'reorder_options', propertyId: field.id, optionIds: ids });
                                      }}
                                    >
                                      <ArrowDown aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                                      Move down
                                    </ActionMenuButton>
                                    <ActionMenuButton
                                      disabled={save.isPending || field.options.filter((o) => !o.archived).length <= 1}
                                      aria-label={`Delete option ${option.label}`}
                                      onClick={() => {
                                        if (save.isPending || deletion) return;
                                        deletionReturnFocus.current = { fieldId: field.id, optionId: option.id };
                                        setActions(null);
                                        setManagedId(null);
                                        setDeletionError('');
                                        setNeedsDeletionReview(false);
                                        setDeletion({ fieldId: field.id, optionId: option.id, label: option.label });
                                      }}
                                    >
                                      <Trash2 aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                                      Delete option
                                    </ActionMenuButton>
                                  </PopoverContent>
                                </Popover>
                              </li>
                            ))}
                        </ul>
                        <button
                          type="button"
                          aria-label={`Add option to ${field.label}`}
                          disabled={save.isPending || field.options.filter((o) => !o.archived).length >= 8}
                          onClick={() => begin(field, undefined, 'option')}
                          className="notes-muted mt-2 inline-flex items-center gap-2 rounded px-2 py-2 text-xs hover:enabled:bg-[var(--notes-hover)] disabled:opacity-40"
                        >
                          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                          Add option
                        </button>
                      </>
                    ) : null}
                  </PopoverContent>
                </Popover>
                <Popover
                  open={!query.error && !editor && !deletion && actions?.fieldId === field.id && !actions?.optionId}
                  onOpenChange={(open) => {
                    setActions(open ? { fieldId: field.id } : null);
                    if (open) setManagedId(null);
                  }}
                >
                  <PopoverTrigger asChild>
                    <ActionMenuIconButton
                      aria-label={`Actions for property ${field.label}`}
                      disabled={save.isPending || !!editor || !!deletion}
                      className="shrink-0 hover:bg-transparent!"
                    />
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    collisionPadding={12}
                    aria-label={`Actions for property ${field.label}`}
                    className="max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[calc(100vw-24px)] overflow-y-auto"
                    onCloseAutoFocus={(event) => {
                      if (editor || deletion) event.preventDefault();
                    }}
                  >
                    <ActionMenuButton
                      disabled={save.isPending}
                      aria-label={`Rename ${field.label}`}
                      onClick={() => begin(field)}
                    >
                      <Pencil aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                      Rename
                    </ActionMenuButton>
                    <ActionMenuButton
                      disabled={save.isPending || previous < 0}
                      aria-label={`Move ${field.label} up`}
                      onClick={() => {
                        if (previous < 0) return;
                        const ids = schema.definitions.map((d) => d.id);
                        [ids[previous], ids[index]] = [ids[index], ids[previous]];
                        setActions(null);
                        mutate({ type: 'reorder', propertyIds: ids });
                      }}
                    >
                      <ArrowUp aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                      Move up
                    </ActionMenuButton>
                    <ActionMenuButton
                      disabled={save.isPending || next < 0}
                      aria-label={`Move ${field.label} down`}
                      onClick={() => {
                        if (next < 0) return;
                        const ids = schema.definitions.map((d) => d.id);
                        [ids[next], ids[index]] = [ids[index], ids[next]];
                        setActions(null);
                        mutate({ type: 'reorder', propertyIds: ids });
                      }}
                    >
                      <ArrowDown aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                      Move down
                    </ActionMenuButton>
                    <ActionMenuButton
                      disabled={save.isPending}
                      aria-label={`Archive ${field.label}`}
                      onClick={() => {
                        setActions(null);
                        mutate({ type: 'archive', propertyId: field.id });
                      }}
                    >
                      <Archive aria-hidden="true" className="mr-2 inline-block h-3.5 w-3.5" />
                      Archive
                    </ActionMenuButton>
                  </PopoverContent>
                </Popover>
              </li>
            );
          })}
      </ul>
      <button
        type="button"
        className="notes-muted mt-2 inline-flex items-center gap-2 rounded px-2 py-2 text-xs hover:enabled:bg-[var(--notes-hover)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
        disabled={
          !schema ||
          save.isPending ||
          !!editor ||
          !!deletion ||
          schema.definitions.filter((d) => !d.archived).length >= 12
        }
        onClick={() => begin()}
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        Add property
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-xs">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !save.isPending && !refreshing) setEditor(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md p-5"
          onCloseAutoFocus={(event) => {
            if (!query.error && editorReturnFocus.current?.isConnected) {
              event.preventDefault();
              editorReturnFocus.current.focus();
            }
          }}
        >
          <DialogTitle>{editor?.field ? 'Edit property' : 'Add property'}</DialogTitle>
          {editor ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (save.isPending || refreshing) return;
                let mutation: PropertyMutation;
                if (editor.mode === 'option' && editor.field)
                  mutation = editor.optionId
                    ? {
                        type: 'rename_option',
                        propertyId: editor.field.id,
                        optionId: editor.optionId,
                        label: editor.label,
                      }
                    : { type: 'add_option', propertyId: editor.field.id, label: editor.label };
                else
                  mutation = editor.field
                    ? { type: 'rename', propertyId: editor.field.id, label: editor.label }
                    : {
                        type: 'add',
                        label: editor.label,
                        fieldType: editor.fieldType,
                        ...(editor.fieldType === 'select'
                          ? { options: editor.options.split(',').map((s) => s.trim()) }
                          : {}),
                      };
                save.mutate({ expectedRevision: editor.revision, mutation });
              }}
            >
              <label className="block text-sm">
                Label
                <input
                  autoFocus
                  className="notes-input mt-1 w-full rounded px-2 py-1"
                  maxLength={80}
                  required
                  value={editor.label}
                  onChange={(e) => setEditor({ ...editor, label: e.target.value })}
                />
              </label>
              {!editor.field ? (
                <>
                  <label className="block text-sm">
                    Type
                    <select
                      aria-label="Type"
                      className="notes-input mt-1 w-full rounded px-2 py-1"
                      value={editor.fieldType}
                      onChange={(e) => setEditor({ ...editor, fieldType: e.target.value as PropertyType })}
                    >
                      <option value="text">Text</option>
                      <option value="select">Select</option>
                      <option value="date">Date</option>
                    </select>
                  </label>
                  {editor.fieldType === 'select' ? (
                    <label className="block text-sm">
                      Options (comma-separated)
                      <input
                        className="notes-input mt-1 w-full rounded px-2 py-1"
                        required
                        value={editor.options}
                        onChange={(e) => setEditor({ ...editor, options: e.target.value })}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {error ? (
                <p role="alert" className="text-xs">
                  {error}
                </p>
              ) : null}
              {error ? (
                <Button
                  variant="secondary"
                  disabled={save.isPending || refreshing}
                  type="button"
                  onClick={() => void refreshEditor()}
                >
                  Reload properties
                </Button>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  disabled={save.isPending || refreshing}
                  type="button"
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button disabled={save.isPending || refreshing} type="submit">
                  Save
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deletion}
        onOpenChange={(open) => {
          if (!open && !removeOption.isPending && deletion) {
            setManagedId(deletion.fieldId);
            setDeletion(null);
          }
        }}
      >
        <DialogContent
          className="top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md p-5"
          onCloseAutoFocus={(event) => {
            // The reopened manager owns focus; the deleted trigger may no longer exist.
            event.preventDefault();
          }}
        >
          <DialogTitle className="break-words">
            Delete “{deletionPreview.data?.optionLabel ?? deletion?.label}”?
          </DialogTitle>
          <DialogDescription className="notes-muted mt-2 text-sm">
            This permanently removes the option. Notes won’t be deleted. This cannot be undone.
          </DialogDescription>
          {deletionPreview.isFetching ? (
            <p role="status" className="mt-3 text-sm">
              Checking affected notes…
            </p>
          ) : null}
          {deletionPreview.data && !deletionPreview.isFetching && !deletionPreview.error ? (
            <div className="mt-3 space-y-2 text-sm">
              <p className="break-words">
                {deletionPreview.data.propertyLabel} will be cleared on {deletionPreview.data.noteCount}{' '}
                {deletionPreview.data.noteCount === 1 ? 'note' : 'notes'}.
              </p>
              <p className="notes-muted text-xs">Includes retained values on moved notes and notes in Trash.</p>
              {deletionPreview.data.templateDefaultCount > 0 ? (
                <p>
                  The option will also be cleared from {deletionPreview.data.templateDefaultCount}{' '}
                  {deletionPreview.data.templateDefaultCount === 1 ? 'template default' : 'template defaults'}.
                </p>
              ) : null}
            </div>
          ) : null}
          {deletionError || deletionPreview.error ? (
            <p role="alert" className="mt-3 text-sm">
              {deletionError || deletionPreview.error?.message} Review the impact again before confirming.
            </p>
          ) : null}
          {needsDeletionReview || deletionPreview.error ? (
            <Button
              className="mt-3"
              type="button"
              disabled={deletionPreview.isFetching || removeOption.isPending}
              onClick={() => {
                setDeletionError('');
                setNeedsDeletionReview(false);
                void deletionPreview.refetch();
              }}
            >
              Review impact again
            </Button>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              autoFocus
              type="button"
              disabled={removeOption.isPending}
              onClick={() => {
                if (!deletion) return;
                setManagedId(deletion.fieldId);
                setDeletion(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                !deletionPreview.data ||
                deletionPreview.isFetching ||
                !!deletionPreview.error ||
                needsDeletionReview ||
                removeOption.isPending
              }
              onClick={() => {
                if (
                  deletionPreview.data &&
                  !deletionPreview.isFetching &&
                  !deletionPreview.error &&
                  !needsDeletionReview &&
                  !removeOption.isPending
                )
                  removeOption.mutate(deletionPreview.data);
              }}
            >
              {removeOption.isPending ? 'Deleting…' : 'Delete option'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
