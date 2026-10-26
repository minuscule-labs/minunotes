import type { Page } from '@playwright/test';
import {
  type BoardConfig,
  type BoardDisplayProperty,
  type ColumnVisibility,
  DEFAULT_BOARD_CONFIG,
  type EffectiveBoard,
  previewBoardProperty,
  UNCLASSIFIED,
  validateBoardConfig,
} from '../../src/shared/board';
import {
  hasNoteQuery,
  NOTE_FILTER_WHITESPACE,
  type NoteQuery,
  noteQueryIdentity,
  parseNoteQuery,
} from '../../src/shared/note-filters';
import {
  DEFAULT_NOTE_SORT,
  isPropertySort,
  noteSortIdentity,
  noteSortSchemaError,
  parseNoteSort,
  sortProperty,
} from '../../src/shared/note-sort';
import { isCalendarDate, type PropertySchema } from '../../src/shared/properties';
import { mockBoardApi } from './board-fixtures';
import { browserFixture } from './fixtures';

export async function mockPropertyBoard(
  page: Page,
  options: {
    role?: 'owner' | 'viewer' | 'commenter' | 'editor';
    extraCards?: number;
    legacy?: 'tags' | 'filtered' | 'unfiltered';
    disabled?: boolean;
    absent?: boolean;
  } = {}
) {
  const base = await mockBoardApi(page, { role: options.role });
  const role = options.role ?? 'owner';
  const schema: PropertySchema = {
    schemaId: 'schema_board',
    revision: 1,
    definitions: [
      { id: 'text_field', label: 'Summary', type: 'text', archived: false, options: [] },
      {
        id: 'workflow_field',
        label: 'Workflow',
        type: 'select',
        archived: false,
        options: [
          { id: 'Option_Todo', label: 'Ready', archived: false },
          { id: 'Option_Done', label: 'Finished', archived: false },
          { id: 'Option_Empty', label: 'Empty', archived: false },
        ],
      },
      { id: 'date_field', label: 'Due date', type: 'date', archived: false, options: [] },
      {
        id: 'type_field',
        label: 'Type',
        type: 'select',
        archived: false,
        options: [
          { id: 'Type_Bug', label: 'Bug', archived: false },
          { id: 'Type_Feature', label: 'Feature', archived: false },
          { id: 'Type_Task', label: 'Task', archived: false },
        ],
      },
    ],
  };
  const field = schema.definitions[1];
  let config: BoardConfig = {
    ...structuredClone(DEFAULT_BOARD_CONFIG),
    enabled: !options.disabled,
    grouping: { type: 'select', schemaId: 'schema_board', propertyId: options.legacy === 'tags' ? '' : field.id },
    cardPropertyIds: ['type_field'],
  };
  let retired = !!options.legacy && options.legacy !== 'unfiltered';
  let version = options.absent ? 0 : 1;
  const typeField = schema.definitions[3];
  const controls: {
    readFailure: number;
    laneFailure: number;
    saveFailure: number;
    schemaFailure: number;
    unavailable: boolean;
    shareRevoked: boolean;
    queryEcho?: string | null;
    sortEcho?: string | null;
    schemaEcho?: { schemaId: string; schemaRevision: number } | null;
    listFailure?: number;
  } = { readFailure: 0, laneFailure: 0, saveFailure: 0, schemaFailure: 0, unavailable: false, shareRevoked: false };
  const access = { role, source: role === 'owner' ? 'owner' : 'folder_grant' };
  const groupingField = () =>
    schema.schemaId === config.grouping.schemaId
      ? schema.definitions.find((d) => d.id === config.grouping.propertyId && !d.archived && d.type === 'select')
      : undefined;
  const snapshot = (): EffectiveBoard => {
    const grouping = groupingField();
    const unavailable = retired || controls.unavailable || !config.enabled || !grouping;
    return {
      config,
      version,
      ...(retired ? { reconfigurationRequired: true as const } : {}),
      cardProperties: schema.definitions
        .filter((d) => config.cardPropertyIds.includes(d.id) && !d.archived)
        .map(
          (d) =>
            ({
              propertyId: d.id,
              label: d.label,
              type: d.type,
              ...(d.type === 'select'
                ? { options: d.options.filter((o) => !o.archived).map(({ id, label }) => ({ id, label })) }
                : {}),
            }) as BoardDisplayProperty
        ),
      columns: unavailable
        ? []
        : [
            ...grouping.options
              .filter(
                (o) =>
                  !o.archived &&
                  (config.columnVisibility.mode === 'all' || config.columnVisibility.optionIds.includes(o.id))
              )
              .map((o) => ({ key: o.id, label: o.label })),
            ...(config.columnVisibility.showUnclassified ? [{ key: UNCLASSIFIED, label: 'Unclassified' }] : []),
          ],
      groupingState: unavailable
        ? {
            type: 'select',
            available: false,
            reason: retired
              ? 'This board uses retired tag settings. The owner must review and save property-only board settings.'
              : 'Grouping unavailable; disable or switch the board.',
          }
        : {
            type: 'select',
            available: true,
            schemaId: config.grouping.schemaId,
            schemaRevision: schema.revision,
            propertyId: grouping.id,
            label: grouping.label,
          },
    };
  };
  const cards: Array<{
    id: string;
    title: string;
    value: string;
    typeValue: string;
    tags: string[];
    displayValues?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }> = [
    {
      id: browserFixture.source.id,
      title: browserFixture.source.title,
      value: 'Option_Todo',
      typeValue: 'Type_Bug',
      tags: ['status-done', 'feature'],
    },
    { id: browserFixture.canvas.id, title: browserFixture.canvas.title, value: '', typeValue: '', tags: [] },
    {
      id: browserFixture.target.id,
      title: browserFixture.target.title,
      value: 'option_archived',
      typeValue: 'unknown',
      tags: [],
    },
    ...Array.from({ length: options.extraCards ?? 0 }, (_, i) => ({
      id: `extra_${i}`,
      title: `Extra ${String(i).padStart(3, '0')}`,
      value: 'Option_Todo',
      typeValue: 'Type_Bug',
      tags: ['status-done', 'feature'],
    })),
  ];
  const writes: Array<{ config: BoardConfig; expectedVersion: number; schemaId?: string; schemaRevision?: number }> =
    [];
  const laneRequests: URL[] = [];
  const listRequests: URL[] = [];
  const timestamp = (card: (typeof cards)[number], key: 'createdAt' | 'updatedAt') =>
    card[key] ??
    (key === 'createdAt'
      ? browserFixture.source.createdAt
      : new Date(Date.parse(browserFixture.source.updatedAt) - cards.indexOf(card) * 1000).toISOString());
  const sorted = <T extends { id: string; title: string }>(items: T[], url: URL) => {
    const sort = parseNoteSort(url.searchParams);
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...items].sort((a, b) => {
      const sourceA = cards.find((card) => card.id === a.id);
      const sourceB = cards.find((card) => card.id === b.id);
      if (!sourceA || !sourceB) throw new Error('Missing source card');
      if (isPropertySort(sort)) {
        const definition = sortProperty(sort, schema);
        if (!definition) throw new Error('Sort property unavailable');
        const keyFor = (card: (typeof cards)[number]): string | number | null => {
          const value = rawValue(card, sort.propertyId);
          if (
            typeof value !== 'string' ||
            value.includes('\0') ||
            [...value].every((character) => NOTE_FILTER_WHITESPACE.includes(character))
          )
            return null;
          if (sort.type === 'date') return isCalendarDate(value) ? value : null;
          if (sort.type === 'select') {
            const index = definition.options
              .filter((option) => !option.archived)
              .findIndex((option) => option.id === value);
            return index < 0 ? null : index;
          }
          return value;
        };
        const aKey = keyFor(sourceA),
          bKey = keyFor(sourceB);
        if ((aKey === null) !== (bKey === null)) return aKey === null ? 1 : -1;
        const primary = aKey === null || bKey === null ? 0 : aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
        return primary * (sort.direction === 'asc' ? 1 : -1) || compare(a.title, b.title) || compare(a.id, b.id);
      }
      const key = sort.startsWith('created') ? 'createdAt' : 'updatedAt';
      const primary = sort.startsWith('title')
        ? compare(a.title, b.title)
        : compare(timestamp(sourceA, key), timestamp(sourceB, key));
      return (
        primary * (sort.endsWith('desc') ? -1 : 1) ||
        (sort.startsWith('title') ? 0 : compare(a.title, b.title)) ||
        compare(a.id, b.id)
      );
    });
  };
  const sortEcho = (url: URL) => {
    const sort = parseNoteSort(url.searchParams);
    return sort !== DEFAULT_NOTE_SORT && controls.sortEcho !== null
      ? { sortIdentity: controls.sortEcho ?? noteSortIdentity(sort) }
      : {};
  };
  const queryFor = (url: URL) => {
    const sort = parseNoteSort(url.searchParams);
    if (
      isPropertySort(sort) &&
      (noteSortSchemaError(sort, schema) ||
        url.searchParams.get('schemaId') !== schema.schemaId ||
        Number(url.searchParams.get('schemaRevision')) !== schema.revision)
    )
      throw new Error('Sort definitions changed');
    if (url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('filters').length > 1)
      throw new Error('Repeated query parameter');
    const query = parseNoteQuery({
      q: url.searchParams.get('q') ?? undefined,
      filters: url.searchParams.get('filters') ?? undefined,
    });
    for (const filter of query.filters.all) {
      const definition = schema.definitions.find(
        (d) => d.id === filter.propertyId && d.type === filter.type && !d.archived
      );
      if (
        !definition ||
        filter.schemaId !== schema.schemaId ||
        url.searchParams.get('schemaId') !== schema.schemaId ||
        Number(url.searchParams.get('schemaRevision')) !== schema.revision
      )
        throw new Error('Filter definitions changed');
      const ids = filter.operator === 'is' ? [filter.optionId] : filter.operator === 'anyOf' ? filter.optionIds : [];
      if (ids.some((id) => !definition.options.some((option) => option.id === id && !option.archived)))
        throw new Error('Filtered option unavailable');
    }
    return query;
  };
  const rawValue = (card: (typeof cards)[number], id: string): unknown =>
    id === typeField.id ? card.typeValue : id === field.id ? card.value : card.displayValues?.[id];
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const matches = (card: (typeof cards)[number], query: NoteQuery) => {
    if (query.q && !fold(card.title).includes(fold(query.q))) return false;
    return query.filters.all.every((filter) => {
      const value = rawValue(card, filter.propertyId);
      const empty =
        value == null ||
        (typeof value === 'string' &&
          !value.includes('\0') &&
          [...value].every((character) => NOTE_FILTER_WHITESPACE.includes(character)));
      if (filter.operator === 'empty') return empty;
      if (filter.operator === 'anyOf' && filter.includeEmpty && empty) return true;
      if (typeof value !== 'string' || value.includes('\0')) return false;
      if (filter.operator === 'contains') return fold(value).includes(fold(filter.value));
      if (filter.operator === 'is') return value === filter.optionId;
      if (filter.operator === 'anyOf') return filter.optionIds.includes(value);
      if (!isCalendarDate(value)) return false;
      if (filter.operator === 'before') return value < filter.value;
      if (filter.operator === 'after') return value > filter.value;
      return value >= filter.from && value <= filter.to;
    });
  };
  const echo = (query: NoteQuery, url: URL) =>
    hasNoteQuery(query) || isPropertySort(parseNoteSort(url.searchParams))
      ? {
          ...(controls.queryEcho !== null ? { queryIdentity: controls.queryEcho ?? noteQueryIdentity(query) } : {}),
          ...((query.filters.all.length || isPropertySort(parseNoteSort(url.searchParams))) &&
          controls.schemaEcho !== null
            ? { querySchema: controls.schemaEcho ?? { schemaId: schema.schemaId, schemaRevision: schema.revision } }
            : {}),
        }
      : {};
  await page.route(`**/internal/folders/${browserFixture.folder.id}/notes?**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('type') !== 'note') return route.fallback();
    listRequests.push(url);
    if (controls.listFailure)
      return route.fulfill({ status: controls.listFailure, json: { error: 'List read failed' } });
    let query: NoteQuery;
    try {
      query = queryFor(url);
    } catch (error) {
      return route.fulfill({ status: 409, json: { error: (error as Error).message } });
    }
    const visible = sorted(
      cards.filter((card) => matches(card, query)),
      url
    );
    const number = Number(url.searchParams.get('page'));
    const limit = Number(url.searchParams.get('limit'));
    return route.fulfill({
      json: {
        notes: visible.slice((number - 1) * limit, number * limit).map((card) => ({
          id: card.id,
          folderId: browserFixture.folder.id,
          title: card.title,
          type: 'note',
          documentType: card.id === browserFixture.canvas.id ? 'canvas.mindmap' : 'markdown',
          createdAt: timestamp(card, 'createdAt'),
          updatedAt: timestamp(card, 'updatedAt'),
          canTrash: role === 'owner' || role === 'editor',
        })),
        access,
        page: number,
        limit,
        hasMore: visible.length > number * limit,
        ...echo(query, url),
        ...sortEcho(url),
      },
    });
  });
  await page.route('**/internal/folders/*/properties', (route) =>
    controls.schemaFailure
      ? route.fulfill({ status: controls.schemaFailure, json: { error: 'Schema read failed' } })
      : route.fulfill({ json: schema })
  );
  await page.route(/\/internal\/share\/folders\/folder_share_token(?:\/navigation|\/notes\/[^/]+)?$/, (route) =>
    controls.shareRevoked
      ? route.fulfill({ status: 404, json: { error: 'Shared folder not found' } })
      : route.fallback()
  );
  const boardRoute = /\/internal\/(?:share\/folders\/[^/]+\/)?folders\/[^/]+\/board(?:\/config)?(?:\?.*)?$/;
  await page.route(boardRoute, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    const publicRead = url.pathname.startsWith('/internal/share/');
    if (publicRead && controls.shareRevoked) return reply({ error: 'Shared folder not found' }, 404);
    if (publicRead && request.method() !== 'GET') return reply({ error: 'Not found' }, 404);
    if (url.pathname.endsWith('/config')) {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON();
        writes.push(input);
        if (role !== 'owner') return reply({ error: 'Only the owner can configure the board' }, 403);
        if (controls.saveFailure) return reply({ error: 'Save failed' }, controls.saveFailure);
        if (
          input.expectedVersion !== version ||
          (input.config.enabled && (input.schemaId !== schema.schemaId || input.schemaRevision !== schema.revision))
        )
          return reply({ error: 'Snapshot changed; review before saving' }, 409);
        let next: BoardConfig;
        try {
          next = validateBoardConfig(input.config);
          if (next.enabled) {
            const grouping = schema.definitions.find(
              (d) => d.id === next.grouping.propertyId && !d.archived && d.type === 'select'
            );
            if (next.grouping.schemaId !== schema.schemaId || !grouping)
              throw new Error('Choose an active Select property');
            if (
              next.columnVisibility.mode === 'selected' &&
              next.columnVisibility.optionIds.some((id) => !grouping.options.some((o) => o.id === id && !o.archived))
            )
              throw new Error('Remove unavailable Visible columns');
            if (next.cardPropertyIds.some((id) => !schema.definitions.some((d) => d.id === id && !d.archived)))
              throw new Error('Remove unavailable Card properties');
          }
        } catch (error) {
          return reply({ error: (error as Error).message }, 400);
        }
        config = next;
        retired = false;
        version++;
        return reply({ board: snapshot() });
      }
      if (controls.readFailure) return reply({ error: 'Configuration read failed' }, controls.readFailure);
      return reply({ board: version ? snapshot() : null, ...(!publicRead ? { access } : {}) });
    }
    laneRequests.push(url);
    if (!config.enabled) return reply({ error: 'Board is not enabled' }, 404);
    const grouping = groupingField();
    if (retired || controls.unavailable || !grouping) return reply({ error: 'Grouping unavailable' }, 409);
    if (url.searchParams.has('tag')) return reply({ error: 'Board tag filters are no longer supported' }, 400);
    if (controls.laneFailure) return reply({ error: 'Lane read failed' }, controls.laneFailure);
    if (
      Number(url.searchParams.get('version')) !== version ||
      url.searchParams.get('schemaId') !== schema.schemaId ||
      Number(url.searchParams.get('schemaRevision')) !== schema.revision
    )
      return reply({ error: 'Grouping snapshot changed' }, 409);
    let query: NoteQuery;
    try {
      query = queryFor(url);
    } catch (error) {
      return reply({ error: (error as Error).message }, 409);
    }
    const lane = url.searchParams.get('lane');
    if (!snapshot().columns.some((column) => column.key === lane)) return reply({ error: 'Unknown lane' }, 400);
    const visible = cards
      .filter((card) => matches(card, query))
      .map((card) => {
        const value = rawValue(card, grouping.id);
        const active = grouping.options.find((o) => o.id === value && !o.archived);
        const properties = (snapshot().cardProperties ?? []).flatMap((definition) => {
          const raw =
            definition.propertyId === typeField.id
              ? card.typeValue
              : definition.propertyId === field.id
                ? card.value
                : card.displayValues?.[definition.propertyId];
          const property = previewBoardProperty(definition, raw);
          return property ? [property] : [];
        });
        return {
          ...card,
          properties,
          folderId: browserFixture.folder.id,
          documentType: card.id === browserFixture.canvas.id ? 'canvas.mindmap' : 'markdown',
          createdAt: timestamp(card, 'createdAt'),
          updatedAt: timestamp(card, 'updatedAt'),
          lane: active?.id ?? UNCLASSIFIED,
          unclassifiedReason: active ? null : value ? 'unavailable-property-value' : 'no-property-value',
        };
      })
      .filter((c) => c.lane === lane)
      .map(({ value: _value, typeValue: _typeValue, tags: _tags, displayValues: _displayValues, ...card }) => card);
    const pageNumber = Number(url.searchParams.get('page'));
    const limit = Number(url.searchParams.get('limit'));
    return reply({
      cards: sorted(visible, url).slice((pageNumber - 1) * limit, pageNumber * limit),
      lane,
      configVersion: version,
      schemaId: schema.schemaId,
      schemaRevision: schema.revision,
      page: pageNumber,
      limit,
      hasMore: visible.length > pageNumber * limit,
      ...echo(query, url),
      ...sortEcho(url),
      ...(!publicRead ? { access } : {}),
    });
  });
  return {
    ...base,
    controls,
    schema,
    field,
    typeField,
    cards,
    writes,
    laneRequests,
    listRequests,
    snapshot,
    setColumnVisibility(columnVisibility: ColumnVisibility) {
      config = validateBoardConfig({ ...config, columnVisibility });
    },
    setCardProperties(ids: string[]) {
      config = validateBoardConfig({ ...config, cardPropertyIds: ids });
    },
    changeSchema() {
      schema.revision++;
    },
    changeConfig() {
      version++;
    },
  };
}
