import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import type { PropertySchema } from '../../shared/properties';
import { type TemplateDefaults, templateTags, templateValues } from '../../shared/templates';
import { ApiError, api } from '../lib/api';
import { Button } from './ui/button';

type Values = Record<string, string | null>;
export function TemplateValueFields({
  schema,
  values,
  disabled,
  onChange,
}: {
  schema: PropertySchema;
  values: Values;
  disabled: boolean;
  onChange: (id: string, value: string | null) => void;
}) {
  const controlPrefix = useId();
  const active = schema.definitions.filter((d) => !d.archived);
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {active.map((field) => {
        const controlId = `${controlPrefix}-${field.id}`;
        const value = values[field.id] ?? '';
        const retired = field.type === 'select' && value && !field.options.some((o) => o.id === value && !o.archived);
        return (
          <div key={field.id}>
            <label className="block space-y-1" htmlFor={controlId}>
              <span className="notes-muted text-xs">{field.label}</span>
              {field.type === 'select' ? (
                <select
                  id={controlId}
                  aria-label={field.label}
                  className="notes-input w-full rounded px-2 py-1"
                  value={value}
                  disabled={disabled}
                  onChange={(e) => onChange(field.id, e.target.value || null)}
                >
                  <option value="">Not set</option>
                  {retired ? (
                    <option value={value} disabled>
                      Removed choice — clear or replace
                    </option>
                  ) : null}
                  {field.options
                    .filter((o) => !o.archived)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  id={controlId}
                  aria-label={field.label}
                  className="notes-input w-full rounded px-2 py-1"
                  type={field.type === 'date' ? 'date' : 'text'}
                  maxLength={1000}
                  value={value}
                  disabled={disabled}
                  onChange={(e) => onChange(field.id, e.target.value || null)}
                />
              )}
            </label>
            <Button
              variant="secondary"
              aria-label={`Clear ${field.label}`}
              disabled={disabled || !value}
              onClick={() => onChange(field.id, null)}
            >
              Clear
            </Button>
            {retired ? (
              <p role="status" className="notes-muted text-xs">
                This choice was removed. Your value is preserved.
              </p>
            ) : null}
          </div>
        );
      })}
      {Object.keys(values)
        .filter((id) => values[id] !== null && !active.some((d) => d.id === id))
        .map((id) => (
          <div key={id} role="status" className="notes-muted text-xs">
            Removed field: {id} · {values[id]}{' '}
            <Button variant="secondary" disabled={disabled} onClick={() => onChange(id, null)}>
              Clear removed field
            </Button>
          </div>
        ))}
    </div>
  );
}
// Explicit clears of removed fields cannot be sent as unknown IDs to the server.
export function finalTemplateValues(values: Values): Values {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== ''));
}
export function TemplateDefaultsPanel({ templateId }: { templateId: string }) {
  const qc = useQueryClient(),
    key = ['template-defaults', templateId];
  const query = useQuery({ queryKey: key, queryFn: () => api.templateDefaults(templateId), retry: false });
  const [base, setBase] = useState<TemplateDefaults | null>(null),
    [tags, setTags] = useState(''),
    [selectedId, setSelectedId] = useState('');
  const [propertyBase, setPropertyBase] = useState<{
    assignment: TemplateDefaults['assignments'][number];
    schema: PropertySchema;
  } | null>(null);
  const [values, setValues] = useState<Values>({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [revoked, setRevoked] = useState(false);
  const lock = useRef(false);
  const schema = useQuery({
    queryKey: ['template-default-schema', templateId, selectedId],
    queryFn: () => api.folderProperties(selectedId),
    enabled: Boolean(selectedId) && !revoked,
    retry: false,
  });
  const unavailable =
    revoked || [query.error, schema.error].some((e) => e instanceof ApiError && [401, 403, 404].includes(e.status));
  useEffect(() => {
    if (unavailable) {
      setRevoked(true);
      setBase(null);
      setPropertyBase(null);
      setValues({});
      setTags('');
      qc.removeQueries({ queryKey: key });
    }
  }, [unavailable, qc, templateId]);
  useEffect(() => {
    if (query.data && !base && !unavailable) {
      setBase(query.data);
      setTags(query.data.tags.join(', '));
    }
  }, [query.data, base, unavailable]);
  useEffect(() => {
    const assignment = base?.assignments.find((a) => a.folderId === selectedId);
    if (!propertyBase && assignment && schema.data && !unavailable) {
      setPropertyBase({ assignment, schema: schema.data });
      setValues(assignment.values);
    }
  }, [base, selectedId, schema.data, propertyBase, unavailable]);
  const operation = async (run: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    try {
      await run();
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setRevoked(true);
      else setMessage(`${(error as Error).message}. Your defaults draft is preserved.`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (unavailable) return <p className="notes-muted px-3 py-2 text-xs">Template defaults unavailable</p>;
  if (!base)
    return (
      <div className="px-3 py-2 text-xs">
        {query.error ? <Button onClick={() => void query.refetch()}>Retry defaults</Button> : 'Loading default tags…'}
      </div>
    );
  return (
    <details className="max-h-[45dvh] overflow-y-auto border-[var(--notes-border)] border-b bg-[var(--notes-panel)] px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Template defaults</summary>
      <p className="notes-muted mt-2 text-xs">
        Defaults apply only to new instances. Saving them never saves the template body.
      </p>
      <label className="mt-3 block space-y-1">
        <span>Default tags</span>
        <input
          aria-label="Default tags"
          className="notes-input w-full rounded px-2 py-1"
          value={tags}
          disabled={busy}
          onChange={(e) => setTags(e.target.value)}
          placeholder="feature, backlog"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            void operation(async () => {
              const result = await api.saveTemplateTags(templateId, {
                expectedRevision: base.revision,
                tags: templateTags(tags.trim() ? tags.split(',') : []),
              });
              setBase((current) => (current ? { ...current, ...result } : current));
              setMessage('Default tags saved');
            })
          }
        >
          Save default tags
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setTags('')}>
          Clear default tags
        </Button>
      </div>
      <label className="mt-4 block space-y-1">
        <span>Assigned destination</span>
        <select
          aria-label="Assigned destination"
          className="notes-input w-full rounded px-2 py-1"
          value={selectedId}
          disabled={busy}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setPropertyBase(null);
            setValues({});
            setMessage('');
          }}
        >
          <option value="">Choose destination</option>
          {base.assignments.map((a) => (
            <option key={a.id} value={a.folderId}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      {selectedId ? (
        <div className="mt-3">
          <h3 className="font-medium">Default properties</h3>
          {propertyBase ? (
            <>
              <TemplateValueFields
                schema={propertyBase.schema}
                values={values}
                disabled={busy}
                onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void operation(async () => {
                      const final = finalTemplateValues(values);
                      templateValues(final, propertyBase.schema);
                      const a = propertyBase.assignment,
                        s = propertyBase.schema;
                      const result = await api.saveAssignmentDefaults(templateId, selectedId, {
                        assignmentId: a.id,
                        expectedRevision: a.revision,
                        schemaId: s.schemaId,
                        schemaRevision: s.revision,
                        values: final,
                      });
                      setPropertyBase({ ...propertyBase, assignment: { ...a, ...result } });
                      setBase((current) =>
                        current
                          ? {
                              ...current,
                              assignments: current.assignments.map((row) =>
                                row.id === a.id ? { ...row, ...result } : row
                              ),
                            }
                          : current
                      );
                      setMessage('Default properties saved');
                    })
                  }
                >
                  Save default properties
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setValues({})}>
                  Clear default properties
                </Button>
              </div>
            </>
          ) : (
            <p className="notes-muted text-xs">Loading destination schema…</p>
          )}
        </div>
      ) : null}
      <Button
        variant="secondary"
        className="mt-3"
        disabled={busy}
        onClick={() =>
          void operation(async () => {
            // Only this explicit authorized read advances tokens; entered values are never silently discarded.
            const latest = await api.templateDefaults(templateId);
            if (selectedId) {
              const assignment = latest.assignments.find((a) => a.folderId === selectedId);
              if (!assignment) throw new Error('Assignment removed; choose a destination again');
              const latestSchema = await api.folderProperties(selectedId);
              setPropertyBase({ assignment, schema: latestSchema });
              try {
                templateValues(finalTemplateValues(values), latestSchema);
              } catch {
                setBase(latest);
                setMessage(
                  'A field or choice was removed. Your defaults are preserved; clear or replace it before saving.'
                );
                return;
              }
            }
            setBase(latest);
            setMessage('Defaults refreshed. Your draft is preserved; review before saving.');
          })
        }
      >
        Refresh defaults for review
      </Button>
      {message ? (
        <p role="status" className="notes-muted mt-2 text-xs">
          {message}
        </p>
      ) : null}
    </details>
  );
}
