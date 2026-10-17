import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ListFilter, SlidersHorizontal, Type } from 'lucide-react';
import { useId, useState } from 'react';
import { type BoardConfig, DEFAULT_BOARD_CONFIG, validateBoardConfig } from '../../shared/board';
import type { PropertySchema } from '../../shared/properties';
import { api, type SavedBoard } from '../lib/api';
import { Button } from './ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { QuickTooltip } from './ui/tooltip';

export function FolderBoardSettingsDialog({ folderId, board }: { folderId: string; board: SavedBoard | null }) {
  const [open, setOpen] = useState(false);
  const groupingId = useId();
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
  const eligible = schema?.definitions.filter((d) => !d.archived && d.type === 'select') ?? [];
  const selected = eligible.find((d) => d.id === propertyId);
  const displayFields =
    schema?.definitions.filter((d) => !d.archived && ['text', 'select', 'date'].includes(d.type)) ?? [];
  const unavailableIds = cardPropertyIds.filter((id) => !displayFields.some((d) => d.id === id));
  const unavailableSelection = !reviewing && !!schema && ((!!propertyId && !selected) || unavailableIds.length > 0);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (config: BoardConfig) =>
      api.saveBoardConfig(
        folderId,
        config,
        expectedVersion,
        schema?.schemaId ? { schemaId: schema.schemaId, schemaRevision: schema.revision } : undefined
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['board', folderId] });
      setOpen(false);
    },
    onError: (error: Error) => setError(error.message),
  });
  const begin = () => {
    const config = board?.config ?? DEFAULT_BOARD_CONFIG;
    setDraft(structuredClone(config));
    setPropertyId(config.grouping.propertyId);
    setCardPropertyIds([...config.cardPropertyIds]);
    setKnownDisplayIds([...config.cardPropertyIds]);
    setSchema(null);
    setReviewing(true);
    void qc
      .fetchQuery({
        queryKey: ['folder-properties', folderId],
        queryFn: () => api.folderProperties(folderId),
        staleTime: 0,
      })
      .then((current) => {
        setSchema(current);
        if (!board) {
          const active = current.definitions.filter((d) => !d.archived && d.type === 'select');
          setPropertyId(active.find((d) => d.label.trim().toLowerCase() === 'status')?.id ?? '');
          setCardPropertyIds([]);
        }
      })
      .catch((error: Error) => setError(error.message))
      .finally(() => setReviewing(false));
    setExpectedVersion(board?.version ?? 0);
    setError('');
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) begin();
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
            try {
              const config = validateBoardConfig({
                schemaVersion: 4,
                mode: 'read-only',
                enabled: draft.enabled,
                grouping: { type: 'select', schemaId: schema?.schemaId ?? draft.grouping.schemaId, propertyId },
                cardPropertyIds,
              });
              setError('');
              save.mutate(config);
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
                  disabled={reviewing}
                  value={propertyId}
                  onChange={(event) => setPropertyId(event.target.value)}
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
            <fieldset disabled={reviewing} className="min-w-0 space-y-2 text-sm">
              <legend className="mb-2">Card properties</legend>
              <p className="notes-muted text-xs">Shown on cards for everyone. Save board to apply.</p>
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
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-3 text-sm">
              <span>Columns</span>
              {selected ? (
                <ol aria-label="Select column preview" className="flex min-w-0 flex-wrap gap-1 text-xs">
                  {selected.options
                    .filter((o) => !o.archived)
                    .map((o) => (
                      <li
                        key={o.id}
                        className="rounded border border-[var(--notes-border)] px-1.5 py-1 [overflow-wrap:anywhere]"
                      >
                        {o.label}
                      </li>
                    ))}
                  <li className="rounded border border-[var(--notes-border)] px-1.5 py-1">Unclassified</li>
                </ol>
              ) : (
                <p className="notes-muted text-xs">Choose a grouping property.</p>
              )}
            </div>
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
                  setReviewing(true);
                  try {
                    const [current, definitions] = await Promise.all([
                      api.boardConfig(folderId),
                      api.folderProperties(folderId),
                    ]);
                    setExpectedVersion(current.board?.version ?? 0);
                    setSchema(definitions);
                    setError('');
                  } catch (error) {
                    setError(error instanceof Error ? error.message : 'Review failed');
                  } finally {
                    setReviewing(false);
                  }
                }}
              >
                Refresh and review
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={save.isPending || reviewing || (draft.enabled && (!selected || unavailableIds.length > 0))}
            >
              {save.isPending ? 'Saving…' : 'Save board'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
