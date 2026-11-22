import { expect, test } from 'bun:test';
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { rejectionOf } from '../../support/promise-assertions.js';
import { EventLoopSteps } from '../../../server-agents/common/src/shared/event-loop.js';
import { projectPiHistory, type PiSessionEntry } from '../../../server-agents/pi/src/agents/pi/session-projection.js';

const at = '2026-01-01T00:00:00.000Z';
function entry(id: string, parentId: string | null | undefined, fields: PiSessionEntry): PiSessionEntry {
  return { id, parentId, timestamp: at, ...fields };
}
function message(id: string, parentId: string | null | undefined, role: string, content: unknown) {
  return entry(id, parentId, { type: 'message', message: { role, content, timestamp: Date.parse(at) } });
}
function edit(id: string, parentId: string, targetId: string, replacement: unknown) {
  return entry(id, parentId, { type: 'context_edit', targetId, replacement });
}

const base = [
  message('user', null, 'user', 'synthetic request'),
  message('answer', 'user', 'assistant', [{ type: 'text', text: 'synthetic answer' }]),
  message('tool', 'answer', 'toolResult', [{ type: 'text', text: 'synthetic result' }]),
  entry('custom', 'tool', { type: 'custom_message', customType: 'synthetic', content: 'synthetic custom', display: true }),
];

const samples: Array<[string, PiSessionEntry[]]> = [
  ['empty', []],
  ['ordinary', base],
  ['malformed inactive branch', [entry('inactive', null, { type: 'message', message: null }), ...base]],
  ['sibling branches', [...base, message('sibling', 'user', 'assistant', []), message('leaf', 'custom', 'user', 'active')]],
  ['missing parent', [...base, message('orphan', 'missing', 'user', 'orphan')]],
  ['omitted parent', [...base, message('orphan', undefined, 'user', 'orphan')]],
  ['missing content', [message('user', null, 'user', null), message('answer', 'user', 'assistant', undefined)]],
  ['unchecked parent and edit keys', [
    { type: 'message', id: 1, parentId: null, message: { role: 'user', content: 'original' } },
    { type: 'message', id: true, parentId: 1, message: { role: 'assistant', content: [] } },
    { type: 'context_edit', id: 'edit', parentId: true, targetId: 1, replacement: { content: 'edited' } },
  ]],
  ['timestamp coercion is limited to synthesized messages', [
    entry('meta', null, { type: 'usage', timestamp: { toString: null } }),
    entry('summary', 'meta', { type: 'branch_summary', summary: 'summary', timestamp: [at] }),
  ]],
  ['unchecked native values', [
    message('user', null, 'user', 'request'),
    edit('edit', 'user', 'user', 'incomplete'),
    entry('raw', 'edit', { type: 'message', message: 'unknown message' }),
    entry('checkpoint', 'raw', { type: 'compaction', firstKeptEntryId: 'user', summary: 'summary',
      tokensBefore: 1, systemMessage: 'unknown checkpoint', timestamp: Date.parse(at) }),
  ]],
  ['edits and omissions', [...base,
    edit('replace', 'custom', 'user', { content: 'edited' }),
    edit('replace-again', 'replace', 'user', { content: 'latest edit' }),
    edit('omit', 'replace-again', 'answer', null),
    edit('replace-tool', 'omit', 'tool', { content: 'tool edit' }),
    edit('replace-custom', 'replace-tool', 'custom', { content: 'custom edit' }),
    edit('sibling-edit', 'custom', 'user', { content: 'wrong branch' }),
    entry('leaf', 'replace-custom', { type: 'usage', kind: 'cache_warm' }),
  ]],
  ...['answer', 'missing', 'compacted'].map((firstKeptEntryId): [string, PiSessionEntry[]] => [`compaction retaining ${firstKeptEntryId}`, [...base,
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
];

// The SDK consumes unchecked JSONL, including the deliberately malformed cases below.
function reference(entries: PiSessionEntry[]) {
  return buildSessionProjection(entries as PiSessionEntry[] & SessionEntry[]).entries;
}

test.each(samples)('matches the pinned SDK projection: %s', async (_name, entries) => {
  const expected = reference(entries);
  const actual = await projectPiHistory(entries, new EventLoopSteps('pi-projection-parity'));
  expect<readonly object[]>(actual).toEqual(expected);
  for (let index = 0; index < actual.length; index += 1) {
    expect<object>(actual[index].sourceEntry).toBe(expected[index].sourceEntry);
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
      expect(() => reference(entries)).toThrow();
      const failure = await rejectionOf(projectPiHistory(entries, new EventLoopSteps('pi-projection-malformed')));
      expect(failure).toBeInstanceOf(Error);
    });
  }
}
