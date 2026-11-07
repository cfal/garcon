import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage, BashToolUseMessage, EditToolUseMessage, ToolResultMessage, UserMessage, WriteToolUseMessage } from '../../../../common/chat-types.js';
import { parseBodyDependencyResponse, parseDisplayWindowResponse, type AvailableDisplayWindow, type DisplayWindowRequest } from '../../../../common/transcript-display-contract.js';
import { DISPLAY_POLICY_REVISION } from '../../../../common/transcript-display-policy.js';
import type { HiddenBashCommandPattern } from '../../../../common/hidden-bash-command-patterns.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptDisplayService } from '../service.js';
import { DisplayWorkerClient } from '../worker-client.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import * as fs from 'node:fs/promises';

const at = '2026-01-01T00:00:00.000Z';
let root: string, store: TranscriptLedgerStore, ledger: TranscriptLedgerService, display: TranscriptDisplayService;
let patterns: HiddenBashCommandPattern[];
const registry = new Set<string>();
beforeEach(async () => {
  await mkdir(path.join(homedir(), 'tmp'), { recursive: true });
  root = await mkdtemp(path.join(homedir(), 'tmp', 'display-service-'));
  store = new TranscriptLedgerStore(path.join(root, 'ledger'));
  ledger = new TranscriptLedgerService(store);
  registry.clear();
  patterns = [];
  display = service('server-a');
});
afterEach(async () => { await display.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
function service(instance: string) {
  return new TranscriptDisplayService({ workspaceDirectory: root, serverInstanceId: instance, ledger,
    hasChat: id => registry.has(id), patterns: () => patterns, freeSpaceReserve: 0,
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
  expect(display.metrics.rows).toBe(0);
  const producer = ledger.openProducer('chat', 'synthetic');
  try {
    producer.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Generic later response') }] });
    const extended = await ready(request('chat', view.viewId));
    expect(extended.certificate.watermark).toBe(initial.certificate.watermark + 1);
    expect(extended.items.slice(0, -1)).toEqual(initial.items);
    expect(display.metrics.rows).toBe(1);
  } finally { producer.close(); }
});

test.each(['write', 'weighted-edit'] as const)('appends only the suffix to an open group and preserves earlier watermark summaries: %s', async kind => {
  const view = seed('chat', 600), input = request('chat', view.viewId);
  const producer = ledger.openProducer('chat', 'synthetic');
  try {
    producer.sink.publish({ type: 'rows', rows: [
      { message: new WriteToolUseMessage(at, 'write-1', '/synthetic/one.txt', 'Synthetic one') },
      { message: new ToolResultMessage(at, 'write-1', 'Synthetic success') },
      { message: new WriteToolUseMessage(at, 'write-2', '/synthetic/two.txt', 'Synthetic two') },
      { message: new ToolResultMessage(at, 'write-2', 'Synthetic success') },
    ] });
    const initial = await ready(input);
    const rowsPrepared = display.metrics.rows;
    expect(initial.items.at(-1)).toMatchObject({ kind: 'tool-group', count: 2,
      totals: { fileEdits: 2 }, base: { openAtWatermark: true } });
    producer.sink.publish({ type: 'rows', rows: [{ message: kind === 'write'
      ? new WriteToolUseMessage(at, 'write-3', '/synthetic/three.txt', 'Synthetic three')
      : new EditToolUseMessage(at, 'edit-3', undefined, undefined, undefined,
        [{ path: '/synthetic/three.txt' }, { path: '/synthetic/four.txt' }]) }] });
    const extended = await ready(input);
    expect(display.metrics.rows - rowsPrepared).toBe(1);
    expect(extended.certificate.watermark).toBe(initial.certificate.watermark + 1);
    expect(extended.items.slice(0, -1)).toEqual(initial.items.slice(0, -1));
    expect(extended.items.at(-1)).toMatchObject({ kind: 'tool-group', count: 3,
      totals: { fileEdits: kind === 'write' ? 3 : 4 }, categoryOrder: ['fileEdits'],
      base: { openAtWatermark: true } });
    expect(extended.later.kind).toBe('exhausted-through-watermark');
    const originalGroup = initial.items.at(-1), growingGroup = extended.items.at(-1);
    if (originalGroup?.kind !== 'tool-group' || growingGroup?.kind !== 'tool-group') throw new Error('Expected final groups');
    expect(growingGroup.firstMember).toBe(originalGroup.firstMember);
    expect(growingGroup.lastMember).toBe(extended.certificate.watermark);

    producer.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic completion') }] });
    const completed = await ready(input);
    expect(completed.items.at(-2)).toMatchObject({ count: 3, base: { openAtWatermark: false } });
    for (const prior of [initial, extended]) {
      const historical = parseDisplayWindowResponse(await display.window({ ...input, atWatermark: prior.certificate.watermark }));
      expect(historical).toMatchObject({ kind: 'available', certificate: prior.certificate, items: prior.items,
        later: { kind: 'exhausted-through-watermark' } });
    }
  } finally { producer.close(); }
});

test('Bash timeouts fail only the matching profile, retry explicitly and retire obsolete revisions', async () => {
  patterns = [{ mode: 'regex', pattern: '^(a+)+$' }];
  display.settingsChanged();
  registry.add('chat');
  const view = ledger.initializeChat('chat');
  const producer = ledger.openProducer('chat', 'synthetic');
  producer.sink.publish({ type: 'rows', rows: [
    ...Array.from({ length: 64 }, (_, index) => ({
      message: new BashToolUseMessage(at, `slow-tool-${index}`, `${'a'.repeat(100 + index)}!`),
    })),
    { message: new AssistantMessage(at, 'Generic response') },
  ] });
  producer.close();
  const input = request('chat', view.viewId), failedRevision = display.bashRevision;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request');
  const waitForFailure = async () => {
    const deadline = Date.now() + 10_000;
    let status;
    do {
      status = (await display.open('chat')).display;
      if (status.phase === 'failed') break;
      await Bun.sleep(10);
    } while (Date.now() < deadline);
    expect(status).toMatchObject({ phase: 'failed', errorCode: 'DISPLAY_FILTER_TIMEOUT' });
  };
  try {
    await waitForFailure();
    expect(await display.window(input)).toMatchObject({ kind: 'failed', errorCode: 'DISPLAY_FILTER_TIMEOUT' });
    await expect(display.resolve(input, 1)).rejects.toMatchObject({ code: 'DISPLAY_FILTER_TIMEOUT' });
    const hidden = await ready({ ...input, profile: { ...input.profile, hiddenToolGroups: ['bash'] } });
    expect(hidden.items).toMatchObject([{ kind: 'row', ordinal: 65 }]);
    expect(await display.resolve({ ...input, profile: { ...input.profile, hiddenToolGroups: ['bash'] } }, 65))
      .toMatchObject({ kind: 'visible-row', landedOrdinal: 65 });
    await display.retry('chat');
    expect((await display.open('chat')).display.phase).toBe('preparing');
    await waitForFailure();
    expect(worker.mock.calls.filter(([task]) => task.kind === 'bash' && task.revision === failedRevision)).toHaveLength(2);
    for (const pattern of ['safe-one', 'safe-two']) {
      patterns = [{ mode: 'glob', pattern }];
      display.settingsChanged();
      expect((await ready(request('chat', view.viewId))).items.map(item => item.kind)).toEqual(['tool-group', 'row']);
    }
    const database = new Database(await sidecar(), { readonly: true });
    try {
      expect(database.query('SELECT revision FROM bash_revision WHERE revision = ?').get(failedRevision)).toBeNull();
      expect(database.query('SELECT revision FROM bash_revision').all()).toHaveLength(2);
    } finally { database.close(); }
  } finally { worker.mockRestore(); }
}, 20_000);

test('certified reads report a permanent rebuild failure instead of staying preparing', async () => {
  const view = seed('chat', 2), input = request('chat', view.viewId);
  const before = await ready(input);
  const group = before.items.find(item => item.kind === 'tool-group');
  if (!group || group.kind !== 'tool-group') throw new Error('Missing synthetic group');
  display.forget('chat');
  const original = DisplayWorkerClient.prototype.request;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'frame') {
      entered.resolve(); await release.promise;
      throw Object.assign(new Error('Synthetic disk failure'), { code: 'DISPLAY_DISK_FULL' });
    }
    return original.call(this, task, ...args);
  });
  try {
    await display.open('chat');
    await entered.promise;
    const resolve = { ...input, atWatermark: before.certificate.watermark };
    expect(await display.resolve(resolve, 2)).toMatchObject({ kind: 'preparing' });
    release.resolve();
    const deadline = Date.now() + 5000;
    while ((await display.open('chat')).display.phase !== 'failed' && Date.now() < deadline) await Bun.sleep(5);
    expect((await display.open('chat')).display).toMatchObject({ phase: 'failed', errorCode: 'DISPLAY_DISK_FULL' });
    await expect(display.resolve(resolve, 2)).rejects.toMatchObject({ code: 'DISPLAY_DISK_FULL' });
    const certified = { certificate: before.certificate, profile: input.profile, cuts: [] };
    await expect(display.members({ ...certified, base: group.base, fragment: group.fragment, anchor: { kind: 'first' }, limit: 50 }))
      .rejects.toMatchObject({ code: 'DISPLAY_DISK_FULL' });
    await expect(display.bodies({ ...certified, seedOrdinals: [2], residentOrdinals: [], limitBodies: 10, estimatedByteBudget: 10000 }))
      .rejects.toMatchObject({ code: 'DISPLAY_DISK_FULL' });
  } finally { release.resolve(); worker.mockRestore(); }
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

async function sidecar(): Promise<string> {
  const directory = path.join(root, 'transcript-display', 'chat');
  return path.join(directory, (await readdir(directory)).find(file => file.endsWith('.sqlite'))!);
}

test('retry retires cached handles before rebuilding a missing warm sidecar', async () => {
  const view = seed('chat', 2), input = request('chat', view.viewId);
  const before = await ready(input), filename = await sidecar();
  await rm(filename);
  await display.retry('chat');
  expect((await ready(input)).items).toEqual(before.items);
  expect(await fs.stat(filename)).toBeDefined();
  expect(ledger.highWatermark('chat').ordinal).toBe(before.sourceHead);
});

test.each(['missing', 'invalid'] as const)('retrying a %s sidecar fences an already completed read from the retired generation', async condition => {
  const view = seed('chat', 2), input = request('chat', view.viewId);
  await ready(input);
  const original = DisplayWorkerClient.prototype.request;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false, invalidate = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'inspect' && invalidate) {
      invalidate = false;
      throw Object.assign(new Error('Synthetic invalid sidecar'), { code: 'DISPLAY_STORE_INVALID' });
    }
    const result = await original.call(this, task, ...args);
    if (task.kind === 'window' && !held) { held = true; entered.resolve(); await release.promise; }
    return result;
  });
  const pending = display.window(input);
  try {
    await entered.promise;
    if (condition === 'missing') await rm(await sidecar());
    else invalidate = true;
    await display.retry('chat');
    expect((await ready(input)).items[1]).toMatchObject({ count: 2 });
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'DISPLAY_SUPERSEDED' });
  } finally { release.resolve(); await pending.catch(() => undefined); worker.mockRestore(); }
});

