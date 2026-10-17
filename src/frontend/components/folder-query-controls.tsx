import { ListFilter, Search, X } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { type NoteFilter, type NoteQuery, parseNoteQuery } from '../../shared/note-filters';
import { folderReadIdentity, type NoteSort } from '../../shared/note-sort';
import type { PropertySchema } from '../../shared/properties';
import { FolderPropertyFilterPanel } from './folder-property-filter-panel';
import { FolderSortControl } from './folder-sort-control';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function folderQuerySchemaError(query: NoteQuery, schema?: PropertySchema): string | null {
  if (!query.filters.all.length) return null;
  if (!schema) return 'Load current definitions to review the filters.';
  for (const filter of query.filters.all) {
    const field = schema.definitions.find(
      (item) => item.id === filter.propertyId && !item.archived && item.type === filter.type
    );
    if (filter.schemaId !== schema.schemaId || !field)
      return 'A filtered property is unavailable or changed. Review or remove the condition.';
    const options =
      filter.type === 'select' && filter.operator === 'is'
        ? [filter.optionId]
        : filter.type === 'select' && filter.operator === 'anyOf'
          ? filter.optionIds
          : [];
    if (options.some((id) => !field.options.some((option) => option.id === id && !option.archived)))
      return 'A filtered option is unavailable. Review or remove the condition.';
  }
  return null;
}
const inputClass =
  'min-w-0 rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel)] px-2 py-1.5 text-sm text-[var(--notes-text)]';
