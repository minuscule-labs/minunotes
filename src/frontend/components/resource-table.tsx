import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ReactNode } from 'react';

export type ResourceColumn<T> = {
  id: string;
  header: ReactNode;
  cell: (item: T) => ReactNode;
  width?: string;
  align?: 'left' | 'center' | 'right';
  hiddenBelow?: 'sm' | 'md';
};
const visibility = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell' };
const columnVisibility = { sm: 'hidden sm:table-column', md: 'hidden md:table-column' };
const alignment = { left: 'text-left', center: 'text-center', right: 'text-right' };

// Shared name presentation: bounded text, full accessible name and native hover text.
export function ResourceName({ children }: { children: string }) {
  return (
    <span className="block min-w-0 truncate" title={children}>
      {children}
    </span>
  );
}

// Rendering/layout only. Adapters retain authorization, selection, ordering and mutations.
export function ResourceTable<T>({
  items,
  columns,
  rowId,
  mobileRows,
  empty,
  minWidth,
}: {
  items: T[];
  columns: ResourceColumn<T>[];
  rowId: (item: T) => string;
  mobileRows?: ReactNode;
  empty?: ReactNode;
  minWidth?: number;
}) {
  const definitions: ColumnDef<T>[] = columns.map((column) => ({ id: column.id }));
  const table = useReactTable({
    data: items,
    columns: definitions,
    getRowId: rowId,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <>
      {mobileRows ? <div className="space-y-2 md:hidden">{mobileRows}</div> : null}
      <div
        data-resource-table
        className={`relative min-w-0 overflow-x-auto rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] ${mobileRows ? 'hidden md:block' : ''}`}
      >
        <table
          className="w-full table-fixed border-collapse text-sm"
          style={{ minWidth: minWidth ?? (mobileRows ? 640 : undefined) }}
        >
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.id}
                style={{ width: column.width }}
                className={column.hiddenBelow ? columnVisibility[column.hiddenBelow] : undefined}
              />
            ))}
          </colgroup>
          <thead className="bg-[var(--notes-table-header-bg)]">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header, index) => (
                  <th
                    key={header.id}
                    scope="col"
                    className={`border-[var(--notes-border)] border-b px-4 py-2.5 font-medium text-[var(--notes-muted)] text-xs uppercase tracking-wide ${alignment[columns[index].align ?? 'left']} ${columns[index].hiddenBelow ? visibility[columns[index].hiddenBelow] : ''}`}
                  >
                    {columns[index].header}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-[var(--notes-table-row-hover)]">
                {row.getVisibleCells().map((cell, index) => (
                  <td
                    key={cell.id}
                    className={`min-w-0 whitespace-normal border-[var(--notes-table-row-border)] border-b px-4 py-3 align-middle [overflow-wrap:anywhere] ${alignment[columns[index].align ?? 'left']} ${columns[index].hiddenBelow ? visibility[columns[index].hiddenBelow] : ''}`}
                  >
                    {/* Pure render callbacks, not changing component types: preserve input/menu state across adapter rerenders. */}
                    {columns[index].cell(row.original)}
                  </td>
                ))}
              </tr>
            ))}
            {!items.length && empty ? (
              <tr>
                <td colSpan={columns.length} className="notes-muted px-4 py-6 text-center">
                  {empty}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
