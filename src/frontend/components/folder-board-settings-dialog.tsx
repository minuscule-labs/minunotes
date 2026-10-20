import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ListFilter, SlidersHorizontal, Type } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { type BoardConfig, type BoardSchemaToken, DEFAULT_BOARD_CONFIG, validateBoardConfig } from '../../shared/board';
import type { PropertySchema } from '../../shared/properties';
import { ApiError, api, type SavedBoard } from '../lib/api';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { QuickTooltip } from './ui/tooltip';

export function FolderBoardSettingsDialog({ folderId, board }: { folderId: string; board: SavedBoard | null }) {
  const [open, setOpen] = useState(false);
  const groupingId = useId();
  const opening = useRef(0);
  useEffect(
    () => () => {
      opening.current++;
    },
    []
  );
  // Capture version together with draft. Query refreshes must never silently upgrade an open draft.
  const [draft, setDraft] = useState<BoardConfig>(DEFAULT_BOARD_CONFIG);
  const [expectedVersion, setExpectedVersion] = useState(0);
  const [error, setError] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [cardPropertyIds, setCardPropertyIds] = useState<string[]>([]);
  // Keep removed unavailable rows mounted for keyboard focus and deliberate undo until dismissal.
  const [knownDisplayIds, setKnownDisplayIds] = useState<string[]>([]);
  const [schema, setSchema] = useState<PropertySchema | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [knownColumnIds, setKnownColumnIds] = useState<string[]>([]);
  const [groupingChanged, setGroupingChanged] = useState(false);
  const visibility = draft.columnVisibility;
  const eligible = schema?.definitions.filter((d) => !d.archived && d.type === 'select') ?? [];
  const selected = schema?.schemaId === draft.grouping.schemaId ? eligible.find((d) => d.id === propertyId) : undefined;
  const activeOptions = selected?.options.filter((o) => !o.archived) ?? [];
  const unavailableColumnIds =
    visibility.mode === 'selected' ? visibility.optionIds.filter((id) => !activeOptions.some((o) => o.id === id)) : [];
  const hasVisibleOptions = activeOptions.some((o) => visibility.mode === 'all' || visibility.optionIds.includes(o.id));
  const displayFields =
    schema?.definitions.filter((d) => !d.archived && ['text', 'select', 'date'].includes(d.type)) ?? [];
  const unavailableIds = cardPropertyIds.filter((id) => !displayFields.some((d) => d.id === id));
  const unavailableSelection =
    !reviewing &&
    !!schema &&
    ((!!propertyId && !selected) || unavailableIds.length > 0 || unavailableColumnIds.length > 0);
  const chooseColumns = (ids: string[], showUnclassified?: boolean) => {
    setKnownColumnIds((known) => [...new Set([...known, ...ids])]);
    setDraft((previous) => ({
      ...previous,
      columnVisibility: {
        mode: 'selected',
        optionIds: ids,
        showUnclassified: showUnclassified ?? previous.columnVisibility.showUnclassified,
      },
    }));
  };
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (input: { config: BoardConfig; version: number; schema?: BoardSchemaToken; opening: number }) =>
      api.saveBoardConfig(folderId, input.config, input.version, input.schema),
    retry: false,
    onSuccess: async (_result, input) => {
      await qc.invalidateQueries({ queryKey: ['board', folderId] });
      if (opening.current !== input.opening) return;
      opening.current++;
      setOpen(false);
    },
    onError: (error: Error, input) => {
      if (opening.current !== input.opening) return;
      setError(error.message);
      if (error instanceof ApiError && error.status === 409) setNeedsReview(true);
    },
  });
  const begin = () => {
    const attempt = ++opening.current;
    const config = board?.config ?? DEFAULT_BOARD_CONFIG;
    setDraft(structuredClone(config));
    setKnownColumnIds(config.columnVisibility.mode === 'selected' ? [...config.columnVisibility.optionIds] : []);
    setGroupingChanged(false);
    setNeedsReview(false);
    setPropertyId(config.grouping.propertyId);
    setCardPropertyIds([...config.cardPropertyIds]);
    setKnownDisplayIds([...config.cardPropertyIds]);
    setSchema(null);
    setReviewing(true);
    // Each opening owns its read; do not reuse a previous opening's in-flight query or retry it.
    void api
      .folderProperties(folderId)
      .then((current) => {
        if (opening.current !== attempt) return;
        setSchema(current);
        if (!board) {
          const active = current.definitions.filter((d) => !d.archived && d.type === 'select');
          const suggested = active.find((d) => d.label.trim().toLowerCase() === 'status')?.id ?? '';
          setPropertyId(suggested);
          setDraft((previous) => ({
            ...previous,
            grouping: { type: 'select', schemaId: current.schemaId ?? '', propertyId: suggested },
          }));
        }
      })
      .catch((error: Error) => {
        if (opening.current === attempt) setError(error.message);
      })
      .finally(() => {
        if (opening.current === attempt) setReviewing(false);
      });
    setExpectedVersion(board?.version ?? 0);
    setError('');
  };
  const saveBlocked =
    save.isPending ||
    reviewing ||
    needsReview ||
    (draft.enabled && (!schema?.schemaId || !selected || unavailableIds.length > 0 || unavailableColumnIds.length > 0));
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) begin();
        else opening.current++;
        setOpen(value);
      }}
    >
      <QuickTooltip label="Board settings">
        <DialogTrigger asChild>
          <Button
            type="button"
            aria-label="Board settings"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center p-0!"
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          </Button>
        </DialogTrigger>
      </QuickTooltip>
      <DialogContent
        aria-describedby={undefined}
        className="top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-md p-5"
      >
        <DialogTitle className="font-semibold text-lg">Board settings</DialogTitle>
        {board?.reconfigurationRequired ? (
          <p role="alert" className="mt-3 text-sm">
            Retired tag settings will be replaced. Review the grouping property and save explicitly to show this
            property-only board. Note tags will not change.
          </p>
        ) : null}
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (saveBlocked) return;
            try {
              const config = validateBoardConfig({
                schemaVersion: 5,
                mode: 'read-only',
                enabled: draft.enabled,
                grouping: { ...draft.grouping, propertyId },
                cardPropertyIds,
                columnVisibility: draft.columnVisibility,
              });
              setError('');
              save.mutate({
                config,
                version: expectedVersion,
                opening: opening.current,
                schema: schema?.schemaId ? { schemaId: schema.schemaId, schemaRevision: schema.revision } : undefined,
              });
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Invalid settings');
            }
          }}
        >
          <fieldset disabled={save.isPending} className="space-y-3">
            <legend className="sr-only">Board configuration</legend>
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-sm">
              Enabled
              <input
                type="checkbox"
                className="justify-self-start"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
            </label>
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 text-sm">
              <label htmlFor={groupingId} className="py-1">
                Columns
              </label>
              <div className="min-w-0 space-y-2">
                <select
                  id={groupingId}
                  className="notes-input block w-full rounded px-2 py-1"
                  disabled={reviewing || !schema}
                  value={propertyId}
                  onChange={(event) => {
                    const id = event.target.value;
                    const changed = !!propertyId && id !== propertyId;
                    setPropertyId(id);
                    setDraft((previous) => ({
                      ...previous,
                      grouping: { type: 'select', schemaId: schema?.schemaId ?? '', propertyId: id },
                      columnVisibility: changed
                        ? {
                            mode: 'selected',
                            optionIds: [],
                            showUnclassified: previous.columnVisibility.showUnclassified,
                          }
                        : previous.columnVisibility,
                    }));
                    if (changed) {
                      setKnownColumnIds([]);
                      setGroupingChanged(true);
                    }
                  }}
                >
                  <option value="">Choose a Select property</option>
                  {propertyId && !selected ? <option value={propertyId}>Unavailable selection</option> : null}
                  {eligible.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
                {!reviewing && schema && !eligible.length ? (
                  <p>No active Select properties. Define one in folder Properties settings.</p>
                ) : null}
                {!reviewing && schema && propertyId && !selected ? (
                  <p role="alert">Grouping property unavailable. Choose another or disable the board.</p>
                ) : null}
              </div>
            </div>
            <fieldset disabled={reviewing || !schema} className="min-w-0 space-y-2 text-sm">
              <legend className="mb-2">Visible columns</legend>
              {groupingChanged ? (
                <p className="notes-muted text-xs">
                  Grouping changed. Review the fresh column selection before saving.
                </p>
              ) : null}
              {activeOptions.map((option) => (
                <label key={option.id} className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={visibility.mode === 'all' || visibility.optionIds.includes(option.id)}
                    onChange={(event) => {
                      const currentIds =
                        visibility.mode === 'all' ? activeOptions.map((o) => o.id) : visibility.optionIds;
                      chooseColumns(
                        event.target.checked ? [...currentIds, option.id] : currentIds.filter((id) => id !== option.id)
                      );
                    }}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {option.label}
                    <span className="sr-only"> (grouping option)</span>
                  </span>
                </label>
              ))}
              {visibility.mode === 'selected' && schema
                ? knownColumnIds
                    .filter((id) => !activeOptions.some((o) => o.id === id))
                    .map((id) => (
                      <label key={id} className="flex min-w-0 items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0"
                          checked={visibility.optionIds.includes(id)}
                          onChange={(event) => {
                            const ids = event.target.checked
                              ? [...visibility.optionIds, id]
                              : visibility.optionIds.filter((value) => value !== id);
                            chooseColumns(ids);
                          }}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {schema.definitions.find((d) => d.id === propertyId)?.options.find((o) => o.id === id)
                            ?.label ?? `Column ${id}`}{' '}
                          (unavailable grouping option)
                        </span>
                      </label>
                    ))
                : null}
              {!reviewing && schema && unavailableColumnIds.length > 0 ? (
                <p role="alert">Visible columns unavailable. Remove them or disable the board.</p>
              ) : null}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={visibility.showUnclassified}
                  onChange={(event) =>
                    chooseColumns(
                      visibility.mode === 'all' ? activeOptions.map((o) => o.id) : visibility.optionIds,
                      event.target.checked
                    )
                  }
                />
                Unclassified
              </label>
              {reviewing || !schema || !selected || (!hasVisibleOptions && !visibility.showUnclassified) ? (
                <p role="status" className="text-xs">
                  {reviewing
                    ? 'Loading column definitions…'
                    : !schema
                      ? 'Column definitions could not be loaded.'
                      : !selected
                        ? 'Choose a grouping property.'
                        : 'No columns selected — this Board will show no cards.'}
                </p>
              ) : null}
            </fieldset>
            <fieldset disabled={reviewing || !schema} className="min-w-0 space-y-2 text-sm">
              <legend className="mb-2">Card properties</legend>
              {displayFields.map((field) => {
                const Icon = field.type === 'select' ? ListFilter : field.type === 'date' ? CalendarDays : Type;
                return (
                  <label key={field.id} className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={cardPropertyIds.includes(field.id)}
                      onChange={(event) => {
                        if (event.target.checked)
                          setKnownDisplayIds((ids) => (ids.includes(field.id) ? ids : [...ids, field.id]));
                        setCardPropertyIds((ids) =>
                          event.target.checked ? [...ids, field.id] : ids.filter((id) => id !== field.id)
                        );
                      }}
                    />
                    <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{field.label}</span>
                    <span className="notes-muted ml-auto shrink-0 text-xs">{field.type}</span>
                  </label>
                );
              })}
              {!reviewing && schema && !displayFields.length ? (
                <p>No active properties. Define fields in folder Properties settings.</p>
              ) : null}
              {knownDisplayIds
                .filter((id) => !displayFields.some((field) => field.id === id))
                .map((id) => (
                  <label key={id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={cardPropertyIds.includes(id)}
                      onChange={(event) =>
                        setCardPropertyIds((ids) =>
                          event.target.checked ? [...ids, id] : ids.filter((current) => current !== id)
                        )
                      }
                    />
                    <span>
                      {schema?.definitions.find((d) => d.id === id)?.label ?? 'Unavailable property'} (unavailable)
                    </span>
                  </label>
                ))}
              {!reviewing && schema && unavailableIds.length ? (
                <p role="alert">Card properties unavailable. Remove them or disable the board.</p>
              ) : null}
            </fieldset>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm">
              {error} Your draft has been kept. Refresh and review current settings before retrying.
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button type="button">Cancel</Button>
            </DialogClose>
            {error || unavailableSelection ? (
              <Button
                type="button"
                disabled={save.isPending || reviewing}
                onClick={async () => {
                  const attempt = opening.current;
                  setReviewing(true);
                  try {
                    const [current, definitions] = await Promise.all([
                      api.boardConfig(folderId),
                      api.folderProperties(folderId),
                    ]);
                    if (opening.current !== attempt) return;
                    setExpectedVersion(current.board?.version ?? 0);
                    setSchema(definitions);
                    // A brand-new draft can recover a failed initial schema read without resetting choices.
                    if (!draft.grouping.schemaId && !propertyId && !board)
                      setDraft((previous) => ({
                        ...previous,
                        grouping: { ...previous.grouping, schemaId: definitions.schemaId ?? '' },
                      }));
                    setNeedsReview(false);
                    setError('');
                  } catch (error) {
                    if (opening.current === attempt) setError(error instanceof Error ? error.message : 'Review failed');
                  } finally {
                    if (opening.current === attempt) setReviewing(false);
                  }
                }}
              >
                Refresh and review
              </Button>
            ) : null}
            <Button type="submit" disabled={saveBlocked}>
              {save.isPending ? 'Saving…' : 'Save board'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
