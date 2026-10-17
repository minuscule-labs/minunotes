import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarDays, Check, ChevronDown, ListFilter, Plus, Type, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { isCalendarDate, type NoteProperties } from '../../shared/properties';
import { ApiError, api } from '../lib/api';
import { forgetEmptyDraft } from '../lib/empty-draft';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from './ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

type Draft = {
  base: NoteProperties;
  values: Record<string, string | null>;
  ready?: string[];
  invalidDates?: string[];
  folderId?: string | null;
};
// Keep the lock across a quick unmount/remount of the same note, too. No unmount flush.
const pendingWrites = new Map<string, Promise<NoteProperties>>();
const sameSchema = (a: NoteProperties, b: NoteProperties) =>
  a.schema.schemaId === b.schema.schemaId && a.schema.revision === b.schema.revision;
const savedValue = (data: NoteProperties, id: string) => {
  const value = data.values[id];
  const field = data.schema.definitions.find((field) => field.id === id);
  if (!field) return 'Field unavailable';
  if (value == null) return 'Not set';
  if (field.type !== 'select') return value;
  const option = field.options.find((option) => option.id === value);
  return option ? `${option.label}${option.archived ? ' (archived)' : ''}` : `${value} (unavailable)`;
};
export function NotePropertiesPanel({
  noteId,
  canEdit,
  isOwner,
  folderId,
  modalOnly = false,
  modalOpen = false,
  onModalOpenChange,
  onReturnFocus,
}: {
  noteId: string;
  canEdit: boolean;
  isOwner: boolean;
  folderId: string | null;
  modalOnly?: boolean;
  modalOpen?: boolean;
  onModalOpenChange?: (open: boolean) => void;
  onReturnFocus?: () => void;
}) {
  const key = ['note-properties', noteId];
  const storageKey = `minunotes:properties-draft:${noteId}`;
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [busy, setBusy] = useState(pendingWrites.has(noteId));
  const [paused, setPaused] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState<NoteProperties | null>(null);
  const [restoreReady, setRestoreReady] = useState(false);
  const query = useQuery({ queryKey: key, queryFn: () => api.noteProperties(noteId), retry: false });
  const inaccessible = revoked || (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status));
  const live = useRef({
    mounted: true,
    generation: 0,
    canEdit,
    accessible: !inaccessible,
    folderId,
    draft: null as Draft | null,
    latest: query.data,
    paused: false,
    restored: false,
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
  });
  live.current.canEdit = canEdit;
  live.current.accessible = !inaccessible;
  live.current.folderId = folderId;
  live.current.latest = query.data;
  const pump = useRef(() => {});
  const cancelTimers = () => {
    for (const timer of live.current.timers.values()) clearTimeout(timer);
    live.current.timers.clear();
  };
  const pause = (reason: string) => {
    live.current.paused = true;
    setPaused(true);
    cancelTimers();
    setMessage(reason);
  };
  const updateDraft = (next: Draft | null) => {
    live.current.draft = next;
    setDraft(next);
    try {
      if (next) window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* Preserve the in-memory draft. */
    }
  };
  const revoke = () => {
    live.current.accessible = false;
    live.current.generation++;
    cancelTimers();
    updateDraft(null);
    setRevoked(true);
    setPicker(null);
    setReviewed(null);
    setReviewing(false);
    qc.removeQueries({ queryKey: key });
  };
  useEffect(() => {
    const state = live.current;
    state.mounted = true;
    const pending = pendingWrites.get(noteId);
    if (pending) {
      const settled = () => {
        if (state.mounted) setBusy(false);
      };
      void pending.then(settled, settled);
    }
    return () => {
      state.mounted = false;
      state.generation++;
      for (const timer of state.timers.values()) clearTimeout(timer);
      state.timers.clear();
    };
  }, [noteId]);
  useEffect(() => {
    if (inaccessible) {
      live.current.generation++;
      live.current.paused = true;
      for (const timer of live.current.timers.values()) clearTimeout(timer);
      live.current.timers.clear();
      live.current.draft = null;
      setRevoked(true);
      setDraft(null);
      setPicker(null);
      setReviewed(null);
      setReviewing(false);
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* In-memory metadata is cleared. */
      }
      qc.removeQueries({ queryKey: ['note-properties', noteId] });
    } else if (!canEdit) {
      live.current.generation++;
      live.current.paused = !!live.current.draft || pendingWrites.has(noteId);
      setPaused(live.current.paused);
      setReviewing(false);
      if (live.current.draft) setMessage('Editing unavailable. Local changes kept for review.');
      setPicker(null);
      for (const timer of live.current.timers.values()) clearTimeout(timer);
      live.current.timers.clear();
    }
  }, [inaccessible, canEdit, storageKey, noteId, qc]);
  useEffect(() => {
    if (!query.data || !query.isFetchedAfterMount || query.error || !canEdit || inaccessible || live.current.restored)
      return;
    live.current.restored = true;
    try {
      const stored = window.sessionStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Draft;
        if (parsed.base?.schema && parsed.values) {
          live.current.draft = parsed;
          live.current.paused = true;
          setDraft(parsed);
          setPaused(true);
          setMessage('Recovered properties draft — review before retrying. Changes kept.');
        }
      }
    } catch {
      /* An unavailable draft store must not block the editor. */
    }
    setRestoreReady(true);
  }, [query.data, query.isFetchedAfterMount, query.error, canEdit, inaccessible, storageKey]);
  const previousFolder = useRef(folderId);
  useEffect(() => {
    if (previousFolder.current !== folderId) {
      previousFolder.current = folderId;
      live.current.generation++;
      setReviewing(false);
      for (const timer of live.current.timers.values()) clearTimeout(timer);
      live.current.timers.clear();
    }
    const pending = live.current.draft;
    if (
      pending &&
      query.data &&
      !live.current.paused &&
      (!sameSchema(pending.base, query.data) || (pending.folderId !== undefined && pending.folderId !== folderId))
    ) {
      live.current.paused = true;
      setPaused(true);
      setMessage('The folder schema changed. Changes kept; use Review changes.');
      for (const timer of live.current.timers.values()) clearTimeout(timer);
      live.current.timers.clear();
    }
  }, [query.data, folderId]);
  pump.current = () => {
    const state = live.current;
    const current = state.draft;
    if (
      !state.mounted ||
      !state.canEdit ||
      !state.accessible ||
      state.paused ||
      !current ||
      !state.latest ||
      pendingWrites.has(noteId)
    )
      return;
    if (
      !sameSchema(current.base, state.latest) ||
      (current.folderId !== undefined && current.folderId !== state.folderId)
    ) {
      pause('The folder schema changed. Changes kept; use Review changes.');
      return;
    }
    const values = Object.fromEntries(
      Object.entries(current.values).filter(([id, value]) => {
        const field = current.base.schema.definitions.find((field) => field.id === id);
        return (
          current.ready?.includes(id) &&
          !current.invalidDates?.includes(id) &&
          (field?.type !== 'date' || value === null || isCalendarDate(value))
        );
      })
    );
    if (!Object.keys(values).length) return;
    // Take an immutable request snapshot and acquire the lock BEFORE any async callback.
    const snapshot = structuredClone({ ...current, values });
    const generation = state.generation;
    const requestFolder = state.folderId;
    setBusy(true);
    const request = api.patchNoteProperties(noteId, {
      schemaId: snapshot.base.schema.schemaId,
      schemaRevision: snapshot.base.schema.revision,
      expectedRevision: snapshot.base.revision,
      values: snapshot.values,
    });
    pendingWrites.set(noteId, request);
    const stillAuthorized = () =>
      state.mounted &&
      state.accessible &&
      state.canEdit &&
      state.generation === generation &&
      state.folderId === requestFolder;
    void request
      .then(
        (result) => {
          if (!stillAuthorized()) return;
          const cached = qc.getQueryData<NoteProperties>(key);
          if (!sameSchema(snapshot.base, result)) {
            pause('The folder schema changed while saving. Changes kept; use Review changes.');
            return;
          }
          const drift = cached && (!sameSchema(snapshot.base, cached) || cached.revision > result.revision);
          if (!drift) {
            state.latest = result;
            qc.setQueryData(key, result);
          }
          const pending = state.draft;
          if (pending) {
            // Advance ONLY the metadata revision of the captured schema, never its identities/labels.
            const base = { ...pending.base, revision: result.revision, values: result.values };
            const remaining = Object.fromEntries(
              Object.entries(pending.values).filter(
                ([id, value]) => pending.invalidDates?.includes(id) || value !== (base.values[id] ?? null)
              )
            );
            updateDraft(
              Object.keys(remaining).length
                ? {
                    ...pending,
                    base,
                    values: remaining,
                    ready: pending.ready?.filter((id) => Object.hasOwn(remaining, id)),
                  }
                : null
            );
          }
          if (drift) pause('Properties changed while saving. Changes kept; use Review changes.');
          else setMessage('');
          forgetEmptyDraft(noteId);
          // Never invalidate ['note', noteId]: its body may have an independent dirty draft.
          void qc.invalidateQueries({ queryKey: ['note-events', noteId] });
          void qc.invalidateQueries({ queryKey: ['notes'] });
        },
        (error: Error) => {
          if (!stillAuthorized()) return;
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) revoke();
          else pause(`Couldn't save — changes kept. ${error.message}`);
        }
      )
      .finally(() => {
        if (pendingWrites.get(noteId) === request) pendingWrites.delete(noteId);
        if (state.mounted) setBusy(false);
        if (stillAuthorized()) pump.current();
      });
  };
  useEffect(() => {
    if (inaccessible && modalOpen) onModalOpenChange?.(false);
  }, [inaccessible, modalOpen, onModalOpenChange]);
  const present = (children: ReactNode) => {
    if (modalOnly || modalOpen)
      return (
        <Dialog
          open={modalOpen}
          onOpenChange={(open) => {
            setPicker(null);
            onModalOpenChange?.(open);
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            className="top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md p-5"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              onReturnFocus?.();
            }}
          >
            <DialogTitle className="font-semibold text-lg">Properties</DialogTitle>
            <div aria-busy={busy} className="mt-4 text-sm">
              {children}
            </div>
            <div className="mt-4 flex justify-end">
              <DialogClose asChild>
                <Button type="button">Close</Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      );
    return (
      <details
        open={inlineOpen}
        aria-busy={busy}
        className="max-h-[40dvh] overflow-y-auto border-[var(--notes-border)] border-b bg-[var(--notes-bg)] px-3 py-2 text-sm"
        onToggle={(event) => {
          setInlineOpen(event.currentTarget.open);
          if (!event.currentTarget.open) setPicker(null);
        }}
      >
        <summary className="cursor-pointer font-medium">Properties</summary>
        {children}
      </details>
    );
  };
  const presentStatus = (children: ReactNode) => (modalOnly || modalOpen ? present(children) : children);
  const editable = canEdit && !inaccessible;
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  if (inaccessible) return presentStatus(<p className="notes-muted px-3 py-2 text-xs">Properties unavailable</p>);
  if (query.error)
    return presentStatus(
      <div className="notes-muted px-3 py-2 text-xs">
        Properties could not load.{' '}
        <Button variant="secondary" onClick={() => void query.refetch()}>
          Retry properties
        </Button>
      </div>
    );
  // Do not display a stored draft before a current authorized metadata read succeeds.
  if (!query.data || !query.isFetchedAfterMount || (canEdit && !restoreReady))
    return modalOpen ? present(<p role="status">Loading properties…</p>) : null;
  const current = draft?.base ?? query.data;
  const canManage = isOwner && !!folderId;
  if (!current || (!current.schema.definitions.length && !draft && !canManage))
    return modalOpen ? present(<p className="notes-muted">No properties defined for this note.</p>) : null;
  const change = (
    id: string,
    value: string | null,
    timing: 'immediate' | 'text' | 'date' = 'immediate',
    invalid = false
  ) => {
    if (!editable) return;
    const state = live.current;
    const pending = state.draft;
    const base = pending?.base ?? qc.getQueryData<NoteProperties>(key) ?? state.latest;
    if (!base) return;
    const timer = state.timers.get(id);
    if (timer) clearTimeout(timer);
    state.timers.delete(id);
    const values = { ...pending?.values, [id]: value };
    const invalidDates = new Set(pending?.invalidDates);
    if (invalid) invalidDates.add(id);
    else invalidDates.delete(id);
    const ready = new Set(pending?.ready);
    if (timing === 'immediate') ready.add(id);
    else ready.delete(id);
    // Retain edit->revert while a write is pending or its acceptance is unknown.
    if (!invalid && !pendingWrites.has(noteId) && !state.paused && value === (base.values[id] ?? null))
      delete values[id];
    if (Object.keys(values).length) forgetEmptyDraft(noteId);
    updateDraft(
      Object.keys(values).length
        ? {
            base,
            values,
            ready: [...ready],
            invalidDates: [...invalidDates],
            folderId: pending?.folderId === undefined ? folderId : pending.folderId,
          }
        : null
    );
    if (!state.paused) setMessage('');
    if (timing === 'text' && Object.hasOwn(values, id)) {
      state.timers.set(
        id,
        setTimeout(() => {
          state.timers.delete(id);
          const latest = state.draft;
          if (!latest || !state.mounted || !state.canEdit || !state.accessible) return;
          updateDraft({ ...latest, ready: [...new Set([...(latest.ready ?? []), id])] });
          pump.current();
        }, 500)
      );
    } else if (timing === 'immediate') pump.current();
  };
  const captureDate = (id: string, input: HTMLInputElement, explicitEmpty = false) => {
    const invalid = !input.validity.valid || (input.value !== '' && !isCalendarDate(input.value));
    // A recovered partial date may have no native segments left. Mere focus/blur isn't consent to clear it.
    if (!invalid && input.value === '' && live.current.draft?.invalidDates?.includes(id) && !explicitEmpty) return;
    const value = invalid ? input.value : input.value || null;
    const pending = live.current.draft;
    if (
      pending &&
      Object.hasOwn(pending.values, id) &&
      pending.values[id] === value &&
      !!pending.invalidDates?.includes(id) === invalid
    )
      return;
    change(id, value, 'date', invalid);
  };
  const flush = (id: string, input: HTMLInputElement, date: boolean) => {
    if (!editable) return;
    const pending = live.current.draft;
    if (!pending || !Object.hasOwn(pending.values, id)) return;
    const valid =
      !date ||
      (input.validity.valid &&
        !pending.invalidDates?.includes(id) &&
        (input.value === '' || isCalendarDate(input.value)));
    if (!valid) return;
    const timer = live.current.timers.get(id);
    if (timer) clearTimeout(timer);
    live.current.timers.delete(id);
    updateDraft({ ...pending, ready: [...new Set([...(pending.ready ?? []), id])] });
    pump.current();
  };
  const retry = () => {
    if (!editable || pendingWrites.has(noteId) || reviewing || !live.current.draft) return;
    const pending = live.current.draft;
    // Explicit retry flushes text, but never promotes an unfinished/uncommitted date.
    const ready = new Set(pending.ready ?? Object.keys(pending.values));
    for (const field of pending.base.schema.definitions)
      if (field.type === 'text' && Object.hasOwn(pending.values, field.id)) ready.add(field.id);
    updateDraft({ ...pending, ready: [...ready] });
    live.current.paused = false;
    setPaused(false);
    setMessage('');
    pump.current();
  };
  const reload = async () => {
    if (pendingWrites.has(noteId) || reviewing) return;
    pause('Loading latest properties; changes kept.');
    setReviewing(true);
    const generation = live.current.generation;
    const latest = await query.refetch();
    if (!live.current.mounted || !live.current.accessible || generation !== live.current.generation) return;
    setReviewing(false);
    if (latest.error || !latest.data) {
      setMessage('Latest properties could not load. Changes kept.');
      return;
    }
    setReviewed(latest.data);
    const pending = live.current.draft;
    if (!pending) {
      live.current.paused = false;
      setPaused(false);
      setMessage('Latest properties loaded.');
      return;
    }
    const removed = Object.keys(pending.values).some((id) => !latest.data.schema.definitions.some((d) => d.id === id));
    const retiredChoice = Object.entries(pending.values).some(([id, value]) => {
      const field = latest.data.schema.definitions.find((d) => d.id === id);
      return (
        value !== null &&
        field?.type === 'select' &&
        !field.options.some((o) => o.id === value && !o.archived) &&
        latest.data.values[id] !== value
      );
    });
    if (removed) {
      setMessage('A drafted field was archived or moved. Changes kept; copy it before discarding.');
      return;
    }
    if (retiredChoice) {
      setMessage('A drafted choice was archived. Changes kept; clear or replace it, then use Review changes.');
      return;
    }
    const remaining = Object.fromEntries(
      Object.entries(pending.values).filter(
        ([id, value]) => pending.invalidDates?.includes(id) || value !== (latest.data.values[id] ?? null)
      )
    );
    updateDraft(Object.keys(remaining).length ? { ...pending, base: latest.data, values: remaining, folderId } : null);
    if (!Object.keys(remaining).length) {
      live.current.paused = false;
      setPaused(false);
    }
    setMessage('Latest properties loaded; changes kept. Review current saved values, then retry explicitly.');
  };
  return present(
    <>
      <div className={modalOpen ? 'mt-2 space-y-1' : 'mt-2 w-full max-w-96 space-y-1'}>
        {current.schema.definitions.map((field) => {
          const value = Object.hasOwn(draft?.values ?? {}, field.id)
            ? draft?.values[field.id]
            : current.values[field.id];
          const selected = field.options.find((option) => option.id === value);
          const retained = value != null && (!selected || selected.archived);
          const selectText =
            value == null
              ? 'Not set'
              : selected
                ? `${selected.label}${selected.archived ? ' (archived)' : ''}`
                : `${value} (unavailable)`;
          const Icon = field.type === 'select' ? ListFilter : field.type === 'date' ? CalendarDays : Type;
          const controlId = `property-${noteId}-${field.id}`;
          return (
            <div
              key={field.id}
              className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]"
            >
              <label className="notes-muted flex min-w-0 items-start gap-2 py-1.5 text-xs" htmlFor={controlId}>
                <Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{field.label}</span>
              </label>
              <div className="flex min-w-0 items-start gap-1">
                {field.type === 'select' ? (
                  <Popover
                    open={editable && picker === field.id}
                    onOpenChange={(open) => setPicker(open && editable ? field.id : null)}
                  >
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        id={controlId}
                        aria-label={field.label}
                        disabled={!editable}
                        className={`flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)] hover:enabled:bg-[var(--notes-hover)] disabled:cursor-default ${value == null || retained ? 'notes-muted' : ''}`}
                      >
                        <span className="min-w-0 flex-1 break-words">{selectText}</span>
                        {editable ? (
                          <ChevronDown aria-hidden="true" className="notes-muted mt-1 h-3 w-3 shrink-0" />
                        ) : null}
                      </button>
                    </PopoverTrigger>
                    {editable ? (
                      <PopoverContent
                        align="start"
                        collisionPadding={12}
                        aria-label={`Choose ${field.label}`}
                        className="max-h-[min(20rem,var(--radix-popover-content-available-height))] w-64 max-w-[calc(100vw-24px)] overflow-y-auto text-sm"
                      >
                        {retained ? <p className="notes-muted break-words px-2 py-1 text-xs">{selectText}</p> : null}
                        {field.options
                          .filter((option) => !option.archived)
                          .map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              aria-pressed={option.id === value}
                              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--notes-hover)] focus-visible:bg-[var(--notes-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
                              onClick={() => {
                                change(field.id, option.id);
                                setPicker(null);
                              }}
                            >
                              <span className="min-w-0 flex-1 break-words">{option.label}</span>
                              {option.id === value ? (
                                <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                              ) : null}
                            </button>
                          ))}
                        <button
                          type="button"
                          aria-label={`Clear ${field.label}`}
                          className="notes-muted mt-1 w-full rounded border-[var(--notes-border)] border-t px-2 py-1.5 text-left hover:bg-[var(--notes-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
                          onClick={() => {
                            change(field.id, null);
                            setPicker(null);
                          }}
                        >
                          Not set
                        </button>
                      </PopoverContent>
                    ) : null}
                  </Popover>
                ) : (
                  <input
                    id={controlId}
                    aria-label={field.label}
                    type={field.type === 'date' ? 'date' : 'text'}
                    maxLength={field.type === 'text' ? 1000 : undefined}
                    className="notes-input min-w-0 flex-1 rounded px-2 py-1"
                    value={value ?? ''}
                    readOnly={!editable}
                    aria-invalid={draft?.invalidDates?.includes(field.id) || undefined}
                    onInput={
                      field.type === 'date'
                        ? (event) => {
                            captureDate(field.id, event.currentTarget, true);
                          }
                        : undefined
                    }
                    onChange={
                      field.type === 'text' ? (event) => change(field.id, event.target.value || null, 'text') : () => {}
                    }
                    onBlur={(event) => {
                      if (field.type === 'date') captureDate(field.id, event.currentTarget);
                      flush(field.id, event.currentTarget, field.type === 'date');
                    }}
                    onKeyUp={(event) => {
                      // Native date segments can change badInput WITHOUT emitting an input event.
                      if (field.type === 'date' && event.key !== 'Enter') captureDate(field.id, event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (field.type === 'date' && event.key === 'Enter') flush(field.id, event.currentTarget, true);
                    }}
                  />
                )}
                {canEdit && value != null && picker !== field.id ? (
                  <button
                    type="button"
                    className="notes-muted shrink-0 rounded p-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)] hover:enabled:bg-[var(--notes-hover)]"
                    onClick={() => change(field.id, null)}
                    aria-label={`Clear ${field.label}`}
                  >
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              {paused && reviewed && draft && Object.hasOwn(draft.values, field.id) ? (
                <p className="notes-muted col-start-2 break-words px-2 text-xs">
                  Current saved {field.label}:{' '}
                  {reviewed.schema.schemaId === current.schema.schemaId
                    ? savedValue(reviewed, field.id)
                    : 'Unavailable in current folder'}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {canManage && folderId ? (
        <Link
          to="/folders/$folderId/settings"
          params={{ folderId }}
          className="notes-muted mt-2 inline-flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-[var(--notes-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--notes-muted)]"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add a property
        </Link>
      ) : null}
      {canEdit && paused && (current.schema.definitions.length > 0 || draft) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {draft && paused ? (
            <>
              <Button variant="secondary" disabled={busy || reviewing} onClick={retry}>
                Retry properties
              </Button>
              <Button
                variant="secondary"
                disabled={busy || reviewing}
                onClick={() => {
                  cancelTimers();
                  setPicker(null);
                  updateDraft(null);
                  live.current.paused = false;
                  setPaused(false);
                  setReviewed(null);
                  setMessage('Local unsaved changes discarded.');
                  void query.refetch();
                }}
              >
                Discard local unsaved changes
              </Button>
            </>
          ) : null}
          <Button variant="secondary" disabled={busy || reviewing} onClick={() => void reload()}>
            Review changes
          </Button>
        </div>
      ) : null}
      {paused || draft?.invalidDates?.length ? (
        <p role="status" className="notes-muted mt-2 text-xs">
          {paused ? message : 'Unsaved date — enter a complete valid date or clear explicitly.'}
        </p>
      ) : null}
    </>
  );
}
