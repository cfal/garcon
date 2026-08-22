import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DirectSessionStore,
  type DirectResponsesCheckpointV1,
} from '../session-store.ts';

const OWNER_ID = 'direct-test';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TIMES = [
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:01.000Z',
  '2026-01-01T00:00:02.000Z',
  '2026-01-01T00:00:03.000Z',
];
const CHECKPOINT: DirectResponsesCheckpointV1 = {
  kind: 'openai-response',
  responseId: 'resp_1',
  endpointId: 'endpoint-a',
  endpointFingerprint: 'a'.repeat(64),
  model: 'model-a',
};

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(options: {
  readonly onDirectorySync?: (directory: string) => void | Promise<void>;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-direct-session-store-'));
  createdDirectories.push(root);
  const storageRoot = path.join(root, 'agent-data', OWNER_ID);
  let timeIndex = 0;
  const store = new DirectSessionStore({
    host: {
      agentId: OWNER_ID,
      storage: {
        rootDirectory: storageRoot,
        async directory(namespace) {
          const directory = path.join(storageRoot, namespace);
          await mkdir(directory, { recursive: true });
          return directory;
        },
        async claimLegacyWorkspaceDirectory() {
          return { moved: 0, skipped: 0 };
        },
      },
    },
    now: () => TIMES[timeIndex++] ?? TIMES.at(-1)!,
    async syncDirectory(directory) {
      await options.onDirectorySync?.(directory);
    },
  });
  const file = path.join(storageRoot, 'direct-sessions-v1', `${SESSION_ID}.jsonl`);
  return { root, store, file };
}

async function create(store: DirectSessionStore) {
  return store.create({
    sessionId: SESSION_ID,
    runId: 'run-1',
    content: 'first request',
    attachments: [{
      kind: 'image',
      data: 'data:image/png;base64,YWJj',
      name: 'screen.png',
      mimeType: 'image/png',
    }],
  });
}

function lines(raw: string): unknown[] {
  return raw.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown);
}