test('retry racing deletion cannot make retirement wait on its replacement initialization', async () => {
  const view = seed('chat', 1);
  await ready(request('chat', view.viewId));
  const original = DisplayWorkerClient.prototype.request;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let failures = 1, held = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'close') {
      if (failures-- > 0) throw Object.assign(new Error('Busy'), { code: 'DISPLAY_BUSY' });
      if (!held) { held = true; entered.resolve(); await release.promise; }
    }
    return original.call(this, task, ...args);
  });
  let retry: Promise<void> | undefined;
  try {
    display.forget('chat');
    await display.open('chat');
    const deadline = Date.now() + 5000;
    while (!(await display.open('chat')).display.errorCode && Date.now() < deadline) await Bun.sleep(5);
    retry = display.retry('chat');
    const outcome = retry.catch(error => error);
    await entered.promise;
    registry.delete('chat');
    display.forget('chat');
    release.resolve();
    expect(await outcome).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await display.close();
    expect(display.metrics.retirements).toBe(0);
  } finally { release.resolve(); await retry?.catch(() => undefined); worker.mockRestore(); }
});

test('zero-frontier user summaries are preparing rather than authoritative empty lists', async () => {
  const view = seed('chat', 2);
  const original = DisplayWorkerClient.prototype.request;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'frame') { entered.resolve(); await release.promise; }
    return original.call(this, task, ...args);
  });
  try {
    await display.open('chat');
    await entered.promise;
    expect(await display.auxiliary('user-rows', { chatId: 'chat', transcriptViewId: view.viewId, limit: 50 })).toMatchObject({ kind: 'preparing', watermark: 0 });
  } finally { release.resolve(); worker.mockRestore(); }
});

