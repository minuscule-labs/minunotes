import { Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  ApiKey,
  ApiKeyAccessMode,
  Folder,
  OAuthAuthorization,
  SharedAccessMode,
  SharedCollaboration,
} from '../lib/api';
import { SharedIntegrationAccess } from './shared-integration-access';
import { Button } from './ui/button';

export type PermissionValue = { canRead: boolean; canCreate: boolean; canEdit: boolean; canComment: boolean };
export type IntegrationAccessPayload = PermissionValue & {
  accessMode: ApiKeyAccessMode;
  canCreateFolders: boolean;
  sharedAccessMode: SharedAccessMode;
  collaborationGrantIds: string[];
  permissions: Array<PermissionValue & { folderId: string; appliesTo: 'exact' | 'subtree' }>;
};
export type IntegrationCapabilities = PermissionValue & { canCreateFolders: boolean };
type PermissionKey = keyof PermissionValue;

const PERMISSION_ORDER: PermissionKey[] = ['canRead', 'canCreate', 'canComment', 'canEdit'];

const defaultPermission: PermissionValue = {
  canRead: true,
  canCreate: false,
  canEdit: false,
  canComment: false,
};

export function applyCommentPermissionToFolders(
  current: Map<string, PermissionValue>,
  folderIds: Iterable<string>,
  enabled: boolean
) {
  return applyPermissionToFolders(current, folderIds, 'canComment', enabled);
}

export function applyFolderPermission(
  current: Map<string, PermissionValue>,
  folderId: string,
  permission: PermissionKey,
  enabled: boolean,
  fallback: PermissionValue = defaultPermission
) {
  const next = new Map(current);
  const value = next.get(folderId) ?? fallback;
  if (permission === 'canComment' && enabled) next.set(folderId, { ...value, canRead: true, canComment: true });
  else if (permission === 'canRead' && !enabled) next.set(folderId, { ...value, canRead: false, canComment: false });
  else next.set(folderId, { ...value, [permission]: enabled });
  return next;
}

export function applyPermissionToFolders(
  current: Map<string, PermissionValue>,
  folderIds: Iterable<string>,
  permission: PermissionKey,
  enabled: boolean,
  fallback: PermissionValue = defaultPermission
) {
  let next = new Map(current);
  for (const folderId of folderIds) next = applyFolderPermission(next, folderId, permission, enabled, fallback);
  return next;
}

export function derivePermissionCeiling(permissions: Iterable<PermissionValue>): PermissionValue {
  const ceiling = { canRead: false, canCreate: false, canEdit: false, canComment: false };
  for (const permission of permissions) {
    ceiling.canRead ||= permission.canRead;
    ceiling.canCreate ||= permission.canCreate;
    ceiling.canEdit ||= permission.canEdit;
    ceiling.canComment ||= permission.canComment;
  }
  if (ceiling.canComment) ceiling.canRead = true;
  return ceiling;
}

export function permissionSelectionState(permissions: PermissionValue[], permission: PermissionKey) {
  const enabledCount = permissions.filter((value) => value[permission]).length;
  return {
    checked: permissions.length > 0 && enabledCount === permissions.length,
    mixed: enabledCount > 0 && enabledCount < permissions.length,
  };
}

function permissionLabel(permission: PermissionKey) {
  if (permission === 'canRead') return 'Read';
  if (permission === 'canCreate') return 'Create';
  if (permission === 'canComment') return 'Comment';
  return 'Edit';
}

