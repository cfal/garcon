import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage, BashToolUseMessage, ToolResultMessage, UserMessage } from '../../../../common/chat-types.js';
import { parseBodyDependencyResponse, parseDisplayWindowResponse, type AvailableDisplayWindow, type DisplayWindowRequest } from '../../../../common/transcript-display-contract.js';
import { DISPLAY_POLICY_REVISION } from '../../../../common/transcript-display-policy.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptDisplayService } from '../service.js';
import { DisplayWorkerClient } from '../worker-client.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import * as fs from 'node:fs/promises';

const at = '2026-01-01T00:00:00.000Z';
let root: string, store: TranscriptLedgerStore, ledger: TranscriptLedgerService, display: TranscriptDisplayService;
const registry = new Set<string>();
beforeEach(async () => {
  await mkdir(path.join(homedir(), 'tmp'), { recursive: true });
  root = await mkdtemp(path.join(homedir(), 'tmp', 'display-service-'));
  store = new TranscriptLedgerStore(path.join(root, 'ledger'));
  ledger = new TranscriptLedgerService(store);
  registry.clear();
  display = service('server-a');
});
afterEach(async () => { await display.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
function service(instance: string) {
  return new TranscriptDisplayService({ workspaceDirectory: root, serverInstanceId: instance, ledger,
    hasChat: id => registry.has(id), patterns: () => [], freeSpaceReserve: 0,
    adoption: { ensure: async id => ledger.currentView(id) ?? ledger.initializeChat(id) } });
}
function seed(chatId: string, count: number) {
  registry.add(chatId);
  const view = ledger.initializeChat(chatId);
  const producer = ledger.openProducer(chatId, 'synthetic');
  producer.sink.publish({ type: 'rows', rows: [{ message: new UserMessage(at, 'Generic prompt') }] });
  for (let offset = 0; offset < count; offset += 100) {
    const rows = [];
    for (let i = offset; i < Math.min(count, offset + 100); i++) rows.push(
      { message: new BashToolUseMessage(at, `tool-${i}`, 'true') }, { message: new ToolResultMessage(at, `tool-${i}`, { output: 'ok' }) });
    producer.sink.publish({ type: 'rows', rows });
  }
  producer.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Generic response') }] });
  producer.close();
  return view;
}
function request(chatId: string, viewId: string): DisplayWindowRequest {
  return { chatId, transcriptViewId: viewId, policyRevision: DISPLAY_POLICY_REVISION,
    profile: { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: display.bashRevision },
    cuts: [], limit: 50, anchor: { kind: 'newest' } };
}
async function ready(input: DisplayWindowRequest): Promise<AvailableDisplayWindow> {
  input = { ...input, requiredThrough: ledger.highWatermark(input.chatId).ordinal };
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = parseDisplayWindowResponse(await display.window(input));
    if (result.kind === 'available') return result;
    if (result.kind === 'failed') throw new Error(result.errorCode ?? 'display failed');
    await Bun.sleep(10);
  }
  throw new Error('Display preparation did not complete');
}

test('real workers prepare bounded windows, hydrate selected details and reuse a persisted prefix', async () => {
  const view = seed('chat', 600), input = request('chat', view.viewId);
  const initial = await ready(input);
  expect(initial.items.map(item => item.kind)).toEqual(['row', 'tool-group', 'row']);
  expect(initial.items[1]).toMatchObject({ count: 600 });
  const body = parseBodyDependencyResponse(JSON.parse(await display.bodies({ certificate: initial.certificate,
    profile: input.profile, cuts: [], seedOrdinals: [2], residentOrdinals: [], limitBodies: 10, estimatedByteBudget: 10000 })));
  expect(body.bodies.map(body => body.ordinal)).toEqual([2, 3]);
  expect(body.details[0].pairedResult).toBe(3);
  await display.close();
  ledger.close();
  store = new TranscriptLedgerStore(path.join(root, 'ledger'));
  ledger = new TranscriptLedgerService(store);
  display = service('server-b');
  const restored = await ready(request('chat', view.viewId));
  expect(restored.items).toEqual(initial.items);
  expect(restored.certificate.serverInstanceId).toBe('server-b');
});

test('lost frame acknowledgements reconcile the persisted checkpoint on retry', async () => {
  const original = DisplayWorkerClient.prototype.request;
  let dropped = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    const result = await original.call(this, task, ...args);
    if (task.kind === 'frame' && !dropped) {
      dropped = true;
      throw Object.assign(new Error('Lost acknowledgement'), { code: 'DISPLAY_TIMEOUT' });
    }
    return result;
  });
  try {
    const view = seed('chat', 600), input = request('chat', view.viewId);
    await display.open('chat');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await display.open('chat')).display.errorCode) await Bun.sleep(5);
    expect(dropped).toBe(true);
    await display.retry('chat');
    expect((await ready(input)).items[1]).toMatchObject({ count: 600 });
  } finally { worker.mockRestore(); }
});

test('a failed close retains its fence but can retire and readmit on retry', async () => {
  const view = seed('chat', 1), input = request('chat', view.viewId);
  await ready(input);
  const original = DisplayWorkerClient.prototype.request;
  let remainingFailures = 1;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(function(task, ...args) {
    if (task.kind === 'close' && remainingFailures-- > 0) return Promise.reject(Object.assign(new Error('Busy'), { code: 'DISPLAY_BUSY' }));
    return original.call(this, task, ...args);
  });
  try {
    display.forget('chat');
    await display.open('chat');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await display.open('chat')).display.errorCode) await Bun.sleep(5);
    await display.retry('chat');
    expect((await ready(input)).items[1]).toMatchObject({ count: 1 });
  } finally { worker.mockRestore(); }
});

