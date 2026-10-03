import { expect, test } from 'bun:test';
import { buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { projectPiHistory } from '../session-projection.js';

const at = '2026-01-01T00:00:00.000Z';
function entry(id, parentId, fields) {
  return { id, parentId, timestamp: at, ...fields };
}
function message(id, parentId, role, content) {
  return entry(id, parentId, { type: 'message', message: { role, content, timestamp: Date.parse(at) } });
}
function edit(id, parentId, targetId, replacement) {
  return entry(id, parentId, { type: 'context_edit', targetId, replacement });
}

const base = [
  message('user', null, 'user', 'synthetic request'),
  message('answer', 'user', 'assistant', [{ type: 'text', text: 'synthetic answer' }]),
  message('tool', 'answer', 'toolResult', [{ type: 'text', text: 'synthetic result' }]),
  entry('custom', 'tool', { type: 'custom_message', customType: 'synthetic', content: 'synthetic custom', display: true }),
];

test.each([
  ['empty', []],
  ['ordinary', base],
  ['malformed inactive branch', [entry('inactive', null, { type: 'message', message: null }), ...base]],
  ['sibling branches', [...base, message('sibling', 'user', 'assistant', []), message('leaf', 'custom', 'user', 'active')]],
  ['missing parent', [...base, message('orphan', 'missing', 'user', 'orphan')]],
  ['omitted parent', [...base, message('orphan', undefined, 'user', 'orphan')]],
  ['missing content', [message('user', null, 'user', null), message('answer', 'user', 'assistant', undefined)]],
  ['edits and omissions', [...base,
    edit('replace', 'custom', 'user', { content: 'edited' }),
    edit('replace-again', 'replace', 'user', { content: 'latest edit' }),
    edit('omit', 'replace-again', 'answer', null),
    edit('replace-tool', 'omit', 'tool', { content: 'tool edit' }),
    edit('replace-custom', 'replace-tool', 'custom', { content: 'custom edit' }),
    edit('sibling-edit', 'custom', 'user', { content: 'wrong branch' }),
    entry('leaf', 'replace-custom', { type: 'usage', kind: 'cache_warm' }),
  ]],
  ...['answer', 'missing', 'compacted'].map((firstKeptEntryId) => [`compaction retaining ${firstKeptEntryId}`, [...base,
    entry('compacted', 'custom', { type: 'compaction', firstKeptEntryId, summary: 'synthetic summary', tokensBefore: 100 }),
    message('next', 'compacted', 'user', 'after compaction'),
  ]]),
  ['nested compaction and system checkpoint', [...base,
    entry('first', 'custom', { type: 'compaction', firstKeptEntryId: 'answer', summary: 'first', tokensBefore: 100 }),
    message('system', 'first', 'system', 'old system'),
    message('kept', 'system', 'assistant', []),
    edit('before', 'kept', 'kept', { content: 'edited retained answer' }),
    entry('second', 'before', { type: 'compaction', firstKeptEntryId: 'first', summary: 'second', tokensBefore: 200,
      systemMessage: { role: 'system', content: 'current system', timestamp: Date.parse(at) } }),
    edit('after', 'second', 'answer', { content: 'outside retained range' }),
    message('new-system', 'after', 'system', 'after compaction system'),
  ]],
])('matches the pinned SDK projection: %s', async (_name, entries) => {
  const expected = buildSessionProjection(entries).entries;
  const actual = await projectPiHistory(entries, new EventLoopSteps('pi-projection-parity'));
  expect(actual).toEqual(expected);
  for (let index = 0; index < actual.length; index += 1) {
    expect(actual[index].sourceEntry).toBe(expected[index].sourceEntry);
  }
});

for (const container of [null, undefined]) {
  for (const firstKeptEntryId of ['kept', 'missing']) {
    test(`rejects a ${String(container)} message container before compaction retaining ${firstKeptEntryId}`, async () => {
      const entries = [
        entry('malformed', null, { type: 'message', message: container }),
        message('kept', 'malformed', 'user', 'synthetic retained request'),
        entry('compaction', 'kept', { type: 'compaction', firstKeptEntryId, summary: 'summary', tokensBefore: 100 }),
      ];
      expect(() => buildSessionProjection(entries)).toThrow();
      await expect(projectPiHistory(entries, new EventLoopSteps('pi-projection-malformed'))).rejects.toThrow();
    });
  }
}
