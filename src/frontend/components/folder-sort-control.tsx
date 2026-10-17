import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  Clock,
  ListFilter,
  type LucideIcon,
  Search,
  Type,
  X,
} from 'lucide-react';
import { type Ref, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_NOTE_SORT,
  isPropertySort,
  NOTE_SORT_OPTIONS,
  type NoteSort,
  noteSortIdentity,
  noteSortSchemaError,
  sameNoteSort,
} from '../../shared/note-sort';
import type { PropertySchema } from '../../shared/properties';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const fields = [
  { id: 'title', label: 'Title', icon: Type },
  { id: 'updated', label: 'Updated', icon: Clock },
  { id: 'created', label: 'Created', icon: CalendarDays },
] as const;
type Direction = 'asc' | 'desc';
type Choice = {
  key: string;
  label: string;
  icon: LucideIcon;
  propertyType?: string;
  defaultDirection: Direction;
  sortFor: (direction: Direction) => NoteSort;
};
const inputClass =
  'min-w-0 rounded-md border border-[var(--notes-border)] bg-[var(--notes-panel)] px-2 py-1.5 text-sm text-[var(--notes-text)]';

export function FolderSortControl({
  sort,
  onChange,
  triggerRef,
  schema,
  schemaLoading,
  schemaError,
  onRefresh,
}: {
  sort: NoteSort;
  onChange: (sort: NoteSort) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  schema?: PropertySchema;
  schemaLoading: boolean;
  schemaError?: string;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(true);
  const [search, setSearch] = useState('');
  const identity = noteSortIdentity(sort);
  const ownChange = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ownChange.current !== identity) setOpen(false);
    ownChange.current = null;
  }, [identity]);
  useEffect(() => {
    if (!open) return;
    if (picking) searchRef.current?.focus();
    else fieldRef.current?.focus();
  }, [open, picking]);
  const property = isPropertySort(sort) ? sort : null;
  const direction: Direction = property
    ? property.direction
    : typeof sort === 'string' && sort.endsWith('asc')
      ? 'asc'
      : 'desc';
  const selectedKey = property
    ? `property:${property.schemaId}:${property.propertyId}:${property.type}`
    : `builtin:${typeof sort === 'string' ? sort.split('-')[0] : 'updated'}`;
  const choices: Choice[] = fields.map((item) => ({
    key: `builtin:${item.id}`,
    label: item.label,
    icon: item.icon,
    defaultDirection: item.id === 'title' ? 'asc' : 'desc',
    sortFor: (next) => `${item.id}-${next}`,
  }));
  if (schema?.schemaId) {
    const schemaId = schema.schemaId;
    for (const field of schema.definitions.filter(
      (item) => !item.archived && ['text', 'select', 'date'].includes(item.type)
    )) {
      choices.push({
        key: `property:${schemaId}:${field.id}:${field.type}`,
        label: field.label,
        icon: field.type === 'date' ? CalendarDays : field.type === 'select' ? ListFilter : Type,
        propertyType: field.type,
        defaultDirection: 'asc',
        sortFor: (next) => ({ version: 1, schemaId, propertyId: field.id, type: field.type, direction: next }),
      });
    }
  }
  const field = choices.find((item) => item.key === selectedKey) ?? {
    key: selectedKey,
    label: 'Unavailable property',
    icon: Type,
    propertyType: property?.type,
    defaultDirection: 'asc' as const,
    sortFor: (next: Direction): NoteSort => (property ? { ...property, direction: next } : DEFAULT_NOTE_SORT),
  };
  const label = property
    ? `${field.label} · ${direction === 'asc' ? 'Ascending' : 'Descending'}`
    : NOTE_SORT_OPTIONS.find((option) => option.value === sort)?.label;
  const issue = noteSortSchemaError(sort, schema);
  const active = sort !== DEFAULT_NOTE_SORT;
  const DirectionIcon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowDownUp;
  const FieldIcon = field.icon;
  const change = (next: NoteSort) => {
    if (sameNoteSort(next, sort)) return;
    ownChange.current = noteSortIdentity(next);
    onChange(next);
  };
  const chooseField = (item: Choice) => {
    change(item.sortFor(item.key === selectedKey ? direction : item.defaultDirection));
    setPicking(false);
    setSearch('');
  };
  const visible = choices.filter((item) => item.label.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setPicking(!active);
          setSearch('');
          onRefresh();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          aria-label={`Sort · ${label}`}
          className={`inline-flex h-8 max-w-full items-center gap-1.5 px-2.5! py-0! ${active ? 'border-[var(--notes-blue)]! bg-[color-mix(in_srgb,var(--notes-blue)_10%,transparent)]! text-[var(--notes-blue)]!' : ''}`}
        >
          <DirectionIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{active ? field.label : 'Sort'}</span>
          {active ? <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        aria-label="Sort notes"
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto p-2!"
      >
        {active || !picking ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              ref={fieldRef}
              aria-label="Choose sort field"
              aria-expanded={picking}
              className="inline-flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2! py-0!"
              onClick={() => {
                setPicking(!picking);
                setSearch('');
              }}
            >
              <FieldIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span title={field.label} className="min-w-0 flex-1 truncate text-left">
                {field.label}
              </span>
              <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" />
            </Button>
            <div className="relative h-8 shrink-0">
              <select
                aria-label="Sort direction"
                disabled={!!issue}
                className={`${inputClass} peer block h-8 appearance-none py-0! pr-7! forced-colors:appearance-auto`}
                value={direction}
                onChange={(event) => change(field.sortFor(event.target.value === 'asc' ? 'asc' : 'desc'))}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-[calc(0.5rem_+_1px)] h-3 w-3 -translate-y-1/2 peer-disabled:opacity-50 forced-colors:hidden"
              />
            </div>
            <Button
              aria-label="Remove sort"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center p-0!"
              onClick={() => {
                change(DEFAULT_NOTE_SORT);
                setOpen(false);
              }}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {schemaLoading ? (
          <p role="status" className="px-2 py-2 text-[var(--notes-muted)] text-xs">
            Loading properties…
          </p>
        ) : null}
        {schemaError ? (
          <div className="px-2 py-2 text-sm">
            <p role="alert">{schemaError}</p>
            <Button onClick={onRefresh}>Retry definitions</Button>
          </div>
        ) : null}
        {issue && !schemaLoading ? (
          <p role="alert" className="px-2 py-2 text-sm">
            {issue}
          </p>
        ) : null}
        {picking ? (
          <div className={active ? 'mt-2 space-y-1' : 'space-y-1'}>
            <label className="relative mb-2 block">
              <span className="sr-only">Search sort fields</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2 left-2 h-4 w-4 text-[var(--notes-muted)]"
              />
              <input
                ref={searchRef}
                type="search"
                placeholder="Sort…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className={`${inputClass} h-8 w-full pl-8!`}
              />
            </label>
            <fieldset aria-label="Sort fields" className="space-y-1">
              {visible.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-label={item.propertyType ? `${item.label} · ${item.propertyType} property` : item.label}
                    onClick={() => chooseField(item)}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-[var(--notes-bg)] focus-visible:outline-2 focus-visible:outline-[var(--notes-blue)] ${active && selectedKey === item.key ? 'text-[var(--notes-blue)]' : ''}`}
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.label}</span>
                    {item.propertyType ? (
                      <span className="shrink-0 text-[var(--notes-muted)] text-xs">{item.propertyType}</span>
                    ) : null}
                  </button>
                );
              })}
              {!visible.length ? (
                <p className="px-2 py-2 text-[var(--notes-muted)] text-sm">No matching fields.</p>
              ) : null}
            </fieldset>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