test('startup enumeration fences replacement preparation before removing obsolete files', async () => {
  const view = seed('chat', 1);
  await ready(request('chat', view.viewId));
  await display.close(); display = service('server-b');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = fs.readdir;
  let held = false;
  const enumeration = spyOn(fs, 'readdir').mockImplementation(async function(directory, options) {
    if (directory === path.join(root, 'transcript-display', 'chat') && !held) {
      held = true; entered.resolve(); await release.promise;
    }
    return original(directory, options);
  });
  try {
    const initializing = display.initialize();
    await entered.promise;
    const next = await ledger.stageView('chat', [], 1, transcriptViewId('replacement'));
    ledger.replaceCurrentView('chat', view.viewId, next.viewId);
    await display.open('chat');
    release.resolve(); await initializing;
    const result = await ready(request('chat', next.viewId));
    expect(result.certificate.transcriptViewId).toBe(next.viewId);
    expect((await readdir(path.join(root, 'transcript-display', 'chat'))).some(file => file.endsWith('.sqlite'))).toBe(true);
  } finally { release.resolve(); enumeration.mockRestore(); }
});

test('ordinary refresh serves a prepared prefix while a finite required goal waits', async () => {
  const view = seed('chat', 1), input = request('chat', view.viewId);
  const first = await ready(input);
  const original = DisplayWorkerClient.prototype.request, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'frame') { entered.resolve(); await release.promise; }
    return original.call(this, task, ...args);
  });
  try {
    ledger.openProducer('chat', 'synthetic').sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Later answer') }] });
    await entered.promise;
    const partial = await display.window(input);
    expect(partial).toMatchObject({ kind: 'available', certificate: { watermark: first.certificate.watermark }, sourceHead: first.sourceHead + 1 });
    expect(await display.window({ ...input, requiredThrough: first.sourceHead + 1 })).toMatchObject({ kind: 'lagging' });
    release.resolve();
    expect((await ready(input)).certificate.watermark).toBe(first.sourceHead + 1);
  } finally { release.resolve(); worker.mockRestore(); }
});

test('auxiliary preparation gets a turn during sustained appends without Bash patterns', async () => {
  const view = seed('chat', 600);
  const original = DisplayWorkerClient.prototype.request;
  let structural = 0, auxiliary = 0;
  const producer = ledger.openProducer('chat', 'synthetic');
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    const result = await original.call(this, task, ...args);
    if (task.kind === 'auxiliary-frame') auxiliary++;
    if (task.kind === 'frame' && structural++ < 8) {
      producer.sink.publish({ type: 'rows', rows: Array.from({ length: 256 }, () => ({ message: new AssistantMessage(at, 'Generic progress') })) });
    }
    return result;
  });
  try {
    await display.auxiliary('subagents', { chatId: 'chat', transcriptViewId: view.viewId, limit: 50 });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !auxiliary) await Bun.sleep(5);
    expect(auxiliary).toBeGreaterThan(0);
    expect(structural).toBeLessThan(8);
  } finally { worker.mockRestore(); }
});

test('invalid auxiliary frontiers are rebuilt without touching the source', async () => {
  const view = seed('chat', 2);
  await ready(request('chat', view.viewId));
  await display.close();
  const directory = path.join(root, 'transcript-display', 'chat');
  const filename = (await readdir(directory)).find(file => file.endsWith('.sqlite'))!;
  const db = new Database(path.join(directory, filename));
  db.run('UPDATE auxiliary_control SET published = 10000, building = 10000'); db.close();
  display = service('server-b');
  expect((await ready(request('chat', view.viewId))).items[1]).toMatchObject({ count: 2 });
  expect(await display.auxiliary('subagents', { chatId: 'chat', transcriptViewId: view.viewId, limit: 50 })).toMatchObject({ kind: 'preparing' });
});

test('rollback and ordinal regrowth before lazy index admission forces rebuilding', async () => {
  const view = seed('chat', 10);
  await ready(request('chat', view.viewId));
  await display.close(); ledger.close();
  const db = new Database(path.join(root, 'ledger', 'chat', 'ledger.sqlite'));
  db.run('DELETE FROM transcript_rows WHERE ordinal > 1'); db.close();
  store = new TranscriptLedgerStore(path.join(root, 'ledger'));
  ledger = new TranscriptLedgerService(store);
  const producer = ledger.openProducer('chat', 'synthetic');
  producer.sink.publish({ type: 'rows', rows: Array.from({ length: 30 }, () => ({ message: new AssistantMessage(at, 'New response') })) });
  display = service('server-b');
  const rebuilt = await ready(request('chat', view.viewId));
  expect(rebuilt.items).toHaveLength(31);
  expect(rebuilt.items.every(item => item.kind === 'row')).toBe(true);
});

test('deletion fences pending preparation and does not recreate sidecars', async () => {
  const view = seed('chat', 600);
  await display.open('chat');
  display.forget('chat'); registry.delete('chat'); ledger.deleteChat('chat');
  await display.close();
  expect(await readdir(path.join(root, 'transcript-display'))).toEqual([]);
  await expect(display.window(request('chat', view.viewId))).rejects.toThrow();
});

test('forged profile qualifiers are rejected by service admission', async () => {
  const view = seed('chat', 1), input = request('chat', view.viewId), window = await ready(input);
  await expect(display.bodies({ certificate: { ...window.certificate, profileKey: 'forged' }, profile: input.profile,
    cuts: [], seedOrdinals: [1], residentOrdinals: [], limitBodies: 1, estimatedByteBudget: 1000 })).rejects.toMatchObject({ code: 'DISPLAY_STALE_CERTIFICATE' });
});
