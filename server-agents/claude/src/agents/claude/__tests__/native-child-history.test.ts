import { afterEach, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentIntegrationError, type AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { claudeChildRef, loadClaudeChildHistory, parseClaudeChildRef } from '../native-child-history.js';
import { convertClaudeChildContent } from '../native-child-content.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

function entry(uuid: string, parentUuid: string | null, text: string, type = 'assistant') {
  return { uuid, parentUuid, type, sessionId: 'root-a', agentId: 'child-a', timestamp,
    message: { role: type, content: [{ type: 'text', text }] } };
}

async function fixture(entries: readonly unknown[] = []) {
  const base = path.join(os.homedir(), 'tmp');
  await fs.mkdir(base, { recursive: true });
  const configHomeDir = await fs.mkdtemp(path.join(base, 'claude-child-history-'));
  directories.push(configHomeDir);
  const project = path.join(configHomeDir, 'projects', 'synthetic-project');
  const children = path.join(project, 'root-a', 'subagents');
  await fs.mkdir(children, { recursive: true });
  const rootNativePath = path.join(project, 'root-a.jsonl');
  await fs.writeFile(rootNativePath, JSON.stringify({ sessionId: 'root-a' }) + '\n');
  const source = path.join(children, 'agent-child-a.jsonl');
  await fs.writeFile(source, entries.map(value => JSON.stringify(value) + '\n').join(''));
  return { source, children, child: claudeChildRef({ configHomeDir, rootNativePath, rootSessionId: 'root-a', agentId: 'child-a' }) };
}

async function collect(child: ReturnType<typeof claudeChildRef>, assertCurrent = () => {}) {
  const rows: AgentImportedTranscriptRow[] = [];
  for await (const batch of loadClaudeChildHistory({ child, signal: new AbortController().signal }, assertCurrent)) rows.push(...batch);
  return rows;
}

test('child conversion keeps actual input, tool results, thinking, and literal Garcon markup', () => {
  const rows = convertClaudeChildContent({ type: 'user', uuid: 'input-a', message: { content: [
    { type: 'text', text: '<system-reminder>Child kickoff</system-reminder>' },
    { type: 'tool_result', tool_use_id: 'tool-a', content: 'Synthetic result' },
  ] } }, timestamp);
  expect(rows.map(row => row.message.type)).toEqual(['user-message', 'tool-result']);
  expect(rows[0]?.message).toMatchObject({ content: '<system-reminder>Child kickoff</system-reminder>' });
  expect(rows[0]?.message).toMatchObject({ metadata: undefined });
  expect(rows[0]?.providerMeta).toEqual({ entryId: 'input-a', withinSourceOrdinal: 0 });
  expect(convertClaudeChildContent({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Synthetic thought' },
    { type: 'text', text: '<garcon-get-chat-id />' },
    { type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: '/synthetic/file' } },
  ] } }, timestamp).map(row => row.message.type)).toEqual(['thinking', 'assistant-message', 'read-tool-use']);
});

test('uses the last physical leaf and latest UUID copy through non-message chain links', async () => {
  const f = await fixture([
    entry('input', null, 'Inherited context', 'user'),
    entry('abandoned', 'input', 'Abandoned branch'),
    entry('input', null, 'Actual kickoff', 'user'),
    { type: 'progress', uuid: 'progress', parentUuid: 'input' },
    { type: 'attachment', uuid: 'attachment', parentUuid: 'progress' },
    { type: 'system', uuid: 'system', parentUuid: 'attachment' },
    { ...entry('leaf', 'system', 'Final answer'), timestamp: '2025-01-01T00:00:00.000Z' },
  ]);
  expect((await collect(f.child)).map(row => 'content' in row.message ? row.message.content : null)).toEqual(['Actual kickoff', 'Final answer']);
});

test('preserves native child branch selection at a compaction boundary', async () => {
  const f = await fixture([
    entry('input', null, 'Pre-compaction input', 'user'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'input' },
    entry('summary', 'boundary', 'Retained summary', 'user'),
    entry('leaf', 'summary', 'Retained answer'),
  ]);
  expect((await collect(f.child)).map(row => 'content' in row.message ? row.message.content : null))
    .toEqual(['Retained summary', 'Retained answer']);
});

