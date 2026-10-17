import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import {
  parseTemplateCreation,
  renderTemplate,
  type TemplateCreation,
  type TemplatePreview,
  type TemplateVariables,
  templateValues,
} from '../../shared/templates';
import { finalTemplateValues, TemplateValueFields } from '../components/template-defaults-panel';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ApiError, api } from '../lib/api';
import { rootRoute } from './__root';

function frozenTime(): TemplateVariables {
  const now = new Date(),
    date = now.toLocaleDateString(),
    time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return { date, time, datetime: `${date} ${time}` };
}
function NewFromTemplateView() {
  const { folderId } = newFromTemplateRoute.useParams(),
    nav = useNavigate(),
    qc = useQueryClient();
  const folder = useQuery({
    queryKey: ['folder-detail', folderId],
    queryFn: () => api.folderDetail(folderId),
    retry: false,
  });
  const role = folder.data?.access.role,
    eligible = role === 'owner' || role === 'editor';
  const templates = useQuery({
    queryKey: ['folder-templates', folderId],
    queryFn: () => api.folderTemplates(folderId),
    enabled: eligible,
    retry: false,
  });
  const [selectedId, setSelectedId] = useState(''),
    [review, setReview] = useState<TemplatePreview | null>(null),
    [variables, setVariables] = useState(frozenTime);
  const [title, setTitle] = useState(''),
    [tags, setTags] = useState(''),
    [values, setValues] = useState<Record<string, string | null>>({});
  const [frozen, setFrozen] = useState<TemplateCreation | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [needsReview, setNeedsReview] = useState(false),
    [revoked, setRevoked] = useState(false);
  const lock = useRef(false);
  const preview = useQuery({
    queryKey: ['assigned-template-preview', folderId, selectedId],
    queryFn: () => api.templatePreview(folderId, selectedId),
    enabled: eligible && Boolean(selectedId) && !revoked,
    retry: false,
  });
  const inaccessible =
    revoked ||
    [folder.error, templates.error, preview.error].some(
      (e) => e instanceof ApiError && [401, 403, 404].includes(e.status)
    );
  useEffect(() => {
    if (inaccessible) {
      setRevoked(true);
      setReview(null);
      setTags('');
      setValues({});
      setFrozen(null);
      qc.removeQueries({ queryKey: ['assigned-template-preview', folderId] });
    }
  }, [inaccessible, folderId, qc]);
  useEffect(() => {
    if (!selectedId && templates.data?.templates.length === 1) setSelectedId(templates.data.templates[0].id);
  }, [selectedId, templates.data]);
  useEffect(() => {
    if (preview.data && !review && preview.data.template.id === selectedId && !inaccessible) {
      setReview(preview.data);
      setTags(preview.data.tags.join(', '));
      setValues(preview.data.values);
      setVariables(frozenTime());
    }
  }, [preview.data, review, selectedId, inaccessible]);
  const submit = async () => {
    if (lock.current || !review || needsReview) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    let payload = frozen;
    try {
      if (!payload) {
        payload = parseTemplateCreation({
          folderId,
          templateId: selectedId,
          snapshot: review.snapshot,
          schemaId: review.schema.schemaId,
          schemaRevision: review.schema.revision,
          title: title.trim() || 'Untitled note',
          tags: tags.trim() ? tags.split(',') : [],
          values: finalTemplateValues(values),
          variables,
          requestId: crypto.randomUUID(),
        });
        templateValues(payload.values, review.schema);
        setFrozen(payload);
      }
      const result = await api.createFromTemplate(payload);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['notes', folderId] }),
        qc.invalidateQueries({ queryKey: ['board', folderId] }),
        qc.invalidateQueries({ queryKey: ['tags'] }),
      ]);
      setFrozen(null);
      void nav({ to: '/notes/$noteId', params: { noteId: result.note.id } });
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setRevoked(true);
        setFrozen(null);
      } else if (error instanceof ApiError && error.status < 500 && !/busy/i.test(error.message)) {
        setFrozen(null);
        setNeedsReview(error.status === 409);
        setMessage(
          `${error.message}. Your draft is preserved.${error.status === 409 ? ' Re-review before creating.' : ''}`
        );
      } else if (payload) {
        setMessage('Creation result is uncertain. Retry with the same frozen request; do not submit another note.');
      } else setMessage((error as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const rereview = async () => {
    if (lock.current || frozen) return;
    lock.current = true;
    setBusy(true);
    try {
      const latest = await api.templatePreview(folderId, selectedId);
      setReview(latest);
      setVariables(frozenTime());
      setNeedsReview(false);
      try {
        templateValues(finalTemplateValues(values), latest.schema);
        setMessage(
          'Latest template and schema loaded. Your draft is preserved; review the body and values before creating.'
        );
      } catch {
        setMessage('A field or choice was removed. Your values are preserved; clear or replace them before creating.');
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setRevoked(true);
      else setMessage(`${(error as Error).message}. Your draft is preserved.`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (folder.isLoading) return <p className="notes-muted text-sm">Loading templates…</p>;
  if (inaccessible || !folder.data || !eligible)
    return (
      <EmptyState title="Template creation unavailable">
        <Button onClick={() => void nav({ to: '/folders/$folderId', params: { folderId } })}>Back to folder</Button>
      </EmptyState>
    );
  const disabled = busy || Boolean(frozen);
  return (
    <section className="mx-auto w-full max-w-5xl">
      <p className="notes-muted text-sm">Creating in: {folder.data.folder.title}</p>
      <h2 className="mb-6 font-semibold text-xl">New note from template</h2>
      {templates.isLoading ? (
        <p>Loading assigned templates…</p>
      ) : templates.error ? (
        <Button onClick={() => void templates.refetch()}>Retry templates</Button>
      ) : templates.data?.templates.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="block space-y-1">
              <span>Note title</span>
              <input
                aria-label="Note title"
                className="notes-input w-full rounded px-3 py-2"
                placeholder="Untitled note"
                maxLength={1000}
                value={title}
                disabled={disabled}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <p className="notes-muted text-xs">Assigned templates</p>
            {templates.data.templates.map((t) => (
              <Button
                key={t.id}
                variant={selectedId === t.id ? 'base' : 'secondary'}
                disabled={disabled}
                onClick={() => {
                  setSelectedId(t.id);
                  setReview(null);
                  setNeedsReview(false);
                  setMessage('');
                }}
              >
                {t.title}
              </Button>
            ))}
            {review ? (
              <>
                <label className="block space-y-1">
                  <span>Final tags</span>
                  <input
                    aria-label="Final tags"
                    className="notes-input w-full rounded px-3 py-2"
                    value={tags}
                    disabled={disabled}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </label>
                <Button variant="secondary" disabled={disabled} onClick={() => setTags('')}>
                  Clear tags
                </Button>
                <h3 className="font-medium">Final properties</h3>
                <TemplateValueFields
                  schema={review.schema}
                  values={values}
                  disabled={disabled}
                  onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
                />
                <Button variant="secondary" disabled={disabled} onClick={() => setValues({})}>
                  Clear properties
                </Button>
              </>
            ) : (
              <p className="notes-muted text-xs">
                {preview.error ? 'Preview could not load. Re-review to retry.' : 'Loading preview…'}
              </p>
            )}
          </div>
          <div className="rounded border border-[var(--notes-border)] bg-[var(--notes-panel-muted)] p-3">
            <h3 className="mb-2 font-medium">Body preview</h3>
            <pre className="max-h-[30rem] overflow-auto whitespace-pre-wrap font-mono text-xs">
              {review
                ? renderTemplate(review.template.body, title.trim() || 'Untitled note', variables)
                : 'Select a template to preview it.'}
            </pre>
          </div>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <Button disabled={busy || !review || needsReview} onClick={() => void submit()}>
              {frozen ? 'Retry creation' : 'Create note'}
            </Button>
            <Button variant="secondary" disabled={disabled} onClick={() => void rereview()}>
              Re-review template
            </Button>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void nav({ to: '/folders/$folderId', params: { folderId } })}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState title="No templates assigned">
          <p>No assigned templates are available in this destination.</p>
          {role === 'owner' ? (
            <Button onClick={() => void nav({ to: '/folders/$folderId/settings', params: { folderId } })}>
              Manage folder templates
            </Button>
          ) : null}
        </EmptyState>
      )}
      {message ? (
        <p role="status" className="notes-muted mt-3 text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
export const newFromTemplateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/folders/$folderId/new-from-template',
  component: NewFromTemplateView,
});
