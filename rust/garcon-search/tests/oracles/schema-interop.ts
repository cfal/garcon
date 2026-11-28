import { syntheticRows } from '../../../../server-agents/common/src/search/__tests__/fixtures.ts';
import type { HistoricalSearchMessageRow } from '../../../../server-agents/common/src/search/rows.ts';
import { openSearchReadDatabase } from '../../../../server-agents/common/src/search/schema.ts';
import type { IndexerEvent, IndexerRequest } from '../../../../server-agents/common/src/search/worker-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

type Build = {
  kind: 'build'; chatId: string; transcriptViewId: string; targetThrough: number;
  expectedAfterOrdinal: number; mode: 'replace' | 'append';
  advanceTo: number; rows: HistoricalSearchMessageRow[]; finish: boolean;
};
type Action = Build
  | { kind: 'fail'; chatId: string; transcriptViewId: string; errorCode: string }
  | { kind: 'delete'; chatId: string };

const row = (ordinal: number, body: string): HistoricalSearchMessageRow => ({
  ordinal, role: 'assistant', timestamp: '2026-01-01T00:00:00Z', body,
});
const build = (chatId: string, transcriptViewId: string, rows: HistoricalSearchMessageRow[],
  targetThrough: number, patch: Partial<Build> = {}): Build => ({
  kind: 'build', chatId, transcriptViewId, targetThrough, expectedAfterOrdinal: 0,
  mode: 'replace', advanceTo: targetThrough, rows, finish: true, ...patch,
});
const actions: Action[] = [
  build('alpha', 'old', [row(1, 'Quartz stale'), row(4, 'Quartz former tail')], 4),
  build('alpha', 'old', [row(6, 'Quartz appended')], 6, { mode: 'append', expectedAfterOrdinal: 4 }),
  build('alpha', 'new', [row(2, 'Quartz cafe caf\u00e9'), row(3, 'Quartz quartz #731')], 3),
  build('bravo', 'bravo-view', syntheticRows({ seed: 7, count: 9, startOrdinal: 1, marker: 'quartz' }), 9),
  build('sparse', 'sparse-view', [], 5, { advanceTo: 4, finish: false }),
  build('failure', 'failure-view', [row(1, 'Quartz retained but failed')], 3, { advanceTo: 1, finish: false }),
  { kind: 'fail', chatId: 'failure', transcriptViewId: 'failure-view', errorCode: 'SEARCH_SOURCE_FAILED' },
  build('retired', 'retired-view', [row(1, 'Quartz deleted')], 1),
  { kind: 'delete', chatId: 'retired' },
];

type Request = IndexerRequest extends infer R ? R extends IndexerRequest
  ? Omit<R, 'requestId' | 'lifecycleEpoch'> : never : never;

async function write(dbPath: string) {
  const worker = new Worker(new URL('../../../../server-agents/common/src/search/indexer-main.ts', import.meta.url));
  let nextId = 1;
  function send(request: Request, requestId = nextId++): Promise<IndexerEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out on ${request.type}`)), 15_000);
      worker.onmessage = ({ data }: MessageEvent<IndexerEvent>) => {
        if (data.requestId !== requestId || data.lifecycleEpoch !== 'fixture-epoch'
          || data.type === 'delete-progress') return;
        clearTimeout(timer);
        if (data.type === 'error') reject(new Error(data.code));
        else resolve(data);
      };
      worker.onerror = error => { clearTimeout(timer); reject(error); };
      worker.postMessage({ ...request, requestId, lifecycleEpoch: 'fixture-epoch' });
    });
  }
  try {
    const opened = await send({ type: 'open', dbPath });
    if (opened.type !== 'opened' || !opened.recreated) throw new Error('Expected a fresh search index');
    for (const action of actions) {
      if (action.kind === 'delete') {
        await send({ type: 'delete-chat', chatId: action.chatId });
      } else if (action.kind === 'fail') {
        const { chatId, transcriptViewId, errorCode } = action;
        await send({ type: 'mark-failed', chatId, transcriptViewId, errorCode });
      } else {
        const requestId = nextId++;
        const { chatId, transcriptViewId, expectedAfterOrdinal, targetThrough, mode } = action;
        const accepted = await send({ type: 'sync-begin', chatId, transcriptViewId, expectedAfterOrdinal, targetThrough, mode }, requestId);
        if (accepted.type !== 'sync-accepted' || accepted.current) throw new Error('Expected to build');
        let remaining = accepted.staleRows;
        while (remaining) {
          const event = await send({ type: 'sync-cleanup' }, requestId);
          if (event.type !== 'cleanup-progress') throw new Error('Expected cleanup progress');
          remaining = event.remaining;
        }
        await send({ type: 'sync-rows', rows: action.rows, frameIndex: 0, advanceTo: action.advanceTo }, requestId);
        if (action.finish) await send({ type: 'sync-finish' }, requestId);
      }
    }
    const checkpoint = await send({ type: 'checkpoint' });
    if (checkpoint.type !== 'checkpoint-complete' || checkpoint.busy !== 0) throw new Error('Checkpoint did not settle');
    const closed = await send({ type: 'close' });
    if (closed.type !== 'closed') throw new Error('Writer did not close');
  } finally {
    worker.terminate();
  }
}

function inspect(dbPath: string) {
  const db = openSearchReadDatabase(dbPath);
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fixture_vocab USING fts5vocab(main, search_chunks_fts, row)');
    return {
      version: db.query('PRAGMA user_version').values()[0]![0],
      vacuum: db.query('PRAGMA auto_vacuum').values()[0]![0],
      objects: db.query("SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").values(),
      shadows: db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND type='shadow' ORDER BY name").values(),
      config: db.query('SELECT k, v FROM search_chunks_fts_config ORDER BY k').values(),
      states: db.query('SELECT chat_id, transcript_view_id, status, indexed_through, target_through, last_error_code FROM search_chat_state ORDER BY chat_id').values(),
      rows: db.query('SELECT id, chat_id, transcript_view_id, ordinal, role, timestamp, body FROM search_chunks ORDER BY id').values(),
      vocab: db.query('SELECT term, doc, cnt FROM temp.fixture_vocab ORDER BY term').values(),
      rank: db.query("SELECT rowid, rank FROM search_chunks_fts WHERE search_chunks_fts MATCH 'quartz' ORDER BY rank, rowid").values(),
    };
  } finally {
    db.close();
  }
}

const [mode, path] = process.argv.slice(2);
if (mode === 'actions') console.log(JSON.stringify(actions));
else if (mode === 'inspect' && path) console.log(JSON.stringify(inspect(path)));
else if (mode === 'write' && path) {
  await write(path);
  console.log(JSON.stringify(inspect(path)));
} else throw new Error('Expected actions, inspect, or write');
