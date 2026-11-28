import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { PermissionNotActionableError } from '../../../server/controller/ledger/errors.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const chatId = 'producer-service';
const viewId = transcriptViewId('service-view');
const runId = 'synthetic-run';
const instance = 'synthetic-server';
const occurrence = '11111111-1111-4111-8111-111111111111';
const lateOccurrence = '22222222-2222-4222-8222-222222222222';
const at = '2026-11-28T09:00:00.000Z';
const store = new TranscriptLedgerStore(root, { now: () => at });
const synchronous: unknown[] = [];
const published: unknown[] = [];
const service = new TranscriptLedgerService(store, {
  now: () => at, serverInstanceId: instance,
  chatIdRequests: { request: (request) => {
    synchronous.push({ type: 'chat-id', runId: request.runId, ordinal: store.highWatermark(chatId).ordinal });
  } },
});

try {
  if (mode === 'write') {
    store.initializeCurrentView(chatId, { viewId, contentStartOrdinal: 1, rows: [] });
    const lease = service.openProducer(chatId, 'synthetic-owner');
    service.subscribeSessionCommitted((event) => {
      synchronous.push({ type: 'session', ordinal: event.row.ordinal });
    });
    service.subscribeRunEndedCommitted((_chatId, runId) => {
      synchronous.push({ type: 'run-ended', runId, ordinal: store.highWatermark(chatId).ordinal });
    });
    service.subscribePermissionActionabilityChanged((event) => {
      synchronous.push({ type: event.actionability, id: event.control.permissionOccurrenceId });
    });
    service.subscribe(event => {
      if (event.type === 'rows') {
        published.push({ type: event.type, ordinals: event.rows.map(row => row.ordinal) });
      } else if (event.type === 'permission') {
        published.push({ type: event.type, ordinal: event.row.ordinal, runId: event.runId });
      } else if (event.type === 'run-ended') {
        published.push({ type: event.type, ordinal: event.row.ordinal, runId: event.runId, finalResponse: event.finalResponse });
      } else if (event.type === 'session') {
        published.push({ type: event.type, ordinal: event.row.ordinal });
      } else throw new Error(`Unexpected event ${event.type}`);
    });
    const publishRequested = (permissionOccurrenceId: string) => lease.sink.publish({
      type: 'permission', runId,
      lifecycle: { kind: 'requested', permissionOccurrenceId,
        requestedTool: new BashToolUseMessage(at, 'synthetic-tool', 'true'),
        options: [{ id: 'allow', label: 'Allow' }],
      },
      decision: { permissionOccurrenceId, response: {
        executorId: 'local', instanceId: 'synthetic-executor', integrationId: 'synthetic-owner',
        kind: 'permission-response', id: 'synthetic-response',
      } },
    });
    service.beginRun(chatId, runId);
    lease.sink.publish({ type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null } });
    lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, '<garcon-get-chat-id />\nSynthetic answer.') }] });
    publishRequested(occurrence);
    const action = { chatId, runId, serverInstanceId: instance, permissionOccurrenceId: occurrence };
    const first = service.claimPermissionResolution(action);
    service.abandonPermissionResolution(first);
    const second = service.claimPermissionResolution(action);
    service.completePermissionResolution(second, { allow: true });
    lease.sink.publish({ type: 'notice', runId, content: 'Synthetic advisory' });
    lease.sink.publish({ type: 'run-ended', runId, outcome: 'finished',
      finalResponse: { type: 'text', text: '<garcon-get-chat-id />\nSynthetic terminal.' } });
    lease.sink.publish({ type: 'run-ended', runId, outcome: 'finished' });
    lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic late row') }] });
    publishRequested(lateOccurrence);
    try {
      service.claimPermissionResolution({ ...action, permissionOccurrenceId: lateOccurrence });
      throw new Error('Late request became actionable');
    } catch (error) {
      if (!(error instanceof PermissionNotActionableError)) throw error;
    }
    if (published.length > 0) throw new Error('Commit listeners ran inline');
    await Promise.resolve();
  } else if (mode !== 'read') {
    throw new Error(`Unknown fixture mode: ${mode}`);
  }
  const head = store.highWatermark(chatId);
  const rows = await store.withStoredRowsThrough(chatId, head, async rows => rows);
  console.log(JSON.stringify({ stored: JSON.stringify({ head, rows }), synchronous, published }));
} finally {
  service.close();
}
