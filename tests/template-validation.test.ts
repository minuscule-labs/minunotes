import { describe, expect, it } from 'vitest';
import { normalizeTagInput } from '../src/shared/tags';
import { parseTemplateCreation, renderTemplate, templateTags, templateValues } from '../src/shared/templates';

const input = {
  folderId: 'f',
  templateId: 't',
  snapshot: 'token',
  schemaId: null,
  schemaRevision: 0,
  title: 'Final',
  tags: [],
  values: {},
  requestId: 'r',
  variables: { date: 'frozen date', time: 'frozen time', datetime: 'frozen datetime' },
};
describe('reviewed template contracts', () => {
  it('strict keys, required complete values, bounds and unsafe keys', () => {
    expect(parseTemplateCreation(input)).toEqual(input);
    for (const patch of [
      { body: 'no' },
      { requestId: '' },
      { requestId: '\0invalid' },
      { title: 'x'.repeat(1001) },
      { variables: { ...input.variables, date: 'x'.repeat(81) } },
      { values: JSON.parse('{"__proto__":"bad"}') },
      { tags: Array(51).fill('a') },
      { schemaRevision: -1 },
      { values: undefined },
    ])
      expect(() => parseTemplateCreation({ ...input, ...patch })).toThrow();
  });
  it('rejects lossful normalization without altering legacy behavior', () => {
    expect(templateTags(['# Hello World', 'bug'])).toEqual(['hello-world', 'bug']);
    for (const tags of [['123'], ['#a', 'A'], ['x'.repeat(81)]]) expect(() => templateTags(tags)).toThrow();
    expect(normalizeTagInput(['123', '#a', 'A'])).toEqual([{ name: 'a', normalizedName: 'a' }]);
  });
  it('renders frozen four variables literally and leaves unknown variables alone', () => {
    expect(renderTemplate('{{title}} {{date}} {{time}} {{datetime}} {{unknown}}', '$&', input.variables)).toBe(
      '$& frozen date frozen time frozen datetime {{unknown}}'
    );
  });
  it('uses stable IDs, rejects foreign/archived values and invalid dates, clears explicitly', () => {
    const schema = {
      schemaId: 's',
      revision: 1,
      definitions: [
        { id: 'date', label: 'Due', type: 'date' as const, archived: false, options: [] },
        { id: 'text', label: 'Text', type: 'text' as const, archived: false, options: [] },
      ],
    };
    expect(templateValues({ date: '2028-02-29', text: '' }, schema)).toEqual({ date: '2028-02-29' });
    expect(templateValues({ date: null }, schema)).toEqual({});
    expect(() => templateValues({ date: '2027-02-29' }, schema)).toThrow();
    expect(() => templateValues({ foreign: 'value' }, schema)).toThrow();
  });
});
