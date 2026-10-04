import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type ApiKey, api, type Folder, type OAuthAuthorization, type SharedCollaboration } from '../lib/api';
import { IntegrationAccessForm, type IntegrationAccessPayload } from './integration-access-form';
import { ModalCloseButton } from './ui/modal-close-button';

export {
  applyCommentPermissionToFolders,
  applyFolderPermission,
  applyPermissionToFolders,
  derivePermissionCeiling,
  permissionSelectionState,
} from './integration-access-form';

export function ApiKeyAccessDialog({
  folders,
  collaborations,
  apiKey,
  oauthAuthorization,
  onSaved,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  folders: Folder[];
  collaborations: SharedCollaboration[];
  apiKey?: ApiKey;
  oauthAuthorization?: OAuthAuthorization;
  onSaved: () => void;
  trigger?: (open: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const [name, setName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const isEditing = !!(oauthAuthorization ?? apiKey);

  useEffect(() => {
    if (!open) return;
    setName(apiKey?.name ?? '');
    setCreatedKey(null);
    setCopied(false);
  }, [open, apiKey?.name]);

  const submit = async (payload: IntegrationAccessPayload) => {
    if (oauthAuthorization) {
      await api.updateOAuthAuthorization(oauthAuthorization.id, payload);
      setOpen(false);
    } else if (apiKey) {
      await api.updateApiKey(apiKey.id, { ...payload, name });
      setOpen(false);
    } else {
      const result = await api.createApiKey({ ...payload, name });
      setCreatedKey(result.key);
    }
    onSaved();
  };
  const copyKey = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      {trigger?.(() => setOpen(true))}
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
          <div className="notes-modal-scroll max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-lg border bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold text-lg">
                  {oauthAuthorization
                    ? `Edit ${oauthAuthorization.client.name} access`
                    : isEditing
                      ? 'Edit API key'
                      : 'Create API key'}
                </h2>
                <p className="mt-1 text-slate-500 text-sm">
                  {oauthAuthorization
                    ? 'Choose what this connected app can access. Changes apply to its existing tokens.'
                    : 'Choose a scope, then set what this key can do there.'}
                </p>
              </div>
              <ModalCloseButton
                label={oauthAuthorization ? 'Close connected app access' : 'Close API key access'}
                disabled={saving}
                onClick={() => setOpen(false)}
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
                    type="button"
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
                {!oauthAuthorization ? (
                  <input
                    className="mt-4 w-full rounded-md border bg-transparent px-3 py-2 text-sm dark:border-slate-800"
                    aria-label="Key name"
                    placeholder="Key name, e.g. Workout Script"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                ) : null}
                <IntegrationAccessForm
                  folders={folders}
                  collaborations={collaborations}
                  initialGrant={oauthAuthorization ?? apiKey}
                  actorLabel={oauthAuthorization ? 'app' : 'key'}
                  allowFolderCreationOnly={!!oauthAuthorization}
                  disabled={!oauthAuthorization && !name.trim()}
                  submitLabel={isEditing ? 'Save changes' : 'Create key'}
                  onSubmit={submit}
                  onSavingChange={setSaving}
                />
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
