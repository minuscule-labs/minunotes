import { and, eq, isNull, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import { attachments, folders, notes } from '../db/schema';

export function filterActiveFolderHierarchy<T extends { id: string; parentFolderId: string | null }>(rows: T[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.filter((row) => {
    let current = row;
    const seen = new Set<string>();
    while (current.parentFolderId) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const parent = byId.get(current.parentFolderId);
      if (!parent) return false;
      current = parent;
    }
    return true;
  });
}

/** Outer-column wrappers must retain explicit table qualifiers inside the recursive SQL fragment. */
export function activeFolderPathWhere(folderId: SQLWrapper, userId: string | SQLWrapper) {
  return sql`exists (
    with recursive folder_path(id, parent_folder_id, deleted_at) as (
      select path_folder.id, path_folder.parent_folder_id, path_folder.deleted_at
      from ${folders} as path_folder
      where path_folder.id = ${folderId} and path_folder.user_id = ${userId}
      union
      select parent.id, parent.parent_folder_id, parent.deleted_at
      from ${folders} as parent
      inner join folder_path as child on parent.id = child.parent_folder_id
      where parent.user_id = ${userId}
    )
    select 1
    where exists (select 1 from folder_path where parent_folder_id is null)
      and not exists (select 1 from folder_path where deleted_at is not null)
  )`;
}

export function activeFolderWhere(userId: string, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(folders.userId, userId),
    isNull(folders.deletedAt),
    activeFolderPathWhere(sql.raw('"folders"."id"'), userId),
    ...conditions
  );
}

export function activeNoteWhere(userId: string, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(notes.userId, userId),
    isNull(notes.deletedAt),
    activeFolderPathWhere(sql.raw('"notes"."folder_id"'), userId),
    ...conditions
  );
}

export function activeAttachmentWhere(userId: string, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(attachments.userId, userId),
    isNull(attachments.deletedAt),
    sql`exists (
      with recursive folder_path(id, parent_folder_id, deleted_at) as (
        select path_folder.id, path_folder.parent_folder_id, path_folder.deleted_at
        from ${folders} as path_folder
        inner join ${notes} as attachment_note on attachment_note.folder_id = path_folder.id
        where attachment_note.id = ${attachments.noteId}
          and attachment_note.user_id = ${userId}
          and attachment_note.deleted_at is null
          and path_folder.user_id = ${userId}
        union
        select parent.id, parent.parent_folder_id, parent.deleted_at
        from ${folders} as parent
        inner join folder_path as child on parent.id = child.parent_folder_id
        where parent.user_id = ${userId}
      )
      select 1
      where exists (select 1 from folder_path where parent_folder_id is null)
        and not exists (select 1 from folder_path where deleted_at is not null)
    )`,
    ...conditions
  );
}
