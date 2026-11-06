import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage, ExitPlanModeToolUseMessage } from '../../../../common/chat-types.js';
import { parseDisplayOpenResponse, parsePlanPresentationSnapshot } from '../../../../common/transcript-display-open.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import { TranscriptDisplayService } from '../../transcript-display/service.js';
import { ChatTransientFeedStore } from '../../chats/chat-transient-feed.js';
import { emptyStoredChatExecutionControl } from '../../chat-execution/control-state.js';
import type { ChatExecutionQueries } from '../../chat-execution/types.js';
import { createTranscriptDisplayRoutes } from '../transcript-display.js';
import type { RouteMap } from '../../lib/http-route-types.js';

const chatId = '1700000000000001', at = '2026-01-01T00:00:00.000Z';
let root: string, ledger: TranscriptLedgerService, display: TranscriptDisplayService, routes: RouteMap, checks: number;
let execution: Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
beforeEach(async () => {
  await mkdir(path.join(homedir(), 'tmp'), { recursive: true });
  root = await mkdtemp(path.join(homedir(), 'tmp', 'display-route-'));
  ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(root, 'ledger')));
  display = new TranscriptDisplayService({ workspaceDirectory: root, serverInstanceId: 'server', ledger, hasChat: id => id === chatId,
    patterns: () => [], freeSpaceReserve: 0, adoption: { ensure: async id => ledger.currentView(id) ?? ledger.initializeChat(id) } });
  checks = 0;
  execution = { readChatExecutionControl: async () => emptyStoredChatExecutionControl('server') };
  routes = createTranscriptDisplayRoutes({ display, ledger, transientFeeds: new ChatTransientFeedStore('server'),
    execution, nativeActivity: { requestCheck: () => { checks++; } },
    summaries: { buildSummary: () => ({ chat: { id: chatId, title: 'Generic chat', agentId: 'generic', agentOwnershipEpoch: 'epoch', carryOverRevision: 'revision',
      model: null, apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'high',
      projectPath: '/generic', tags: [], canReloadFromNativeHistory: false, activity: { createdAt: at, lastActivityAt: at } }, processingPhase: null }) } });
});
afterEach(async () => { await display.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
async function post(suffix: string, body: unknown) {
  const url = new URL(`http://localhost/api/v1/chats/transcript-display/${suffix}`);
  const response = await routes[url.pathname].POST(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url);
  return { response, body: await response.json() };
}
const opening = () => ({ chatId, outstandingClientMessageIds: [], reason: 'activate' });

test('opens canonical empty views without raw bodies and probes only activation', async () => {
  const opened = await post('open', opening());
  expect(opened.response.status).toBe(200);
  expect(opened.response.headers.get('Cache-Control')).toBe('no-store');
  const parsed = parseDisplayOpenResponse(opened.body);
  expect(parsed.sourceHead).toBe(0);
  expect(opened.body).not.toHaveProperty('messages');
  expect(checks).toBe(1);
  await post('open', { ...opening(), reason: 'reconnect' });
  expect(checks).toBe(1);
});

test('rejects an open when the source view is replaced while execution control is pending', async () => {
  const opened = parseDisplayOpenResponse((await post('open', opening())).body);
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const control = spyOn(execution, 'readChatExecutionControl').mockImplementationOnce(async () => {
    entered.resolve();
    await released.promise;
    return emptyStoredChatExecutionControl('server');
  });
  const pending = post('open', { ...opening(), expectedTranscriptViewId: opened.transcriptViewId });
  try {
    await entered.promise;
    const replacement = await ledger.stageView(chatId, [], 1);
    ledger.replaceCurrentView(chatId, transcriptViewId(opened.transcriptViewId), replacement.viewId);
    released.resolve();
    const result = await pending;
    expect(result.response.status).toBe(409);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    expect(result.body.errorCode).toBe('STALE_TRANSCRIPT_VIEW');
    expect(result.body).not.toHaveProperty('transcriptViewId');
    expect(checks).toBe(1);
    const recovered = await post('open', { ...opening(), reason: 'reconnect', expectedTranscriptViewId: replacement.viewId });
    expect(recovered.response.status).toBe(200);
    expect(parseDisplayOpenResponse(recovered.body).transcriptViewId).toBe(replacement.viewId);
    expect(checks).toBe(1);
  } finally { released.resolve(); await pending; control.mockRestore(); }
});

test('same-tool-ID plan occurrences remain independent and dismissal is idempotent', async () => {
  const opened = parseDisplayOpenResponse((await post('open', opening())).body);
  const producer = ledger.openProducer(chatId, 'generic');
  producer.sink.publish({ type: 'rows', rows: [
    { message: new ExitPlanModeToolUseMessage(at, 'reused-tool', 'Generic plan one') },
    { message: new ExitPlanModeToolUseMessage(at, 'reused-tool', 'Generic plan two') },
    { message: new AssistantMessage(at, 'Generic text') },
  ] });
  await Promise.resolve();
  const request = { serverInstanceId: 'server', chatId, transcriptViewId: opened.transcriptViewId };
  expect(parsePlanPresentationSnapshot((await post('plan', request)).body).exits.map(exit => exit.ordinal)).toEqual([1, 2]);
  expect((await post('plan-detail', { ...request, ordinal: 2 })).body.message.plan).toBe('Generic plan two');
  await post('plan-dismiss', { ...request, ordinal: 1 });
  expect((await post('plan-dismiss', { ...request, ordinal: 1 })).body.pendingExitCount).toBe(1);
  expect((await post('plan-detail', { ...request, ordinal: 1 })).response.status).toBe(409);
  expect((await post('plan-dismiss', { ...request, serverInstanceId: 'old-server', ordinal: 2 })).response.status).toBe(409);
});

test('rejects malformed requests and replaced views without false-empty success', async () => {
  const opened = parseDisplayOpenResponse((await post('open', opening())).body);
  expect((await post('open', { ...opening(), outstandingClientMessageIds: Array(33).fill('input') })).response.status).toBe(400);
  expect((await post('open', { ...opening(), expectedTranscriptViewId: 'old-view' })).response.status).toBe(409);
  const input = { chatId, transcriptViewId: opened.transcriptViewId, policyRevision: 1, limit: 50,
    profile: { combine: false, showThinking: true, hiddenToolGroups: [], bashRevision: display.bashRevision }, cuts: [], anchor: { kind: 'newest' } };
  expect((await post('window', { ...input, limit: 201 })).response.status).toBe(400);
  expect((await post('window', { ...input, chatId: 'missing' })).response.status).toBe(404);
  expect((await post('window', { ...input, profile: { ...input.profile, bashRevision: 'old' } })).response.status).toBe(409);
});
