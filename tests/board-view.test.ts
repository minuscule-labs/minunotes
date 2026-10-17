import { expect, it } from 'vitest';
import { folderQueryHref, folderViewHref, readFolderQuery, validateBoardSearch } from '../src/frontend/lib/board-view';
import { parseNoteQuery } from '../src/shared/note-filters';

it('preserves native literal query URLs independently of the router JSON codec', () => {
  for (const q of ['123', '[1]', 'false', '"quoted"', 'literal %_\\\\ + 漢']) {
    const query = parseNoteQuery({ q });
    const href = folderQueryHref('folder_a', query, 'list');
    expect(readFolderQuery(href.slice(href.indexOf('?'))).query).toEqual(query);
    const board = folderViewHref('folder_a', href.slice(href.indexOf('?')), 'board');
    expect(new URL(board, 'http://local').searchParams.get('view')).toBe('board');
    expect(readFolderQuery(board.slice(board.indexOf('?'))).query).toEqual(query);
    expect(folderViewHref('folder_a', board.slice(board.indexOf('?')), 'list')).toBe(href);
  }
});
it('blocks malformed and repeated query URLs without unfiltered fallback', () => {
  for (const raw of ['?q=a&q=b', '?filters={}', '?filters=%5B%5D', `?q=${'a'.repeat(201)}`]) {
    const state = readFolderQuery(raw);
    expect(state.query).toBeNull();
    expect(state.error).toBeTruthy();
    expect(readFolderQuery(folderViewHref('f', raw, 'board').split('?')[1]).query).toBeNull();
  }
  expect(folderQueryHref('f', parseNoteQuery({}), 'list')).toBe('/folders/f');
});
it('preserves strict personal sort alongside literal filters and view history', () => {
  const query = parseNoteQuery({ q: '[1]' });
  for (const sort of ['title-asc', 'title-desc', 'created-asc', 'created-desc', 'updated-asc'] as const) {
    const href = folderQueryHref('f', query, 'list', sort);
    const parsed = readFolderQuery(href.split('?')[1]);
    expect(parsed).toMatchObject({ query, sort, error: null, sortError: null });
    const switched = folderViewHref('f', href.split('?')[1], 'board');
    expect(readFolderQuery(switched.split('?')[1]).sort).toBe(sort);
    expect(folderQueryHref('f', query, 'list', 'updated-desc')).not.toContain('sort=');
  }
  for (const search of ['?q=%5B1%5D&sort=', '?q=%5B1%5D&sort=wrong', '?q=%5B1%5D&sort=title-asc&sort=title-desc']) {
    const parsed = readFolderQuery(search);
    expect(parsed.query).toEqual(query);
    expect(parsed.sortError).toBeTruthy();
    expect(parsed.error).toBeTruthy();
    expect(folderViewHref('f', search, 'board')).toContain('sort=');
  }
});
it('round-trips versioned property sort without changing literal filters and retains invalid descriptors until explicit reset', () => {
  const query = parseNoteQuery({ q: '[1]' });
  const property = {
    version: 1 as const,
    schemaId: 'schema_a',
    propertyId: 'prop_a',
    type: 'date' as const,
    direction: 'desc' as const,
  };
  const href = folderQueryHref('f', query, 'list', property);
  const parsed = readFolderQuery(href.split('?')[1]);
  expect(parsed.sort).toEqual(property);
  expect(parsed.query).toEqual(query);
  expect(parsed.error).toBeNull();
  const board = folderViewHref('f', href.split('?')[1], 'board');
  expect(readFolderQuery(board.split('?')[1]).sort).toEqual(property);
  for (const bad of [
    { ...property, extra: true },
    { ...property, version: 2 },
    { ...property, type: 'person' },
  ]) {
    const raw = new URLSearchParams({ q: '[1]', sort: JSON.stringify(bad) }).toString();
    expect(readFolderQuery(raw).sortError).toBeTruthy();
    expect(readFolderQuery(raw).query).toEqual(query);
    expect(folderViewHref('f', raw, 'board')).toContain('sort=');
  }
});
it('keeps only valid board view state and explicitly clears retired tag URL state', () => {
  expect(validateBoardSearch({ view: 'board', boardTags: 'hidden' })).toEqual({ view: 'board', boardTags: undefined });
  expect(validateBoardSearch({ view: 'list' })).toEqual({ view: 'list', boardTags: undefined });
  for (const value of ['', 42, ['board'], null])
    expect(validateBoardSearch({ view: value, boardTags: ['x'] })).toEqual({ view: undefined, boardTags: undefined });
});
