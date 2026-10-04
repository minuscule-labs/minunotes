import { Check, Copy, Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  type ApiKey,
  type ApiKeyAccessMode,
  api,
  type Folder,
  type OAuthAuthorization,
  type SharedAccessMode,
  type SharedCollaboration,
} from '../lib/api';
import { SharedIntegrationAccess } from './shared-integration-access';
import { Button } from './ui/button';
import { ModalCloseButton } from './ui/modal-close-button';

type PermissionValue = { canRead: boolean; canCreate: boolean; canEdit: boolean; canComment: boolean };
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

export function ApiKeyAccessDialog({
  folders,
  collaborations,
  apiKey,
  oauthAuthorization,
  onSaved,
  trigger,
}: {
  folders: Folder[];
  collaborations: SharedCollaboration[];
  apiKey?: ApiKey;
  oauthAuthorization?: OAuthAuthorization;
  onSaved: () => void;
  trigger: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [folderPermissions, setFolderPermissions] = useState<Map<string, PermissionValue>>(new Map());
  const [accessMode, setAccessMode] = useState<ApiKeyAccessMode>('all');
  const [keyPermission, setKeyPermission] = useState<PermissionValue>(defaultPermission);
  const [canCreateFolders, setCanCreateFolders] = useState(false);
  const [sharedAccessMode, setSharedAccessMode] = useState<SharedAccessMode>('none');
  const [selectedGrantIds, setSelectedGrantIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const currentGrant = oauthAuthorization ?? apiKey;
  const isOAuthAuthorization = !!oauthAuthorization;
  const isEditing = !!currentGrant;
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
  const folderPermissionFallback = restrictedScope ? defaultPermission : keyPermission;
  const selectedPermissionValues = [...selectedFolderIds].map(
    (folderId) => folderPermissions.get(folderId) ?? folderPermissionFallback
  );
  const effectiveKeyPermission = restrictedScope ? derivePermissionCeiling(selectedPermissionValues) : keyPermission;

  useEffect(() => {
    if (!open) return;
    setName(apiKey?.name ?? '');
    setQuery('');
    setCreatedKey(null);
    setCopied(false);
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
        : defaultPermission
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
  }, [apiKey, oauthAuthorization, currentGrant, open]);

  const close = () => setOpen(false);
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
    try {
      const accessPayload = {
        accessMode,
        canCreateFolders,
        sharedAccessMode,
        collaborationGrantIds: sharedAccessMode === 'specific' ? [...selectedGrantIds] : [],
        ...effectiveKeyPermission,
        permissions: selectedPermissions(),
      };
      if (oauthAuthorization) {
        await api.updateOAuthAuthorization(oauthAuthorization.id, accessPayload);
        setOpen(false);
      } else if (apiKey) {
        await api.updateApiKey(apiKey.id, { ...accessPayload, name });
        setOpen(false);
      } else {
        const result = await api.createApiKey({ ...accessPayload, name });
        setCreatedKey(result.key);
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  const copyKey = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      {trigger(() => setOpen(true))}
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="notes-modal-scroll max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-lg border bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {isOAuthAuthorization
                    ? `Edit ${oauthAuthorization.client.name} access`
                    : isEditing
                      ? 'Edit API key'
                      : 'Create API key'}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {isOAuthAuthorization
                    ? 'Choose what this connected app can access. Changes apply to its existing tokens.'
                    : 'Choose a scope, then set what this key can do there.'}
                </p>
              </div>
              <ModalCloseButton
                label={isOAuthAuthorization ? 'Close connected app access' : 'Close API key access'}
                disabled={saving}
                onClick={close}
              />
            </div>

            {createdKey ? (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  Copy this key now. It will not be shown again.
                </p>
                <div className="mt-2 flex items-center gap-2 rounded bg-white p-2 dark:bg-slate-900">
                  <code className="min-w-0 flex-1 overflow-x-auto text-xs">{createdKey}</code>
                  <button
                    className={`rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800 ${copied ? 'text-emerald-600' : 'text-slate-500'}`}
                    onClick={copyKey}
                    aria-label="Copy API key"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {!isOAuthAuthorization ? (
                  <input
                    className="mt-4 w-full rounded-md border bg-transparent px-3 py-2 text-sm dark:border-slate-800"
                    placeholder="Key name, e.g. Workout Script"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                ) : null}

                <div className="mt-4">
                  <label className="text-sm font-medium">Scope</label>
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
                          <span className="text-xs text-slate-500">
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
                  <p className="text-sm font-medium">
                    {restrictedScope ? 'Permissions for all selected folders' : 'Global maximum permissions'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {restrictedScope
                      ? 'Use these as bulk controls, then adjust individual folders below.'
                      : 'Folder rules can restrict these permissions but can never exceed them.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    {PERMISSION_ORDER.map((key) => {
                      const selection = permissionSelectionState(selectedPermissionValues, key);
                      return (
                        <label key={key} className="flex items-center gap-1 text-xs text-slate-500">
                          <input
                            ref={(input) => {
                              if (input) input.indeterminate = restrictedScope && selection.mixed;
                            }}
                            type="checkbox"
                            checked={restrictedScope ? selection.checked : keyPermission[key]}
                            disabled={restrictedScope && selectedFolderIds.size === 0}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              if (restrictedScope) {
                                setFolderPermissions((current) =>
                                  applyPermissionToFolders(current, selectedFolderIds, key, enabled, defaultPermission)
                                );
                                return;
                              }
                              setKeyPermission((current) => {
                                if (key === 'canComment' && enabled)
                                  return { ...current, canRead: true, canComment: true };
                                if (key === 'canRead' && !enabled)
                                  return { ...current, canRead: false, canComment: false };
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
                      onChange={(e) => setCanCreateFolders(e.target.checked)}
                    />
                    <span>
                      <span className="block font-medium">Allow folder creation</span>
                      <span className="mt-1 block text-xs text-slate-500">
                        {isOAuthAuthorization
                          ? "New folders created by this app follow this authorization's scope."
                          : "New folders created by this key follow this key's scope."}
                      </span>
                    </span>
                  </label>
                </div>

                <div className="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-800">
                  <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
                    {accessMode === 'all'
                      ? 'Folder restrictions (optional)'
                      : accessMode === 'top_level'
                        ? 'Project roots'
                        : 'Specific folders'}
                  </label>
                  {accessMode === 'all' ? (
                    <p className="mt-1 text-xs text-slate-500">
                      Folders without a rule use the global maximum permissions above.
                    </p>
                  ) : null}
                  <input
                    className="mt-2 w-full rounded-md border bg-transparent px-3 py-2 text-sm dark:border-slate-800"
                    placeholder={accessMode === 'top_level' ? 'Search top-level folders...' : 'Search folders...'}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {folderOptions.length > 0 ? (
                    <div className="mt-2 overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
                      {folderOptions.map((folder) => (
                        <button
                          key={folder.id}
                          className="flex w-full items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
                          onClick={() => addFolder(folder)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {folder.title}
                              {isEffectivelyAgentReadOnly(folder, folders) ? (
                                <span className="ml-2 text-xs text-amber-600">Read-only</span>
                              ) : null}
                            </span>
                            <span className="block truncate text-xs text-slate-500">{folderPath(folder, folders)}</span>
                          </span>
                          <Plus className="h-4 w-4 shrink-0 text-slate-500" />
                        </button>
                      ))}
                    </div>
                  ) : query.trim() ? (
                    <p className="mt-2 text-xs text-slate-500">No matching folders.</p>
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
                                  <span className="ml-2 text-xs text-amber-600">Read-only</span>
                                ) : null}
                              </span>
                              <span className="block truncate text-xs text-slate-500">
                                {accessMode === 'top_level'
                                  ? 'Rule includes non-private subfolders'
                                  : folderPath(folder, folders)}
                              </span>
                            </span>
                            <button
                              className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-900"
                              onClick={() => removeFolderRule(folder.id)}
                              aria-label={`Remove ${folder.title}`}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-3 border-slate-200 border-t pt-2 dark:border-slate-800">
                            {PERMISSION_ORDER.map((permission) => (
                              <label key={permission} className="flex items-center gap-1 text-xs text-slate-500">
                                <input
                                  type="checkbox"
                                  checked={
                                    restrictedScope ? value[permission] : value[permission] && keyPermission[permission]
                                  }
                                  disabled={!restrictedScope && !keyPermission[permission]}
                                  onChange={(event) =>
                                    updateFolderPermission(folder.id, permission, event.target.checked)
                                  }
                                />
                                {permissionLabel(permission)}
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {selectedFolders.length === 0 ? (
                      <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-800">
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

                <div className="mt-4 flex justify-end">
                  <Button
                    disabled={
                      (!isOAuthAuthorization && !name.trim()) ||
                      saving ||
                      (accessMode !== 'all' && selectedFolderIds.size === 0) ||
                      (sharedAccessMode === 'specific' && selectedGrantIds.size === 0) ||
                      !(
                        effectiveKeyPermission.canRead ||
                        effectiveKeyPermission.canCreate ||
                        effectiveKeyPermission.canEdit ||
                        effectiveKeyPermission.canComment ||
                        (isOAuthAuthorization && canCreateFolders)
                      )
                    }
                    onClick={submit}
                  >
                    {isEditing ? 'Save changes' : 'Create key'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