test.each(['system', 'progress', 'attachment', 'user'])('rejects an assistant UUID reused by a %s record', async type => {
  const f = await fixture([
    entry('leaf', null, 'Retained answer'),
    { ...entry('leaf', null, 'Conflicting record', type) },
  ]);
  const failure = await collect(f.child).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('allows a same-kind assistant revision without losing its conversation chain', async () => {
  const f = await fixture([
    entry('input', null, 'Kickoff', 'user'),
    entry('leaf', 'input', 'Initial answer'),
    entry('leaf', 'input', 'Revised answer'),
  ]);
  expect((await collect(f.child)).map(row => 'content' in row.message ? row.message.content : null))
    .toEqual(['Kickoff', 'Revised answer']);
});

test.each(['user', 'assistant'])('rejects contradictory roles in a selected %s record', async type => {
  const f = await fixture([{ ...entry('leaf', null, 'Contradictory content', type),
    message: { role: type === 'user' ? 'assistant' : 'user', content: [{ type: 'text', text: 'Contradictory content' }] },
  }]);
  const failure = await collect(f.child).then(() => null, error => error);
  expect(failure).toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test.each(['missing-parent', 'cycle'])('refuses an incomplete %s chain rather than replacing history with a suffix', async kind => {
  const f = await fixture([entry('leaf', kind === 'cycle' ? 'leaf' : 'absent', 'Incomplete answer')]);
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test.each([{ uuid: '' }, { parentUuid: false }, { parentUuid: '' }, { parentUuid: 42 }])(
  'rejects malformed chain identities rather than importing an empty view or suffix: %j', async malformed => {
    const f = await fixture([entry('input', null, 'Kickoff', 'user'), { ...entry('leaf', 'input', 'Answer'), ...malformed }]);
    await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  },
);

test('looks up only the exact child below its recorded root, including workflow directories', async () => {
  const f = await fixture([entry('leaf', null, 'Nested source')]);
  const nested = path.join(f.children, 'workflows', 'run-a');
  await fs.mkdir(nested, { recursive: true });
  await fs.rename(f.source, path.join(nested, path.basename(f.source)));
  await fs.writeFile(path.join(f.children, 'agent-child-ab.jsonl'), JSON.stringify(entry('other', null, 'Other child')));
  expect((await collect(f.child)).map(row => 'content' in row.message ? row.message.content : null)).toEqual(['Nested source']);
  await fs.writeFile(f.source, '');
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('distinguishes a verified empty source from absent or malformed history', async () => {
  const f = await fixture();
  expect(await collect(f.child)).toEqual([]);
  await fs.writeFile(f.source, '{"type":"user",');
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  await fs.rm(f.source);
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('refuses mismatched namespaces, path escape, record identity, and symlinked sources', async () => {
  const f = await fixture([entry('leaf', null, 'Synthetic')]);
  expect(() => parseClaudeChildRef({ ...f.child, key: 'other' })).toThrow();
  expect(() => parseClaudeChildRef({ ...f.child, value: { ...f.child.value, agentId: '../child-a' } })).toThrow();
  await fs.writeFile(f.source, JSON.stringify({ ...entry('leaf', null, 'Wrong root'), sessionId: 'root-b' }));
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  const outside = path.join(f.children, 'outside.jsonl');
  await fs.rename(f.source, outside);
  await fs.symlink(outside, f.source);
  await expect(collect(f.child)).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('checks source stability after the last yielded page, without assuming consumer cutover', async () => {
  const f = await fixture([entry('leaf', null, 'Initial')]);
  const reader = loadClaudeChildHistory({ child: f.child, signal: new AbortController().signal }, () => {});
  expect((await reader.next()).value).toHaveLength(1);
  await fs.appendFile(f.source, JSON.stringify(entry('late', 'leaf', 'Late')) + '\n');
  await expect(reader.next()).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
});

test('fails closed when native ownership changes or the read is cancelled', async () => {
  const f = await fixture([entry('leaf', null, 'Initial')]);
  let busy = false;
  const guard = () => { if (busy) throw new AgentIntegrationError('SESSION_BUSY', 'Synthetic busy source', true); };
  const reader = loadClaudeChildHistory({ child: f.child, signal: new AbortController().signal }, guard);
  await reader.next();
  busy = true;
  await expect(reader.next()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
  const abort = new AbortController();
  abort.abort();
  await expect(loadClaudeChildHistory({ child: f.child, signal: abort.signal }, () => {}).next()).rejects.toMatchObject({ name: 'AbortError' });
});

test('bounds import pages and yields to unrelated I/O while traversing a long chain', async () => {
  const f = await fixture(Array.from({ length: 5000 }, (_, index) =>
    entry(`item-${index}`, index ? `item-${index - 1}` : null, `Synthetic ${index}`)));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  let count = 0;
  try {
    for await (const batch of loadClaudeChildHistory({ child: f.child, signal: new AbortController().signal }, () => {})) {
      expect(batch.length).toBeLessThanOrEqual(256);
      count += batch.length;
    }
  } finally { clearInterval(timer); }
  expect(count).toBe(5000);
  expect(ticks).toBeGreaterThan(0);
});
