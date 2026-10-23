import { Plus, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { NoteFilter } from '../../shared/note-filters';
import type { PropertyDefinition, PropertySchema } from '../../shared/properties';
import { Button } from './ui/button';

const inputClass =
  'min-w-0 w-full rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel)] px-2 py-2 text-sm text-[var(--notes-text)]';
function condition(schemaId: string, field: PropertyDefinition, operator: string): NoteFilter {
  const base = { schemaId, propertyId: field.id };
  if (operator === 'empty') return { ...base, type: field.type, operator: 'empty' };
  if (field.type === 'text') return { ...base, type: 'text', operator: 'contains', value: '' };
  if (field.type === 'select') return { ...base, type: 'select', operator: 'anyOf', optionIds: [] };
  return operator === 'between'
    ? { ...base, type: 'date', operator: 'between', from: '', to: '' }
    : { ...base, type: 'date', operator: operator === 'after' ? 'after' : 'before', value: '' };
}
function selectedIds(filter: NoteFilter): string[] {
  return filter.operator === 'is' ? [filter.optionId] : filter.operator === 'anyOf' ? filter.optionIds : [];
}
function includesEmpty(filter: NoteFilter): boolean {
  return filter.operator === 'empty' || (filter.operator === 'anyOf' && filter.includeEmpty === true);
}
export function FolderPropertyFilterPanel({
  filters,
  schema,
  schemaLoading,
  schemaError,
  error,
  onApply,
  onCancel,
}: {
  filters: NoteFilter[];
  schema?: PropertySchema;
  schemaLoading: boolean;
  schemaError?: string;
  error: string | null;
  onApply: (filters: NoteFilter[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(filters));
  const [selected, setSelected] = useState<string | null>(filters[0]?.propertyId ?? null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const panelId = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const clearAllRef = useRef<HTMLButtonElement>(null);
  const operatorRef = useRef<HTMLSelectElement>(null);
  const selectSearchRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<'add' | 'editor' | null>(null);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const target =
      pendingFocus.current === 'editor' ? (operatorRef.current ?? selectSearchRef.current) : addRef.current;
    pendingFocus.current = null;
    (target && !target.disabled ? target : clearAllRef.current)?.focus();
  }, [draft]);
  const fields = schema?.definitions.filter((field) => !field.archived) ?? [];
  const ordered = [...draft].sort(
    (a, b) =>
      (schema?.definitions.findIndex((field) => field.id === a.propertyId) ?? -1) -
      (schema?.definitions.findIndex((field) => field.id === b.propertyId) ?? -1)
  );
  const current = draft.find((filter) => filter.propertyId === selected);
  const fieldFor = (filter: NoteFilter) =>
    fields.find(
      (field) => field.id === filter.propertyId && field.type === filter.type && filter.schemaId === schema?.schemaId
    );
  const field = current ? fieldFor(current) : undefined;
  const update = (filter: NoteFilter) =>
    setDraft((items) => items.map((item) => (item.propertyId === filter.propertyId ? filter : item)));
  const ids = current ? selectedIds(current) : [];
  const emptySelected = current ? includesEmpty(current) : false;
  const chooseValues = (optionIds: string[], includeEmpty: boolean) => {
    if (!current) return;
    update({
      schemaId: current.schemaId,
      propertyId: current.propertyId,
      type: 'select',
      operator: 'anyOf',
      optionIds,
      ...(includeEmpty ? { includeEmpty: true as const } : {}),
    });
  };
  const options = field?.options.filter((option) => !option.archived) ?? [];
  const missing = ids.filter((id) => !options.some((option) => option.id === id));
  const visible = options.filter((option) => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const focusProperty = (id: string) => {
    setSelected(id);
    setSearch('');
    setAdding(false);
  };
  return (
    <>
      {schemaLoading ? (
        <p role="status" className="px-4 py-2 text-sm">
          Loading definitions…
        </p>
      ) : null}
      {schemaError ? (
        <p role="alert" className="px-4 py-2 text-sm">
          {schemaError}
        </p>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto sm:grid-cols-[12rem_minmax(0,1fr)] sm:overflow-hidden">
        <div className="min-w-0 border-[var(--notes-border)] border-b p-3 sm:overflow-y-auto sm:border-r sm:border-b-0">
          <nav
            aria-label="Filter properties"
            className="max-h-32 space-y-1 overflow-y-auto sm:max-h-none sm:overflow-visible"
          >
            {ordered.map((filter) => {
              const label = fieldFor(filter)?.label ?? 'Unavailable property';
              const count = filter.type === 'select' ? selectedIds(filter).length + Number(includesEmpty(filter)) : 1;
              return (
                <button
                  key={filter.propertyId}
                  type="button"
                  aria-label={`Edit ${label}`}
                  aria-describedby={count ? `${panelId}-${filter.propertyId}-count` : undefined}
                  aria-current={selected === filter.propertyId ? 'true' : undefined}
                  onClick={() => focusProperty(filter.propertyId)}
                  className={`flex w-full min-w-0 items-center gap-2 border-l-2 px-2 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)] ${selected === filter.propertyId ? 'border-[var(--notes-blue)] bg-[color-mix(in_srgb,var(--notes-blue)_10%,transparent)] text-[var(--notes-blue)]' : 'border-transparent hover:bg-[var(--notes-bg)]'}`}
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{label}</span>
                  {count ? (
                    <span
                      id={`${panelId}-${filter.propertyId}-count`}
                      className="shrink-0 rounded-sm bg-[color-mix(in_srgb,var(--notes-blue)_18%,transparent)] px-1.5 text-xs"
                    >
                      {count}
                      <span className="sr-only"> selected</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <Button
            ref={addRef}
            className="mt-2 inline-flex max-w-full items-center gap-1 text-xs"
            disabled={
              !schema?.schemaId ||
              draft.length >= 12 ||
              !fields.some((item) => !draft.some((filter) => filter.propertyId === item.id))
            }
            onClick={() => setAdding(!adding)}
            aria-expanded={adding}
          >
            <Plus aria-hidden="true" className="h-3 w-3 shrink-0" />
            Add property
          </Button>
          {adding ? (
            <select
              aria-label="Add property"
              className={`${inputClass} mt-2`}
              value=""
              ref={(node) => node?.focus()}
              onChange={(event) => {
                const added = fields.find((item) => item.id === event.target.value);
                if (!added || !schema?.schemaId) return;
                setDraft((items) => [
                  ...items,
                  condition(
                    schema.schemaId as string,
                    added,
                    added.type === 'text' ? 'contains' : added.type === 'date' ? 'before' : 'anyOf'
                  ),
                ]);
                pendingFocus.current = 'editor';
                focusProperty(added.id);
              }}
            >
              <option value="">Choose a property</option>
              {fields
                .filter((item) => !draft.some((filter) => filter.propertyId === item.id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          ) : null}
        </div>
        <div className={`min-w-0 p-4 sm:overflow-y-auto ${!current ? 'flex items-center' : ''}`}>
          {!current ? (
            <p className="text-[var(--notes-muted)] text-sm">Add a property to narrow down your notes.</p>
          ) : (
            <>
              <h4 className="mb-3 font-medium text-sm [overflow-wrap:anywhere]">
                {field?.label ?? 'Unavailable property'}
              </h4>
              {!field ? (
                <p role="alert" className="text-sm">
                  Review or remove this unavailable condition.
                </p>
              ) : (
                <div className="space-y-3">
                  {field.type !== 'select' ? (
                    <label className="flex min-w-0 flex-col gap-1 text-xs">
                      {field.type === 'date' ? 'Date match' : 'Text match'}
                      <select
                        ref={operatorRef}
                        aria-label={`Operator for ${field.label}`}
                        className={inputClass}
                        value={current.operator}
                        onChange={(event) => update(condition(current.schemaId, field, event.target.value))}
                      >
                        {(field.type === 'text' ? ['contains', 'empty'] : ['before', 'after', 'between', 'empty']).map(
                          (operator) => (
                            <option key={operator} value={operator}>
                              {
                                {
                                  empty: 'Is empty',
                                  contains: 'Contains',
                                  before: 'Before',
                                  after: 'After',
                                  between: 'Between',
                                }[operator]
                              }
                            </option>
                          )
                        )}
                      </select>
                    </label>
                  ) : null}
                  {current.type === 'select' ? (
                    <>
                      <label className="relative block">
                        <span className="sr-only">Search options for {field.label}</span>
                        <Search
                          aria-hidden="true"
                          className="pointer-events-none absolute top-2.5 left-2 h-4 w-4 text-[var(--notes-muted)]"
                        />
                        <input
                          type="search"
                          placeholder="Search options…"
                          ref={selectSearchRef}
                          className={`${inputClass} pl-8!`}
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </label>
                      <fieldset aria-label={`Values for ${field.label}`} className="space-y-1">
                        {visible.map((option) => (
                          <label
                            key={option.id}
                            className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-sm ${ids.includes(option.id) ? 'bg-[color-mix(in_srgb,var(--notes-blue)_10%,transparent)]' : 'hover:bg-[var(--notes-bg)]'}`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 shrink-0 accent-[var(--notes-blue)]"
                              checked={ids.includes(option.id)}
                              onChange={(event) =>
                                chooseValues(
                                  event.target.checked ? [...ids, option.id] : ids.filter((id) => id !== option.id),
                                  emptySelected
                                )
                              }
                            />
                            <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
                          </label>
                        ))}
                        {!visible.length ? (
                          <p className="text-[var(--notes-muted)] text-sm">No matching options.</p>
                        ) : null}
                        {missing.map((id) => (
                          <label key={id} className="flex items-start gap-2 px-2 py-2 text-sm">
                            <input
                              type="checkbox"
                              checked
                              onChange={() =>
                                chooseValues(
                                  ids.filter((value) => value !== id),
                                  emptySelected
                                )
                              }
                            />
                            <span>Unavailable option</span>
                          </label>
                        ))}
                        <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-sm px-2 py-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label="Not set (empty value)"
                            className="mt-0.5 shrink-0 accent-[var(--notes-blue)]"
                            checked={emptySelected}
                            onChange={(event) => chooseValues(ids, event.target.checked)}
                          />
                          <span>Not set</span>
                        </label>
                      </fieldset>
                      {missing.length ? (
                        <p role="alert" className="text-sm">
                          Remove unavailable options before applying.
                        </p>
                      ) : null}
                      <p className="text-[var(--notes-muted)] text-xs">
                        {ids.length + Number(emptySelected)} selected · {visible.length + 1} of {options.length + 1}{' '}
                        options
                      </p>
                    </>
                  ) : null}
                  {'value' in current ? (
                    <label className="flex min-w-0 flex-col gap-1 text-xs">
                      {current.type === 'date' ? 'Date' : 'Contains'}
                      <input
                        aria-label={`Value for ${field.label}`}
                        type={current.type === 'date' ? 'date' : 'text'}
                        className={inputClass}
                        value={current.value}
                        onChange={(event) => update({ ...current, value: event.target.value })}
                      />
                    </label>
                  ) : null}
                  {current.operator === 'between' ? (
                    <div className="space-y-3">
                      <label className="flex min-w-0 flex-col gap-1 text-xs">
                        Start date
                        <input
                          aria-label={`Start date for ${field.label}`}
                          type="date"
                          className={inputClass}
                          value={current.from}
                          onChange={(event) => update({ ...current, from: event.target.value })}
                        />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1 text-xs">
                        End date
                        <input
                          aria-label={`End date for ${field.label}`}
                          type="date"
                          className={inputClass}
                          value={current.to}
                          onChange={(event) => update({ ...current, to: event.target.value })}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              )}
              <Button
                className="mt-4"
                aria-label={`Clear ${field?.label ?? 'unavailable property'}`}
                onClick={() => {
                  pendingFocus.current = 'add';
                  setDraft((items) => items.filter((item) => item.propertyId !== current.propertyId));
                  focusProperty(ordered.find((item) => item.propertyId !== current.propertyId)?.propertyId ?? '');
                }}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 border-[var(--notes-border)] border-t p-3">
        {error ? (
          <p role="alert" className="mb-2 text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              ref={clearAllRef}
              onClick={() => {
                setDraft([]);
                setSelected(null);
                setSearch('');
              }}
            >
              Clear all
            </Button>
          </div>
          <div className="ml-auto flex gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              onClick={() =>
                onApply(
                  draft.filter(
                    (filter) =>
                      !(
                        filter.type === 'select' &&
                        filter.operator === 'anyOf' &&
                        !filter.optionIds.length &&
                        !filter.includeEmpty
                      )
                  )
                )
              }
            >
              Apply
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