test('reader corruption beyond the inspected manifest retires and rebuilds a warm generation', async () => {
  const view = seed('chat', 2000), input = request('chat', view.viewId);
  const before = await ready(input), filename = await sidecar();
  const db = new Database(filename);
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  const page = db.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema WHERE name = 'posting'").get()!.rootpage;
  const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
  db.close();
  const file = await open(filename, 'r+');
  try { await file.write(Buffer.alloc(pageSize), 0, pageSize, (page - 1) * pageSize); }
  finally { await file.close(); }
  const original = DisplayWorkerClient.prototype.request;
  let evictedReader = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'window' && !evictedReader) {
      evictedReader = true;
      await original.call(this, { kind: 'close', path: filename });
    }
    return original.call(this, task, ...args);
  });
  try {
    await expect(display.window(input)).rejects.toMatchObject({ code: 'DISPLAY_STORE_INVALID' });
    expect((await ready(input)).items).toEqual(before.items);
    expect(ledger.highWatermark('chat').ordinal).toBe(before.sourceHead);
  } finally { worker.mockRestore(); }
});

test.each(['frame', 'auxiliary-frame'] as const)('builder %s corruption rebuilds without a manual retry', async (kind) => {
  const view = seed('chat', 2), input = request('chat', view.viewId);
  await ready(input);
  const original = DisplayWorkerClient.prototype.request;
  let failed = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(function(task, ...args) {
    if (task.kind === kind && !failed) {
      failed = true;
      return Promise.reject(Object.assign(new Error('Synthetic corruption'), { code: 'DISPLAY_STORE_INVALID' }));
    }
    return original.call(this, task, ...args);
  });
  try {
    if (kind === 'frame') ledger.openProducer('chat', 'synthetic').sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Later answer') }] });
    else await display.auxiliary('subagents', { chatId: 'chat', transcriptViewId: view.viewId, limit: 50 });
    const deadline = Date.now() + 5000;
    while (!failed && Date.now() < deadline) await Bun.sleep(5);
    expect(failed).toBe(true);
    expect((await ready(input)).items[1]).toMatchObject({ count: 2 });
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

test('disk admission retries failed evictions without counting their files as freed', async () => {
  const oldView = seed('chat', 1);
  await ready(request('chat', oldView.viewId));
  const filename = await sidecar(), retainedBytes = display.metrics.derivedBytes;
  const nextView = seed('next', 1), input = request('next', nextView.viewId);
  const now = Date.now(), clock = spyOn(Date, 'now').mockReturnValue(now + 20_000);
  const originalStat = fs.statfs, originalRequest = DisplayWorkerClient.prototype.request;
  let failed = false;
  const disk = spyOn(fs, 'statfs').mockImplementation(async function(directory, options) {
    const result = await originalStat(directory, options);
    const exists = await fs.stat(filename).then(() => true, () => false);
    return exists ? { ...result, bavail: 0 } : result;
  });
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(function(task, ...args) {
    if (task.kind === 'close' && task.path === filename && !failed) {
      failed = true;
      return Promise.reject(Object.assign(new Error('Busy'), { code: 'DISPLAY_BUSY' }));
    }
    return originalRequest.call(this, task, ...args);
  });
  try {
    let status = (await display.open('next')).display;
    for (let i = 0; !status.errorCode && i < 100; i++) {
      await Bun.sleep(5);
      status = (await display.open('next')).display;
    }
    expect(status.errorCode).toBe('DISPLAY_DISK_FULL');
    expect(display.metrics.derivedBytes).toBeGreaterThanOrEqual(retainedBytes);
    expect(await fs.stat(filename)).toBeDefined();
    await display.retry('next');
    expect((await ready(input)).items[1]).toMatchObject({ count: 1 });
    expect(await fs.stat(filename).catch(() => null)).toBeNull();
  } finally { worker.mockRestore(); disk.mockRestore(); clock.mockRestore(); }
});

test('disk eviction chains deletion behind a paused close-only retry', async () => {
  const view = seed('chat', 1);
  await ready(request('chat', view.viewId));
  const filename = await sidecar();
  const options = { ...display.options, diskBudget: 1024 * 1024 * 1024 };
  await display.close();
  display = new TranscriptDisplayService(options);
  await display.initialize();
  for (let i = 0; i < 100 && !(await display.open('chat')).display.preparedThrough; i++) await Bun.sleep(5);
  options.diskBudget = 2 * 1024 * 1024;
  registry.add('next');
  const next = ledger.initializeChat('next');
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
  const original = DisplayWorkerClient.prototype.request;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  const worker = spyOn(DisplayWorkerClient.prototype, 'request').mockImplementation(async function(task, ...args) {
    if (task.kind === 'close' && task.path === filename && !held) {
      held = true; entered.resolve(); await release.promise;
    }
    return original.call(this, task, ...args);
  });
  const retry = display.retry('chat').catch(error => error);
  try {
    await entered.promise;
    await display.open('next');
    const deadline = performance.now() + 5000;
    while (!display.metrics.evictions && performance.now() < deadline) await Bun.sleep(5);
    expect(display.metrics.evictions).toBeGreaterThan(0);
    release.resolve();
    for (let i = 0; i < 100 && (await display.open('next')).display.phase !== 'available'; i++) await Bun.sleep(5);
    expect((await display.open('next')).display.phase).toBe('available');
    expect(await fs.stat(filename).catch(() => null)).toBeNull();
    expect(display.metrics.evictions).toBeGreaterThan(0);
    expect((await display.window(request('next', next.viewId))).kind).toBe('available');
  } finally { release.resolve(); await retry; worker.mockRestore(); clock.mockRestore(); }
});

test('superseded disk admission cannot evict another chat after yielding', async () => {
  for (const id of ['chat', 'second', 'third']) {
    const view = seed(id, 1);
    await ready(request(id, view.viewId));
  }
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
  const originalStat = fs.statfs, originalSleep = Bun.sleep;
  const disk = spyOn(fs, 'statfs').mockImplementation(async (directory, options) => ({ ...await originalStat(directory, options), bavail: 0 }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async duration => {
    if (duration === 0 && !held) { held = true; entered.resolve(); await release.promise; }
    else await originalSleep(duration);
  });
  const retry = display.retry('chat').catch(error => error);
  try {
    await entered.promise;
    display.forget('chat');
    release.resolve();
    expect(await retry).toMatchObject({ code: 'DISPLAY_SUPERSEDED' });
    expect((await readdir(path.join(root, 'transcript-display', 'third'))).some(file => file.endsWith('.sqlite'))).toBe(true);
    await display.close();
    expect(display.metrics.retirements).toBe(0);
  } finally { release.resolve(); await retry; sleep.mockRestore(); disk.mockRestore(); clock.mockRestore(); }
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

test('[TLV5-DISPLAY.09-CORE-UNIT-01] rollback and ordinal regrowth before lazy index admission forces rebuilding', async () => {
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