function isEffectivelyPrivate(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let current: Folder | undefined = folder;
  const seen = new Set<string>();

  while (current) {
    if (current.isPrivate) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

function folderPath(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  const parts = [folder.title];
  let current = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    parts.unshift(current.title);
    seen.add(current.id);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }

  return parts.join(' / ');
}

function isEffectivelyAgentReadOnly(folder: Folder, folders: Folder[]) {
  const byId = new Map(folders.map((item) => [item.id, item]));
  let current: Folder | undefined = folder;
  const seen = new Set<string>();

  while (current) {
    if (current.isAgentReadOnly) return true;
    if (!current.parentFolderId || seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.parentFolderId);
  }

  return false;
}

function scopeLabel(mode: ApiKeyAccessMode) {
  if (mode === 'all') return 'All non-private folders';
  if (mode === 'top_level') return 'Project roots';
  return 'Specific folders';
}

export function IntegrationAccessForm({
  folders,
  collaborations,
  initialGrant,
  allowedPermissions,
  onSubmit,
  onSavingChange,
  submitLabel,
  disabled = false,
  allowFolderCreationOnly = true,
  actorLabel = 'app',
  actions,
}: {
  folders: Folder[];
  collaborations: SharedCollaboration[];
  initialGrant?: ApiKey | OAuthAuthorization;
  allowedPermissions?: IntegrationCapabilities;
  onSubmit: (payload: IntegrationAccessPayload) => Promise<void>;
  onSavingChange?: (saving: boolean) => void;
  submitLabel: string;
  disabled?: boolean;
  allowFolderCreationOnly?: boolean;
  actorLabel?: 'app' | 'key';
  actions?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [folderPermissions, setFolderPermissions] = useState<Map<string, PermissionValue>>(new Map());
  const [accessMode, setAccessMode] = useState<ApiKeyAccessMode>('all');
  const [keyPermission, setKeyPermission] = useState<PermissionValue>(defaultPermission);
  const [canCreateFolders, setCanCreateFolders] = useState(false);
  const [sharedAccessMode, setSharedAccessMode] = useState<SharedAccessMode>('none');
  const [selectedGrantIds, setSelectedGrantIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const currentGrant = initialGrant;
  const selectableFolders = useMemo(
    () => folders.filter((folder) => !isEffectivelyPrivate(folder, folders)),
    [folders]
  );
  const folderOptions = useMemo(() => {
    const candidates =
      accessMode === 'top_level'
        ? selectableFolders.filter((folder) => folder.parentFolderId === null)
        : selectableFolders;
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return candidates
      .filter((folder) => !selectedFolderIds.has(folder.id))
      .filter(
        (folder) =>
          !q || folder.title.toLowerCase().includes(q) || folderPath(folder, folders).toLowerCase().includes(q)
      )
      .sort((a, b) => folderPath(a, folders).localeCompare(folderPath(b, folders)))
      .slice(0, 8);
  }, [accessMode, folders, query, selectableFolders, selectedFolderIds]);
  const selectedFolders = useMemo(
    () =>
      selectableFolders
        .filter((folder) => selectedFolderIds.has(folder.id))
        .sort((a, b) => folderPath(a, folders).localeCompare(folderPath(b, folders))),
    [folders, selectableFolders, selectedFolderIds]
  );
  const restrictedScope = accessMode !== 'all';
  const allowed = allowedPermissions ?? {
    canRead: true,
    canCreate: true,
    canComment: true,
    canEdit: true,
    canCreateFolders: true,
  };
  const initialPermission = { ...defaultPermission, canRead: allowed.canRead };
  const folderPermissionFallback = restrictedScope ? initialPermission : keyPermission;
  const selectedPermissionValues = [...selectedFolderIds].map(
    (folderId) => folderPermissions.get(folderId) ?? folderPermissionFallback
  );
  const effectiveKeyPermission = restrictedScope ? derivePermissionCeiling(selectedPermissionValues) : keyPermission;

  useEffect(() => {
    setError(null);
    setQuery('');
    setCanCreateFolders(currentGrant?.canCreateFolders ?? false);
    setAccessMode(currentGrant?.accessMode ?? 'all');
    setSharedAccessMode(currentGrant?.sharedAccessMode ?? 'none');
    setSelectedGrantIds(new Set(currentGrant?.collaborationGrantIds ?? []));
    setKeyPermission(
      currentGrant
        ? {
            canRead: currentGrant.canRead,
            canCreate: currentGrant.canCreate,
            canEdit: currentGrant.canEdit,
            canComment: currentGrant.canComment,
          }
        : { ...defaultPermission, canRead: allowedPermissions?.canRead ?? true }
    );
    setSelectedFolderIds(new Set((currentGrant?.permissions ?? []).map((permission) => permission.folderId)));
    setFolderPermissions(
      new Map(
        (currentGrant?.permissions ?? []).map((permission) => [
          permission.folderId,
          {
            canRead: permission.canRead,
            canCreate: permission.canCreate,
            canEdit: permission.canEdit,
            canComment: permission.canComment,
          },
        ])
      )
    );
  }, [currentGrant, allowedPermissions?.canRead]);
  const addFolder = (folder: Folder) => {
    setSelectedFolderIds((current) => new Set(current).add(folder.id));
    setFolderPermissions((current) => new Map(current).set(folder.id, { ...folderPermissionFallback }));
    setQuery('');
  };
  const removeFolder = (folderId: string) =>
    setSelectedFolderIds((current) => {
      const next = new Set(current);
      next.delete(folderId);
      return next;
    });
  const removeFolderRule = (folderId: string) => {
    removeFolder(folderId);
    setFolderPermissions((current) => {
      const next = new Map(current);
      next.delete(folderId);
      return next;
    });
  };
  const updateFolderPermission = (folderId: string, permission: PermissionKey, enabled: boolean) =>
    setFolderPermissions((current) =>
      applyFolderPermission(current, folderId, permission, enabled, folderPermissionFallback)
    );
  const selectedPermissions = () =>
    [...selectedFolderIds].map((folderId) => ({
      folderId,
      ...(folderPermissions.get(folderId) ?? folderPermissionFallback),
      appliesTo: accessMode === 'top_level' ? ('subtree' as const) : ('exact' as const),
    }));

  const submit = async () => {
    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    try {
      const accessPayload = {
        accessMode,
        canCreateFolders,
        sharedAccessMode,
        collaborationGrantIds: sharedAccessMode === 'specific' ? [...selectedGrantIds] : [],
        ...effectiveKeyPermission,
        permissions: selectedPermissions(),
      };
      await onSubmit(accessPayload);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to save access settings');
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  return (
    <>
      {allowedPermissions ? (
        <p className="mt-4 text-slate-500 text-xs">
          Only permissions requested by this app are available. Disabled permissions were not requested.
        </p>
      ) : null}
      <div className="mt-4">
        <p className="font-medium text-sm">Scope</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(['all', 'top_level', 'specific'] as const).map((mode) => (
            <label
              key={mode}
              className="flex items-start gap-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800"
            >
              <input
                className="mt-1"
                type="radio"
                checked={accessMode === mode}
                onChange={() => {
                  setAccessMode(mode);
                  setSelectedFolderIds(new Set());
                  setFolderPermissions(new Map());
                  setQuery('');
                }}
              />
              <span>
                <span className="block font-medium">{scopeLabel(mode)}</span>
                <span className="text-slate-500 text-xs">
                  {mode === 'all'
                    ? 'All except private/read-only limits.'
                    : mode === 'top_level'
                      ? 'Selected roots include subfolders.'
                      : 'Exact folder access.'}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <p className="font-medium text-sm">
          {restrictedScope ? 'Permissions for all selected folders' : 'Global maximum permissions'}
        </p>
        <p className="mt-1 text-slate-500 text-xs">
          {restrictedScope
            ? selectedFolderIds.size === 0
              ? 'Add a folder below to enable bulk controls, then adjust individual folders.'
              : 'Use these as bulk controls, then adjust individual folders below.'
            : 'Folder rules can restrict these permissions but can never exceed them.'}
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {PERMISSION_ORDER.map((key) => {
            const selection = permissionSelectionState(selectedPermissionValues, key);
            return (
              <label key={key} className="flex items-center gap-1 text-slate-500 text-xs">
                <input
                  ref={(input) => {
                    if (input) input.indeterminate = restrictedScope && selection.mixed;
                  }}
                  type="checkbox"
                  checked={restrictedScope ? selection.checked : keyPermission[key]}
                  disabled={!allowed[key] || (restrictedScope && selectedFolderIds.size === 0)}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    if (restrictedScope) {
                      setFolderPermissions((current) =>
                        applyPermissionToFolders(current, selectedFolderIds, key, enabled, initialPermission)
                      );
                      return;
                    }
                    setKeyPermission((current) => {
                      if (key === 'canComment' && enabled) return { ...current, canRead: true, canComment: true };
                      if (key === 'canRead' && !enabled) return { ...current, canRead: false, canComment: false };
                      return { ...current, [key]: enabled };
                    });
                    if (key === 'canComment') {
                      setFolderPermissions((current) =>
                        applyCommentPermissionToFolders(current, selectedFolderIds, enabled)
                      );
                    }
                  }}
                />
                {permissionLabel(key)}
              </label>
            );
          })}
        </div>
        <label className="mt-4 flex items-start gap-3 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={canCreateFolders}
            disabled={!allowed.canCreateFolders}
            onChange={(e) => setCanCreateFolders(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Allow folder creation</span>
            <span className="mt-1 block text-slate-500 text-xs">
              New folders created by this {actorLabel} follow this authorization's scope.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <p className="block font-medium text-slate-500 text-xs uppercase tracking-wide">
          {accessMode === 'all'
            ? 'Folder restrictions (optional)'
            : accessMode === 'top_level'
              ? 'Project roots'
              : 'Specific folders'}
        </p>
        {accessMode === 'all' ? (
          <p className="mt-1 text-slate-500 text-xs">
            Folders without a rule use the global maximum permissions above.
          </p>
        ) : null}
        <input
          className="mt-2 w-full rounded-md border bg-transparent px-3 py-2 text-sm dark:border-slate-800"
          aria-label={accessMode === 'top_level' ? 'Search top-level folders' : 'Search folders'}
          placeholder={accessMode === 'top_level' ? 'Search top-level folders...' : 'Search folders...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {folderOptions.length > 0 ? (
          <div className="mt-2 overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
            {folderOptions.map((folder) => (
              <button
                key={folder.id}
                type="button"
                aria-label={`Add ${folder.title}`}
                className="flex w-full items-center justify-between gap-3 border-slate-200 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
                onClick={() => addFolder(folder)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {folder.title}
                    {isEffectivelyAgentReadOnly(folder, folders) ? (
                      <span className="ml-2 text-amber-600 text-xs">Read-only</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-slate-500 text-xs">{folderPath(folder, folders)}</span>
                </span>
                <Plus className="h-4 w-4 shrink-0 text-slate-500" />
              </button>
            ))}
          </div>
        ) : query.trim() ? (
          <p className="mt-2 text-slate-500 text-xs">No matching folders.</p>
        ) : null}
        <div className="mt-3 space-y-2">
          {selectedFolders.map((folder) => {
            const value = folderPermissions.get(folder.id) ?? folderPermissionFallback;
            return (
              <div
                key={folder.id}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {folder.title}
                      {isEffectivelyAgentReadOnly(folder, folders) ? (
                        <span className="ml-2 text-amber-600 text-xs">Read-only</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-slate-500 text-xs">
                      {accessMode === 'top_level'
                        ? 'Rule includes non-private subfolders'
                        : folderPath(folder, folders)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-900"
                    onClick={() => removeFolderRule(folder.id)}
                    aria-label={`Remove ${folder.title}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 border-slate-200 border-t pt-2 dark:border-slate-800">
                  {PERMISSION_ORDER.map((permission) => (
                    <label key={permission} className="flex items-center gap-1 text-slate-500 text-xs">
                      <input
                        type="checkbox"
                        checked={restrictedScope ? value[permission] : value[permission] && keyPermission[permission]}
                        disabled={!allowed[permission] || (!restrictedScope && !keyPermission[permission])}
                        onChange={(event) => updateFolderPermission(folder.id, permission, event.target.checked)}
                      />
                      {permissionLabel(permission)}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          {selectedFolders.length === 0 ? (
            <p className="rounded-md border border-slate-300 border-dashed p-3 text-slate-500 text-sm dark:border-slate-800">
              {accessMode === 'all' ? 'No folder restrictions.' : 'No folders selected.'}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        <SharedIntegrationAccess
          collaborations={collaborations}
          mode={sharedAccessMode}
          selectedGrantIds={selectedGrantIds}
          onModeChange={setSharedAccessMode}
          onSelectionChange={setSelectedGrantIds}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-red-600 text-sm">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {actions}
        <Button
          disabled={
            disabled ||
            saving ||
            (accessMode !== 'all' && selectedFolderIds.size === 0) ||
            (sharedAccessMode === 'specific' && selectedGrantIds.size === 0) ||
            !(
              effectiveKeyPermission.canRead ||
              effectiveKeyPermission.canCreate ||
              effectiveKeyPermission.canEdit ||
              effectiveKeyPermission.canComment ||
              (allowFolderCreationOnly && canCreateFolders)
            )
          }
          onClick={submit}
        >
          {saving ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </>
  );
}
