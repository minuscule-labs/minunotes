import { Link } from '@tanstack/react-router';
import { Folder as FolderIcon } from 'lucide-react';
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Folder } from '../lib/api';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const PAGE_SIZE = 50;

// Navigation only: children are the current folder-detail response, never a global folder cache.
export function BoardSubfolderPicker({
  folders,
  fallbackFocus,
}: {
  folders: Folder[];
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const outsideTriggerRef = useRef<Element | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const sorted = useMemo(
    () =>
      [...folders].sort(
        (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id.localeCompare(b.id)
      ),
    [folders]
  );
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return sorted.filter((folder) => folder.title.toLowerCase().includes(term));
  }, [sorted, query]);
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE;
  const visible = matches.slice(start, start + PAGE_SIZE);
  useEffect(() => setPage((value) => Math.min(value, lastPage)), [lastPage]);
  useEffect(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [query, currentPage, folders]);
  useEffect(() => {
    if (!folders.length && open) {
      setOpen(false);
      setQuery('');
      setPage(0);
      fallbackFocus.current?.focus();
    }
  }, [folders.length, open, fallbackFocus]);
  const changeOpen = (next: boolean) => {
    if (next) outsideTriggerRef.current = null;
    setOpen(next);
    setQuery('');
    setPage(0);
  };
  if (!folders.length) return null;
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          className="inline-flex items-center gap-2 focus-visible:outline focus-visible:outline-2"
        >
          <FolderIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          Subfolders · {folders.length.toLocaleString()}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        aria-label="Subfolders"
        className="flex max-h-[min(34rem,calc(100dvh-2rem),var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          outsideTriggerRef.current = target instanceof Element ? target.closest('[aria-haspopup="dialog"]') : null;
        }}
        onCloseAutoFocus={(event) => {
          // An existing header popover just opened: do not steal its initial focus and dismiss it.
          if (
            outsideTriggerRef.current?.isConnected &&
            outsideTriggerRef.current.getAttribute('aria-expanded') === 'true'
          ) {
            event.preventDefault();
            return;
          }
          const target = triggerRef.current?.isConnected ? triggerRef.current : fallbackFocus.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <label htmlFor={searchId} className="mb-1 shrink-0 font-medium text-sm">
          Search subfolders
        </label>
        <input
          id={searchId}
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          className="notes-input mb-2 w-full shrink-0 rounded-md px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2"
        />
        <nav
          ref={resultsRef}
          aria-label="Subfolder results"
          className="max-h-80 min-h-0 overflow-y-auto overscroll-contain"
        >
          {matches.length ? (
            <ul className="space-y-0.5">
              {visible.map((folder) => (
                <li key={folder.id}>
                  <Link
                    to="/folders/$folderId"
                    params={{ folderId: folder.id }}
                    search={{}}
                    title={folder.title}
                    onClick={(event) => {
                      if (
                        !event.defaultPrevented &&
                        event.button === 0 &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.altKey &&
                        !event.shiftKey
                      )
                        changeOpen(false);
                    }}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-[var(--notes-hover)] focus-visible:bg-[var(--notes-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                  >
                    <FolderIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--notes-muted)]" />
                    <span className="min-w-0 truncate">{folder.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notes-muted py-3 text-sm">No matching subfolders.</p>
          )}
        </nav>
        <div className="mt-2 shrink-0 space-y-2">
          <p role="status" className="notes-muted text-xs">
            {matches.length
              ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, matches.length).toLocaleString()} of ${matches.length.toLocaleString()}`
              : '0 matches'}
          </p>
          {matches.length > PAGE_SIZE ? (
            <div className="flex items-center justify-between gap-2">
              <Button
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="focus-visible:outline focus-visible:outline-2"
              >
                Previous
              </Button>
              <Button
                disabled={currentPage === lastPage}
                onClick={() => setPage(currentPage + 1)}
                className="focus-visible:outline focus-visible:outline-2"
              >
                Next
              </Button>
            </div>
          ) : null}
          {query ? (
            <Button
              onClick={() => {
                setQuery('');
                setPage(0);
                searchRef.current?.focus();
              }}
              className="focus-visible:outline focus-visible:outline-2"
            >
              Clear search
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