describe('DirectSessionStore', () => {
  test('creates a mode-0600 session durably before publishing its path', async () => {
    let syncedContents: string | null = null;
    const { store, file } = await fixture({
      async onDirectorySync(directory) {
        syncedContents = await readFile(path.join(directory, `${SESSION_ID}.jsonl`), 'utf8');
      },
    });

    const snapshot = await create(store);
    const mode = (await lstat(file)).mode & 0o777;

    expect(mode).toBe(0o600);
    expect(snapshot.path).toBe(file);
    expect(snapshot.header).toEqual({
      type: 'session',
      schemaVersion: 1,
      ownerId: OWNER_ID,
      sessionId: SESSION_ID,
      createdAt: TIMES[0],
    });
    expect(snapshot.records).toEqual([{
      type: 'user',
      at: TIMES[0],
      runId: 'run-1',
      content: 'first request',
      attachments: [{
        kind: 'image',
        data: 'data:image/png;base64,YWJj',
        name: 'screen.png',
        mimeType: 'image/png',
      }],
    }]);
    expect(await syncedContents).toBe(await readFile(file, 'utf8'));
  });

  test('round-trips append-only turns and an atomic Responses checkpoint', async () => {
    const { store } = await fixture();
    await create(store);
    await store.appendAssistant({
      sessionId: SESSION_ID,
      runId: 'run-1',
      content: 'first response',
      checkpoint: CHECKPOINT,
    });
    await store.appendUser({
      sessionId: SESSION_ID,
      runId: 'run-2',
      content: '',
      attachments: [{
        kind: 'image',
        data: 'data:application/pdf;base64,YWJj',
        name: null,
        mimeType: 'application/pdf',
      }],
    });
    await store.appendAssistant({
      sessionId: SESSION_ID,
      runId: 'run-2',
      content: 'second response',
    });

    await expect(store.load(SESSION_ID)).resolves.toMatchObject({
      records: [
        { type: 'user', runId: 'run-1', content: 'first request' },
        { type: 'assistant', runId: 'run-1', content: 'first response', checkpoint: CHECKPOINT },
        { type: 'user', runId: 'run-2', content: '' },
        { type: 'assistant', runId: 'run-2', content: 'second response', checkpoint: null },
      ],
    });
  });

  test('retains a valid unterminated record and separates the next append', async () => {
    const { store, file } = await fixture();
    await create(store);
    const original = await readFile(file);
    await truncate(file, original.byteLength - 1);

    await expect(store.load(SESSION_ID)).resolves.toMatchObject({
      records: [{ type: 'user', content: 'first request' }],
    });
    await store.appendAssistant({
      sessionId: SESSION_ID,
      runId: 'run-1',
      content: 'response',
    });

    const raw = await readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBeTrue();
    expect(lines(raw)).toHaveLength(3);
  });

  test('ignores an invalid incomplete tail until an append truncates and fsyncs it', async () => {
    const { store, file } = await fixture();
    await create(store);
    await appendFile(file, '{"type":"assistant","runId":"run-1"');
    const damaged = await readFile(file, 'utf8');

    await expect(store.load(SESSION_ID)).resolves.toMatchObject({
      records: [{ type: 'user', runId: 'run-1' }],
    });
    expect(await readFile(file, 'utf8')).toBe(damaged);

    await store.appendAssistant({
      sessionId: SESSION_ID,
      runId: 'run-1',
      content: 'recovered response',
    });
    const repaired = await readFile(file, 'utf8');
    expect(repaired).not.toContain('{"type":"assistant","runId":"run-1"\n');
    expect(lines(repaired).at(-1)).toMatchObject({ content: 'recovered response' });
  });

  test('fails closed on malformed complete or middle records without mutating the file', async () => {
    const { store, file } = await fixture();
    await create(store);
    const valid = lines(await readFile(file, 'utf8'));
    await appendFile(file, '{malformed}\n');
    const malformedFinal = await readFile(file);
    await expect(store.load(SESSION_ID)).rejects.toThrow('record 3 is malformed');
    await expect(store.appendUser({
      sessionId: SESSION_ID,
      runId: 'run-2',
      content: 'next',
      attachments: [],
    })).rejects.toThrow('record 3 is malformed');
    expect(await readFile(file)).toEqual(malformedFinal);

    await writeFile(file, `${JSON.stringify(valid[0])}\n{malformed}\n${JSON.stringify(valid[1])}\n`);
    const malformedMiddle = await readFile(file);
    await expect(store.load(SESSION_ID)).rejects.toThrow('record 2 is malformed');
    expect(await readFile(file)).toEqual(malformedMiddle);
  });

  test('rejects invalid record schemas, sequencing, Unicode, timestamps, and attachments', async () => {
    const { store, file } = await fixture();
    await create(store);
    const [header, user] = lines(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    const cases = [
      [{ ...header, extra: true }, user],
      [header, { ...user, at: 'yesterday' }],
      [header, { ...user, content: '\ud800' }],
      [header, { ...user, attachments: [{ kind: 'image', data: '', name: null, mimeType: 'image/png' }] }],
      [header, { type: 'assistant', at: TIMES[1], runId: 'run-1', content: 'orphan', checkpoint: null }],
      [header, user, { ...header }],
    ];

    for (const records of cases) {
      await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
      await expect(store.load(SESSION_ID)).rejects.toBeInstanceOf(TypeError);
    }
  });

  test('rejects native owner, schema, shape, and selected-session mismatches', async () => {
    const { store } = await fixture();
    expect(store.nativeReference(SESSION_ID)).toEqual({
      ownerId: OWNER_ID,
      schemaVersion: 1,
      value: { sessionId: SESSION_ID },
    });
    expect(() => store.sessionIdFromReference({
      ownerId: 'other',
      schemaVersion: 1,
      value: { sessionId: SESSION_ID },
    })).toThrow();
    expect(() => store.sessionIdFromReference({
      ownerId: OWNER_ID,
      schemaVersion: 2,
      value: { sessionId: SESSION_ID },
    })).toThrow();
    expect(() => store.sessionIdFromReference({
      ownerId: OWNER_ID,
      schemaVersion: 1,
      value: { sessionId: SESSION_ID, extra: true },
    })).toThrow();
    expect(() => store.sessionIdFromReference(
      store.nativeReference(SESSION_ID),
      SECOND_SESSION_ID,
    )).toThrow('does not match');
  });

  test('rejects missing, symlinked, and non-regular session files', async () => {
    const { root, store, file } = await fixture();
    await expect(store.load(SESSION_ID)).rejects.toMatchObject({ code: 'ENOENT' });

    const target = path.join(root, 'outside.jsonl');
    await writeFile(target, 'outside');
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(target, file);
    await expect(store.load(SESSION_ID)).rejects.toMatchObject({ code: 'ELOOP' });

    await rm(file);
    await mkdir(file);
    await expect(store.load(SESSION_ID)).rejects.toThrow('not a regular file');
  });

  test('deletes idempotently and syncs the containing directory only after removal', async () => {
    const syncs: string[] = [];
    const { store, file } = await fixture({
      onDirectorySync(directory) {
        syncs.push(directory);
      },
    });
    await create(store);
    await chmod(file, 0o600);
    syncs.length = 0;

    await store.delete(SESSION_ID);
    expect(syncs).toHaveLength(1);
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });

    await store.delete(SESSION_ID);
    expect(syncs).toHaveLength(1);
  });
});