const operatorLabel = (operator: string) => ({ empty: 'is empty', anyOf: 'is any of' })[operator] ?? operator;
export function FolderQueryControls({
  query,
  sort,
  onSortChange,
  sortTriggerRef,
  schema,
  schemaLoading,
  schemaError,
  onRefresh,
  onChange,
  actions,
  actionTargetRef,
}: {
  query: NoteQuery;
  sort: NoteSort;
  onSortChange: (sort: NoteSort, query: NoteQuery) => void;
  sortTriggerRef?: Ref<HTMLButtonElement>;
  schema?: PropertySchema;
  schemaLoading: boolean;
  schemaError?: string;
  onRefresh: () => void;
  onChange: (query: NoteQuery, replace: boolean) => void;
  actions?: ReactNode;
  actionTargetRef?: Ref<HTMLDivElement>;
}) {
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const [title, setTitle] = useState(query.q);
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = folderReadIdentity(query, sort);
  const ownTitleCommit = useRef<string | null>(null);
  const current = useRef({ query, onChange, sort });
  current.current = { query, onChange, sort };
  const commitTitle = (value: string) => {
    try {
      const applied = parseNoteQuery({ q: value, filters: JSON.stringify(current.current.query.filters) });
      setTitle(applied.q);
      setError(null);
      ownTitleCommit.current = folderReadIdentity(applied, current.current.sort);
      current.current.onChange(applied, true);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  useEffect(() => {
    setTitle(query.q);
    if (ownTitleCommit.current !== identity) {
      setOpen(false);
      setError(null);
    }
    ownTitleCommit.current = null;
  }, [identity, query.q]);
  useEffect(() => {
    if (composing || title === current.current.query.q) return;
    const timer = setTimeout(() => commitTitle(title), 300);
    return () => clearTimeout(timer);
  }, [title, composing, identity]);
  const fields = schema?.definitions.filter((field) => !field.archived) ?? [];
  const ordered = (filters: NoteFilter[]) =>
    [...filters].sort(
      (a, b) =>
        (schema?.definitions.findIndex((f) => f.id === a.propertyId) ?? -1) -
        (schema?.definitions.findIndex((f) => f.id === b.propertyId) ?? -1)
    );
  const summary = (filter: NoteFilter) => {
    const field = fields.find(
      (item) => item.id === filter.propertyId && item.type === filter.type && schema?.schemaId === filter.schemaId
    );
    const label = field?.label ?? 'Unavailable property';
    const values = filter.operator === 'is' ? [filter.optionId] : filter.operator === 'anyOf' ? filter.optionIds : [];
    const value = values.length
      ? values
          .map(
            (id) => field?.options.find((option) => option.id === id && !option.archived)?.label ?? 'Unavailable option'
          )
          .join(', ')
      : 'value' in filter
        ? filter.value
        : 'from' in filter
          ? `${filter.from} – ${filter.to}`
          : '';
    return `${label} ${operatorLabel(filter.operator)}${value ? ` ${value}` : ''}`;
  };
  return (
    <section className="mb-4 min-w-0 shrink-0 space-y-2" aria-label="Folder query">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative w-56 max-w-full shrink-0">
          <label htmlFor={searchId} className="sr-only">
            Search titles in this folder
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--notes-muted)]"
          />
          <input
            id={searchId}
            ref={searchRef}
            aria-label="Search titles in this folder"
            placeholder="Search titles…"
            className={`${inputClass} h-8 w-full py-0! pr-8! pl-7!`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composing && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commitTitle(title);
              }
            }}
          />
          {title ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                commitTitle('');
                searchRef.current?.focus();
              }}
              className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-[var(--notes-muted)] hover:text-[var(--notes-text)] focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)]"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            setError(null);
            if (next) {
              onRefresh();
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={filterRef}
              className={`inline-flex h-8 items-center gap-1.5 px-2.5! py-0! ${query.filters.all.length ? 'border-[var(--notes-blue)]! bg-[color-mix(in_srgb,var(--notes-blue)_10%,transparent)]! text-[var(--notes-blue)]!' : ''}`}
              aria-label={`Filter${query.filters.all.length ? ` · ${query.filters.all.length}` : ''}`}
            >
              <ListFilter aria-hidden="true" className="h-3.5 w-3.5" />
              Filter
              {query.filters.all.length ? (
                <span
                  aria-hidden="true"
                  className="rounded-sm bg-[color-mix(in_srgb,var(--notes-blue)_18%,transparent)] px-1.5 py-0.5 font-medium text-[10px] leading-none"
                >
                  {query.filters.all.length}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={16}
            aria-label="Filter notes"
            className="flex max-h-[min(85dvh,36rem,var(--radix-popover-content-available-height))] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden p-0!"
          >
            <FolderPropertyFilterPanel
              filters={query.filters.all}
              schema={schema}
              schemaLoading={schemaLoading}
              schemaError={schemaError}
              error={error}
              onCancel={() => setOpen(false)}
              onApply={(draft) => {
                try {
                  const applied = parseNoteQuery({ q: query.q, filters: JSON.stringify({ version: 1, all: draft }) });
                  const issue = folderQuerySchemaError(applied, schema);
                  if (issue) throw new Error(issue);
                  onChange(applied, false);
                  setOpen(false);
                } catch (cause) {
                  setError((cause as Error).message);
                }
              }}
            />
          </PopoverContent>
        </Popover>
        {query.filters.all.length ? (
          <Button
            className="h-8 px-2.5! py-0!"
            onClick={() => {
              onChange({ ...query, filters: { version: 1, all: [] } }, false);
              filterRef.current?.focus();
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <FolderSortControl
          triggerRef={sortTriggerRef}
          sort={sort}
          schema={schema}
          schemaLoading={schemaLoading}
          schemaError={schemaError}
          onRefresh={onRefresh}
          onChange={(next) => {
            try {
              const nextQuery = parseNoteQuery({ q: title, filters: JSON.stringify(query.filters) });
              onSortChange(next, nextQuery);
            } catch (cause) {
              setError((cause as Error).message);
            }
          }}
        />
        <div ref={actionTargetRef} className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
        </div>
      </div>
      {!open && error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      {query.filters.all.length ? (
        <ul aria-label="Applied filters" className="flex min-w-0 flex-wrap gap-2">
          {ordered(query.filters.all).map((filter) => (
            <li
              key={filter.propertyId}
              className="flex min-w-0 max-w-full items-start gap-1 rounded border border-[var(--notes-border)] px-2 py-1 text-xs"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{summary(filter)}</span>
              <button
                type="button"
                className="shrink-0 underline"
                aria-label={`Remove ${summary(filter)}`}
                onClick={() =>
                  onChange(
                    {
                      ...query,
                      filters: {
                        version: 1,
                        all: query.filters.all.filter((item) => item.propertyId !== filter.propertyId),
                      },
                    },
                    false
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
