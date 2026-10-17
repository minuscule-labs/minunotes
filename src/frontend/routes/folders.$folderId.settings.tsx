import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { DeleteConfirmDialog } from '../components/delete-confirm-dialog';
import { FolderPropertiesSettings } from '../components/folder-properties-settings';
import { RenameFolderDialog } from '../components/rename-folder-dialog';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ApiError, api } from '../lib/api';
import { rootRoute } from './__root';

function FolderSettingsView() {
  const { folderId } = folderSettingsRoute.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renameOpen, setRenameOpen] = useState(false);
  const [membershipBase, setMembershipBase] = useState<Record<
    string,
    { folders: import('../lib/api').Folder[]; snapshot?: string }
  > | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState('');
  const [refreshingAssignments, setRefreshingAssignments] = useState(false);
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const templates = useQuery({ queryKey: ['templates', 'all'], queryFn: api.allTemplates });
  const assigned = useQuery({ queryKey: ['folder-templates', folderId], queryFn: () => api.folderTemplates(folderId) });
  const folder = folders.data?.folders.find((item) => item.id === folderId);

  const memberships = useQuery({
    queryKey: ['template-memberships', folderId, templates.data?.templates.map((t) => t.id)],
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          (templates.data?.templates ?? []).map(async (t) => [t.id, await api.templateFolders(t.id)] as const)
        )
      ),
    enabled: Boolean(templates.data),
    retry: false,
  });
  useEffect(() => {
    if (!assigned.data || !memberships.data || membershipBase) return;
    setSelectedIds(new Set(assigned.data.templates.map((template) => template.id)));
    setMembershipBase(memberships.data);
  }, [assigned.data, memberships.data, membershipBase]);

  const saveTemplates = useMutation({
    mutationFn: async () => {
      const templatesToUpdate = templates.data?.templates ?? [];
      await Promise.all(
        templatesToUpdate.map(async (template) => {
          const current = membershipBase?.[template.id];
          if (!current) throw new Error('Refresh assignments before saving');
          const folderIds = new Set(current.folders.map((item) => item.id));
          if (selectedIds.has(template.id)) folderIds.add(folderId);
          else folderIds.delete(folderId);
          return api.updateTemplateFolders(template.id, [...folderIds], current.snapshot);
        })
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['folder-templates', folderId] });
      const latest = await memberships.refetch();
      if (latest.data) setMembershipBase(latest.data);
      setAssignmentMessage('Template assignments saved');
    },
    onError: (error: Error) =>
      setAssignmentMessage(
        `${error.message}. Your assignment selection is preserved; refresh and review before retrying.`
      ),
  });

  const privacy = useMutation({
    mutationFn: (isPrivate: boolean) => api.updateFolder(folderId, { isPrivate }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });
  const agentReadOnly = useMutation({
    mutationFn: (isAgentReadOnly: boolean) => api.updateFolder(folderId, { isAgentReadOnly }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteFolder(folderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['notes'] });
      qc.invalidateQueries({ queryKey: ['templates'] });
      qc.invalidateQueries({ queryKey: ['folder-templates'] });
      qc.removeQueries({ queryKey: ['note'] });
      return nav({ to: '/' });
    },
  });

  if (folders.isLoading || templates.isLoading || assigned.isLoading)
    return <p className="notes-muted text-sm">Loading folder settings...</p>;
  if (folders.error instanceof ApiError || !folder)
    return (
      <section className="grid min-h-[60vh] place-items-center">
        <EmptyState title="Folder not found">
          <Button className="mt-4" onClick={() => nav({ to: '/' })}>
            Back to notes
          </Button>
        </EmptyState>
      </section>
    );

  return (
    <section className="mx-auto w-full max-w-4xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="notes-muted text-sm">Folder settings</p>
          <h2 className="font-semibold text-xl">{folder.title}</h2>
        </div>
        <Button variant="secondary" onClick={() => nav({ to: '/folders/$folderId', params: { folderId } })}>
          Back to folder
        </Button>
      </div>

      <div className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4">
        <h3 className="font-semibold">General</h3>
        <p className="notes-muted mt-1 text-sm">Manage this folder.</p>
        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-3 rounded-md border border-[var(--notes-border)] p-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={folder.isPrivate}
              disabled={privacy.isPending}
              onChange={(event) => privacy.mutate(event.target.checked)}
            />
            <span>
              <span className="block font-medium">Private folder</span>
              <span className="notes-muted mt-1 block text-xs">
                Private folders and their subfolders are not accessible to API keys, MCP, or integrations.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-md border border-[var(--notes-border)] p-3 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={folder.isAgentReadOnly}
              disabled={agentReadOnly.isPending}
              onChange={(event) => agentReadOnly.mutate(event.target.checked)}
            />
            <span>
              <span className="block font-medium">Read-only for agents</span>
              <span className="notes-muted mt-1 block text-xs">
                Global and project-root API keys can read this folder, but cannot create or edit notes here. Specific
                folder grants can still write.
              </span>
            </span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setRenameOpen(true)}>
            Rename
          </Button>
          <Button variant="secondary" disabled title="Folder moving is coming with folder tree support.">
            Move
          </Button>
        </div>
      </div>

      <FolderPropertiesSettings key={folderId} folderId={folderId} />

      <div className="rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel)] p-4">
        <h3 className="font-semibold">Templates</h3>
        <p className="notes-muted mt-1 text-sm">
          Choose which global templates are available when creating notes in this folder.
        </p>
        {templates.data?.templates.length ? (
          <div className="mt-4 space-y-2 rounded-lg border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-2">
            {templates.data.templates.map((template) => (
              <label
                key={template.id}
                className="flex cursor-pointer items-start gap-3 rounded-md p-3 hover:bg-[var(--notes-hover)]"
              >
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={selectedIds.has(template.id)}
                  disabled={saveTemplates.isPending || refreshingAssignments}
                  onChange={(event) =>
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(template.id);
                      else next.delete(template.id);
                      return next;
                    })
                  }
                />
                <span>
                  <span className="block font-medium">{template.title}</span>
                  <span className="notes-muted mt-1 block text-xs">Reusable template</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <EmptyState title="No templates yet">
            <p>Create templates before assigning them to folders.</p>
            <Button className="mt-4" onClick={() => nav({ to: '/templates' })}>
              Create templates
            </Button>
          </EmptyState>
        )}
        <div className="mt-4 flex gap-2">
          <Button
            onClick={() => saveTemplates.mutate()}
            disabled={
              saveTemplates.isPending || refreshingAssignments || !membershipBase || !templates.data?.templates.length
            }
          >
            Save template settings
          </Button>
          <Button
            variant="secondary"
            disabled={saveTemplates.isPending || refreshingAssignments}
            onClick={async () => {
              setRefreshingAssignments(true);
              try {
                const latest = await memberships.refetch();
                if (latest.error) throw latest.error;
                if (latest.data) setMembershipBase(latest.data);
                setAssignmentMessage('Assignments refreshed; your selection is preserved. Review before saving.');
              } catch (error) {
                setAssignmentMessage(`${(error as Error).message}. Selection preserved.`);
              } finally {
                setRefreshingAssignments(false);
              }
            }}
          >
            Refresh assignments
          </Button>
          {saveTemplates.isSuccess ? (
            <span className="self-center text-[var(--notes-muted)] text-sm">Saved</span>
          ) : null}
        </div>
      </div>

      {assignmentMessage || memberships.error ? (
        <p role="status" className="notes-muted text-sm">
          {assignmentMessage || 'Assignments could not load. Refresh assignments to retry.'}
        </p>
      ) : null}

      <div className="rounded-lg border border-[var(--notes-button-destructive-border)] bg-[var(--notes-button-destructive-bg)] p-4">
        <h3 className="font-semibold text-[var(--notes-button-destructive-text)]">Danger zone</h3>
        <p className="mt-1 text-[var(--notes-button-destructive-text)] text-sm">
          Move this folder, its subfolders, and their notes to Trash so they can be restored later.
        </p>
        <div className="mt-4">
          <DeleteConfirmDialog
            label="folder"
            heading="Move folder to Trash?"
            warning="This folder, its subfolders, and their notes will move to Trash. Public share links will be revoked."
            actionLabel="Move to Trash"
            requiresTypedConfirmation={false}
            onConfirm={() => remove.mutateAsync()}
          />
        </div>
      </div>

      <RenameFolderDialog folder={folder} open={renameOpen} onOpenChange={setRenameOpen} />
    </section>
  );
}

export const folderSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/folders/$folderId/settings',
  component: FolderSettingsView,
});
