import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage, ExitPlanModeToolUseMessage, UserMessage, type ChatProcessingPhase } from '../../../../common/chat-types.js';
import { parseDisplayOpenResponse, parsePlanPresentationSnapshot } from '../../../../common/transcript-display-open.js';
import { parseResendSnapshot, parseSubagentSummaryPage } from '../../../../common/transcript-display-auxiliary.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import { TranscriptDisplayService, type DisplayStatus } from '../../transcript-display/service.js';
import { DisplayWorkerClient } from '../../transcript-display/worker-client.js';
import { ChatTransientFeedStore } from '../../chats/chat-transient-feed.js';
import { emptyStoredChatExecutionControl } from '../../chat-execution/control-state.js';
import type { ChatExecutionQueries } from '../../chat-execution/types.js';
import { createTranscriptDisplayRoutes } from '../transcript-display.js';
import type { RouteMap } from '../../lib/http-route-types.js';

const chatId = '1700000000000001', at = '2026-01-01T00:00:00.000Z';
let root: string, ledger: TranscriptLedgerService, display: TranscriptDisplayService, routes: RouteMap, checks: number;
let execution: Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
let store: TranscriptLedgerStore, processingPhase: ChatProcessingPhase | null;
let onStatus: (status: DisplayStatus) => void;
const resendCandidates = mock((id: string) => ledger.resendCandidates(id));
beforeEach(async () => {
  await mkdir(path.join(homedir(), 'tmp'), { recursive: true });
  root = await mkdtemp(path.join(homedir(), 'tmp', 'display-route-'));
  store = new TranscriptLedgerStore(path.join(root, 'ledger'));
  ledger = new TranscriptLedgerService(store);
  processingPhase = null;
  resendCandidates.mockClear();
  onStatus = () => {};
  display = new TranscriptDisplayService({ workspaceDirectory: root, serverInstanceId: 'server', ledger, hasChat: id => id === chatId,
    patterns: () => [], freeSpaceReserve: 0, onStatus: status => onStatus(status),
    adoption: { ensure: async id => ledger.currentView(id) ?? ledger.initializeChat(id) } });
  checks = 0;
  execution = { readChatExecutionControl: async () => emptyStoredChatExecutionControl('server') };
  routes = createTranscriptDisplayRoutes({ display, ledger, transientFeeds: new ChatTransientFeedStore('server'),
    execution, nativeActivity: { requestCheck: () => { checks++; } }, resendCandidates, processingPhase: () => processingPhase,
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

function seedResend(count = 150) {
  const view = ledger.initializeChat(chatId);
  store.append(chatId, view.viewId, Array.from({ length: count }, (_, index) => ({
    kind: 'user-input' as const, at, detail: { clientMessageId: `input-${index}`,
      message: new UserMessage(at, `Synthetic input ${index} ${'x'.repeat(600)}`),
      attachments: [{ kind: 'image' as const, name: `synthetic-${index}.txt`, mimeType: 'text/plain', data: 'c3ludGhldGlj' }],
      steer: false, preambleBoundary: null, preamblePrefixReceipt: null },
  })));
  return { serverInstanceId: 'server', chatId, transcriptViewId: view.viewId };
}

test('reads every source candidate without admitting display preparation or truncating text and filenames', async () => {
  const request = seedResend();
  const auxiliary = spyOn(display, 'auxiliary');
  const before = { ...display.metrics };
  try {
    const result = await post('resend', request);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    const snapshot = parseResendSnapshot(result.body);
    expect(snapshot).toEqual({ ...request, sourceHead: 150, processingPhase: null, candidates: ledger.resendCandidates(chatId) });
    expect(snapshot.candidates).toHaveLength(150);
    expect(snapshot.candidates[0].content.length).toBeGreaterThan(300);
    expect(snapshot.candidates[0].attachmentNames).toEqual(['synthetic-0.txt']);
    expect(result.body).not.toHaveProperty('nextBeforeOrdinal');
    expect(result.body).not.toHaveProperty('messages');
    expect(auxiliary).not.toHaveBeenCalled();
    expect(display.metrics).toEqual(before);
    expect(resendCandidates).toHaveBeenCalledWith(chatId);
  } finally { auxiliary.mockRestore(); }
});

test('processing suppresses the source scan without claiming an idle empty snapshot', async () => {
  const request = seedResend(1);
  processingPhase = 'running';
  expect(parseResendSnapshot((await post('resend', request)).body)).toEqual({ ...request, sourceHead: 1, processingPhase, candidates: [] });
  expect(resendCandidates).not.toHaveBeenCalled();
  processingPhase = null;
  expect(parseResendSnapshot((await post('resend', request)).body).candidates).toHaveLength(1);
});

test('resend remains complete while the derived index is partial or failed', async () => {
  const request = seedResend(300);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), failed = Promise.withResolvers<DisplayStatus>();
  onStatus = status => { if (status.phase === 'failed') failed.resolve(status); };
  const original = DisplayWorkerClient.prototype.request;
  let frames = 0;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'frame' && ++frames === 2) {
      entered.resolve();
      await release.promise;
      throw Object.assign(new Error('Synthetic display failure'), { code: 'DISPLAY_INDEX_FAILED' });
    }
    return original.call(this, task, ...args);
  });
  try {
    await display.open(chatId);
    await entered.promise;
    expect(display.metrics.frontiers[0].preparedThrough).toBeGreaterThan(0);
    expect(display.metrics.frontiers[0].preparedThrough).toBeLessThan(300);
    expect(parseResendSnapshot((await post('resend', request)).body).candidates).toEqual(ledger.resendCandidates(chatId));
    release.resolve();
    expect((await failed.promise).phase).toBe('failed');
    expect(parseResendSnapshot((await post('resend', request)).body).candidates).toHaveLength(300);
  } finally { release.resolve(); worker.mockRestore(); }
});

test('resend rejects stale identities and propagates source failures rather than false-empty success', async () => {
  const request = seedResend(1);
  for (const [body, status] of [
    [{ ...request, serverInstanceId: 'old' }, 409], [{ ...request, transcriptViewId: 'old' }, 409],
    [{ ...request, chatId: 'missing' }, 404], [{ chatId }, 400],
  ] as const) expect((await post('resend', body)).response.status).toBe(status);
  expect(resendCandidates).not.toHaveBeenCalled();
  resendCandidates.mockImplementationOnce(() => { throw new Error('Synthetic source failure'); });
  const failed = await post('resend', request);
  expect(failed.response.status).toBe(500);
  expect(failed.body).not.toHaveProperty('candidates');
});

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

test('subagent admission preserves its response limit independently of user recall', async () => {
  const opened = parseDisplayOpenResponse((await post('open', opening())).body);
  const input = { chatId, transcriptViewId: opened.transcriptViewId, mode: 'recall', limit: 50 };
  const accepted = await post('subagents', input);
  expect(accepted.response.status).toBe(200);
  expect(() => parseSubagentSummaryPage(accepted.body)).not.toThrow();
  for (const limit of [51, 100]) {
    const rejected = await post('subagents', { ...input, limit });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.errorCode).toBe('VALIDATION_FAILED');
  }
  expect((await post('user-rows', { ...input, limit: 100 })).response.status).toBe(200);
});
