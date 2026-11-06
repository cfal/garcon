import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WorkflowRuntime, type WorkflowEngineLifecycle, type WorkflowRuntimeDependencies } from '../setup.js';
import type { WorkflowStore } from '../store.js';
import { ApiProviderService } from '../../api-providers/service.js';
import { ApiProviderStore } from '../../api-providers/store.js';
import { ApiProviderAccess } from '../../api-providers/access.js';
import { ApiProviderAssignmentStore } from '../../api-providers/assignments.js';
import { SettingsStore } from '../../settings/store.js';
import { WorkflowAttempts } from '../attempts.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import { browser, effectFence, plan } from './fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture(overrides: Partial<WorkflowRuntimeDependencies> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-lifecycle-'));
  let initialized = false;
  let store: WorkflowStore | null = null;
  const engine = {
    start: mock(() => {}), pauseAdmission: mock(() => {}), refreshControl: mock((_id: string) => {}),
    stopRunning: mock((_id: string) => {}), wake: mock((_id?: string) => {}),
    beginShutdown: mock(() => {}), waitForSettlements: mock(async () => {}), dispose: mock(() => {}),
  } satisfies WorkflowEngineLifecycle;
  const deps = {
    storageInitialized: () => initialized,
    markStorageInitialized: mock(async () => { initialized = true; }),
    createEngine: mock((database: WorkflowStore) => { store = database; return engine; }),
    onInvalidated: mock(() => {}),
    ...overrides,
  } satisfies WorkflowRuntimeDependencies;
  const runtime = new WorkflowRuntime(directory, deps);
  cleanups.push(async () => { await runtime.close(1); rmSync(directory, { recursive: true, force: true }); });
  return { directory, runtime, deps, engine, get initialized() { return initialized; }, get store() { return store!; },
    epoch() { return store!.read(db => db.query<{ admission_epoch: number }, []>('SELECT admission_epoch FROM workflow_metadata').get()!.admission_epoch); },
    create() { return runtime.service.execute({ operationId: crypto.randomUUID(), mutation: {
      action: 'create', plan: plan(), captainChatId: null,
    } }, browser).workflowId; },
  };
}

test('disabled construction inspects references without creating storage, an engine, or timers', async () => {
  const f = fixture();
  expect(f.runtime.referencesApiProvider('synthetic-provider')).toBe(false);
  await f.runtime.disable();
  expect(existsSync(join(f.directory, 'workflows.sqlite'))).toBe(false);
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  expect(f.deps.markStorageInitialized).not.toHaveBeenCalled();
  expect(() => f.runtime.service).toThrow();
  await f.runtime.close();
  expect(f.engine.start).not.toHaveBeenCalled();
});

test('service publication and engine start wait for durable initialization', async () => {
  const marker = Promise.withResolvers<void>();
  const f = fixture({ markStorageInitialized: () => marker.promise });
  const opening = f.runtime.enable();
  expect(f.runtime.enable()).toBe(opening);
  expect(() => f.runtime.service).toThrow();
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  marker.resolve();
  await opening;
  expect(f.create()).toBeString();
  expect(f.engine.start).toHaveBeenCalledTimes(1);
});

test('failed initialized-marker persistence fences access and never starts execution', async () => {
  const f = fixture({ markStorageInitialized: async () => { throw new Error('Synthetic marker failure'); } });
  await expect(f.runtime.enable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  expect(() => f.runtime.service).toThrow();
  await expect(f.runtime.enable()).rejects.toThrow();
});

test.each(['missing', 'corrupt'])('initialized %s storage retains references without creating a replacement', async kind => {
  const f = fixture({ storageInitialized: () => true });
  const path = join(f.directory, 'workflows.sqlite');
  if (kind === 'corrupt') writeFileSync(path, 'synthetic invalid database', { mode: 0o600 });
  expect(f.runtime.referencesApiProvider('any-provider')).toBe(true);
  await expect(f.runtime.enable()).rejects.toThrow();
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  expect(existsSync(path)).toBe(kind === 'corrupt');
});

test('an interrupted first initialization can reopen an empty database before the marker exists', async () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'workflows.sqlite'), '', { mode: 0o600 });
  expect(f.runtime.referencesApiProvider('any-provider')).toBe(true);
  await f.runtime.enable();
  expect(f.initialized).toBe(true);
  expect(f.create()).toBeString();
  expect(f.runtime.referencesApiProvider('any-provider')).toBe(false);
});

test.each(['empty-initialized', 'unrecognized', 'corrupt'])('does not repair %s storage as a fresh database', async kind => {
  const f = fixture({ storageInitialized: () => kind === 'empty-initialized' });
  const path = join(f.directory, 'workflows.sqlite');
  writeFileSync(path, kind === 'corrupt' ? 'synthetic invalid database' : '', { mode: 0o600 });
  if (kind === 'unrecognized') {
    const database = new Database(path);
    database.exec('CREATE TABLE preserved (id TEXT); INSERT INTO preserved VALUES (\'synthetic\')');
    database.close();
  }
  await expect(f.runtime.enable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  expect(f.deps.markStorageInitialized).not.toHaveBeenCalled();
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  expect(f.runtime.referencesApiProvider('any-provider')).toBe(true);
  if (kind === 'unrecognized') {
    const database = new Database(path, { readonly: true });
    expect(database.query('SELECT * FROM preserved').all()).toEqual([{ id: 'synthetic' }]);
    database.close();
  }
});

test('real settings retain provider protection after initialized storage disappears across restart', async () => {
  const f = fixture();
  const settings = new SettingsStore(f.directory);
  await settings.init();
  const runtime = new WorkflowRuntime(f.directory, { ...f.deps,
    storageInitialized: () => settings.hasInitializedWorkflowStorage(),
    markStorageInitialized: () => settings.markWorkflowStorageInitialized(),
  });
  await runtime.enable();
  await runtime.close();
  rmSync(join(f.directory, 'workflows.sqlite'));
  const reloaded = new SettingsStore(f.directory);
  await reloaded.init();
  const cold = new WorkflowRuntime(f.directory, { ...f.deps,
    storageInitialized: () => reloaded.hasInitializedWorkflowStorage(),
  });
  expect(cold.referencesApiProvider('synthetic-provider')).toBe(true);
  await expect(cold.enable()).rejects.toThrow();
  await cold.close();
  expect(existsSync(join(f.directory, 'workflows.sqlite'))).toBe(false);
});

test('cold disabled inspection retains strong provider references without writable initialization', async () => {
  const f = fixture();
  await f.runtime.enable();
  const source = plan();
  const task = source.tasks[0]!;
  if (task.spec.kind !== 'command') throw new Error('Synthetic command required');
  const proposed = { ...source, tasks: [{ ...task, spec: { kind: 'agent', target: task.spec.target,
    prompt: 'Synthetic implementation', outputs: ['commit'], selection: { agentId: 'synthetic-agent', model: 'synthetic-model',
      apiProviderId: 'synthetic-provider', modelEndpointId: 'synthetic-endpoint', modelProtocol: 'openai-compatible',
      permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'synthetic-agent', schemaVersion: 1, values: {} },
      preambles: [], providerRevision: 1 } } }] };
  f.runtime.service.execute({ operationId: crypto.randomUUID(), mutation: { action: 'create', plan: proposed, captainChatId: null } }, browser);
  await f.runtime.close();
  const before = statSync(join(f.directory, 'workflows.sqlite')).mtimeMs;
  const cold = new WorkflowRuntime(f.directory, f.deps);
  expect(cold.referencesApiProvider('synthetic-provider')).toBe(true);
  expect(cold.referencesApiProvider('other-provider')).toBe(false);
  expect(statSync(join(f.directory, 'workflows.sqlite')).mtimeMs).toBe(before);
  expect(f.deps.createEngine).toHaveBeenCalledTimes(1);
  await cold.close();
});

test.each([false, true])('provider deletion distinguishes never initialized from lost workflow storage: initialized=%s', async initialized => {
  const f = fixture({ storageInitialized: () => initialized });
  const store = new ApiProviderStore(join(f.directory, 'api-providers.json'));
  await store.init();
  const assignments = new ApiProviderAssignmentStore(f.directory, () => () => {});
  await assignments.migrate([], []);
  await assignments.initialize();
  const service = new ApiProviderService({ store, access: new ApiProviderAccess(store, assignments, () => true),
    discoverModels: async () => ({ success: true, models: [] }),
    isApiProviderReferenced: id => f.runtime.referencesApiProvider(id) });
  const provider = await service.create({ templateId: 'custom', label: 'Synthetic provider', endpoint: {
    protocol: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: '',
    capabilities: { chatCompletions: true, responses: false }, defaultModel: 'synthetic', models: [],
    supportsImages: false, modelDiscovery: 'none',
  } });
  if (initialized) await expect(service.delete(provider.id)).rejects.toMatchObject({ code: 'API_PROVIDER_IN_USE' });
  else await service.delete(provider.id);
  expect(store.list()).toHaveLength(initialized ? 1 : 0);
  expect(f.deps.createEngine).not.toHaveBeenCalled();
});

test('disable drains observations but suspends the approval epoch before re-enable', async () => {
  const f = fixture();
  await f.runtime.enable();
  const id = f.create();
  const before = f.epoch();
  await f.runtime.disable();
  expect(f.epoch()).toBe(before + 1);
  expect(f.engine.pauseAdmission).toHaveBeenCalledTimes(1);
  expect(f.engine.beginShutdown).not.toHaveBeenCalled();
  expect(f.engine.waitForSettlements).not.toHaveBeenCalled();
  expect(f.engine.dispose).not.toHaveBeenCalled();
  expect(f.runtime.service.detail(id).workflow.desired).toBe('draft');
  expect(() => f.create()).toThrow();
  await f.runtime.disable();
  expect(f.epoch()).toBe(before + 1);
  await f.runtime.enable();
  expect(f.epoch()).toBe(before + 1);
  expect(f.deps.createEngine).toHaveBeenCalledTimes(1);
});

test('activation refreshes persisted attempt control without stopping unaffected work', async () => {
  const f = fixture();
  await f.runtime.enable();
  const id = f.create();
  f.runtime.service.execute({ operationId: crypto.randomUUID(), mutation: { action: 'activate', workflowId: id,
    manifestDigest: f.runtime.service.detail(id).activationDigest } }, browser);
  expect(f.engine.refreshControl).toHaveBeenCalledWith(id);
  expect(f.engine.stopRunning).not.toHaveBeenCalled();
});

test('terminal persistence continues after disable without disposing consumers', async () => {
  const f = fixture();
  await f.runtime.enable();
  const id = f.create();
  f.runtime.service.execute({ operationId: crypto.randomUUID(), mutation: { action: 'activate', workflowId: id,
    manifestDigest: f.runtime.service.detail(id).activationDigest } }, browser);
  const attempts = new WorkflowAttempts(f.store, { now: () => new Date().toISOString() });
  const attempt = attempts.reserve(id, 'check')!;
  await f.runtime.disable();
  attempts.observe(attempt.attemptId, workflowTerminalObservation(plan().tasks[0]!, {
    kind: 'failed', certainty: 'not-started', detail: 'Synthetic preparation canceled.', receipt: null,
    commandOutcome: null, receivedOutputCoverage: 'unknown',
  }), effectFence());
  expect(f.runtime.service.detail(id).tasks[0]!.attempt?.resolution).toBe('not-started');
  expect(f.engine.dispose).not.toHaveBeenCalled();
  expect(f.engine.waitForSettlements).not.toHaveBeenCalled();
  expect(f.engine.beginShutdown).not.toHaveBeenCalled();
});

test('the first disable durably suspends approval even when the pause hook fails', async () => {
  const f = fixture();
  await f.runtime.enable();
  const id = f.create();
  f.runtime.service.execute({ operationId: crypto.randomUUID(), mutation: { action: 'activate', workflowId: id,
    manifestDigest: f.runtime.service.detail(id).activationDigest } }, browser);
  const before = f.epoch();
  f.engine.pauseAdmission.mockImplementation(() => { throw new Error('Synthetic first-disable failure'); });
  await f.runtime.disable();
  expect(f.epoch()).toBe(before + 1);
  await f.runtime.close();
  const cold = new WorkflowRuntime(f.directory, f.deps);
  try {
    await cold.enable();
    const detail = cold.service.detail(id);
    expect(detail.workflow.desired).toBe('active');
    expect(detail.tasks[0]!.phase).toBe('blocked');
    expect(detail.workflow.admissionEpoch).toBe(before);
    expect(f.epoch()).toBe(before + 1);
  } finally { await cold.close(); }
});

test('disable while initialization is pending cannot be undone by rapid re-enable', async () => {
  const marker = Promise.withResolvers<void>();
  const f = fixture({ markStorageInitialized: () => marker.promise });
  const opening = f.runtime.enable();
  const disabling = f.runtime.disable();
  const superseded = expect(disabling).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  const reenabled = f.runtime.enable();
  expect(reenabled).toBe(opening);
  marker.resolve();
  await opening;
  await superseded;
  expect(f.epoch()).toBe(1);
  expect(f.create()).toBeString();
  expect(f.engine.start).toHaveBeenCalledTimes(1);
});

test('disable rejects when suspension cannot be persisted', async () => {
  const f = fixture();
  await f.runtime.enable();
  const before = f.epoch();
  const transaction = spyOn(f.store, 'transaction').mockImplementationOnce(() => { throw new Error('Synthetic suspension write failure'); });
  try {
    await expect(f.runtime.disable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(f.epoch()).toBe(before);
    expect(f.engine.beginShutdown).toHaveBeenCalledTimes(1);
    await expect(f.runtime.disable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  } finally { transaction.mockRestore(); }
});

test('disable cannot acknowledge suspension on a failed or cold initialized runtime', async () => {
  const cold = fixture({ storageInitialized: () => true });
  await expect(cold.runtime.disable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  const failed = fixture({ markStorageInitialized: async () => { throw new Error('Synthetic marker failure'); } });
  await expect(failed.runtime.enable()).rejects.toThrow();
  await expect(failed.runtime.disable()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
});

test.each(['failure', 'shutdown'] as const)('disable rejects when pending initialization ends in %s', async outcome => {
  const marker = Promise.withResolvers<void>();
  const f = fixture({ markStorageInitialized: () => marker.promise });
  const opening = f.runtime.enable();
  const disabling = f.runtime.disable();
  const rejected = expect(disabling).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  if (outcome === 'failure') {
    const failedOpen = expect(opening).rejects.toThrow();
    marker.reject(new Error('Synthetic marker failure'));
    await failedOpen;
  } else {
    await f.runtime.close(1);
    marker.resolve();
    await opening;
  }
  await rejected;
  expect(f.deps.createEngine).not.toHaveBeenCalled();
});

test('shutdown bounds disconnected settlement and fences late storage access', async () => {
  const settled = Promise.withResolvers<void>();
  const f = fixture();
  f.engine.waitForSettlements.mockImplementation(() => settled.promise);
  await f.runtime.enable();
  const closing = f.runtime.close(1);
  expect(f.runtime.close()).toBe(closing);
  await closing;
  expect(f.engine.beginShutdown).toHaveBeenCalledTimes(1);
  expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  expect(() => f.store.read(() => true)).toThrow();
  settled.resolve();
  await expect(f.runtime.enable()).rejects.toThrow();
});

test('shutdown during marker persistence cannot publish a late engine or service', async () => {
  const marker = Promise.withResolvers<void>();
  const f = fixture({ markStorageInitialized: () => marker.promise });
  const opening = f.runtime.enable();
  await f.runtime.close(1);
  marker.resolve();
  await opening;
  expect(f.deps.createEngine).not.toHaveBeenCalled();
  expect(() => f.runtime.service).toThrow();
});

test('post-commit control failure fences the engine without rejecting the committed intent', async () => {
  const f = fixture();
  await f.runtime.enable();
  const id = f.create();
  f.engine.stopRunning.mockImplementation(() => { throw new Error('Synthetic Stop delivery failure'); });
  const service = f.runtime.service;
  expect(service.execute({ operationId: crypto.randomUUID(), mutation: { action: 'stop', workflowId: id } }, browser).workflowId).toBe(id);
  expect(f.engine.beginShutdown).toHaveBeenCalledTimes(1);
  expect(() => f.runtime.service).toThrow();
});

test('a synchronous failure installing consumers cannot start an engine afterward', async () => {
  const engine = fixture().engine;
  const f = fixture({ createEngine: (_store, onFailure) => {
    onFailure(new Error('Synthetic listener failure'));
    return engine;
  } });
  await expect(f.runtime.enable()).rejects.toThrow();
  expect(engine.start).not.toHaveBeenCalled();
  expect(engine.beginShutdown).toHaveBeenCalledTimes(1);
});

test.each(['start', 'pauseAdmission'] as const)('a failed engine %s transition fences future admission', async method => {
  const f = fixture();
  await f.runtime.enable();
  await f.runtime.disable();
  f.engine[method].mockImplementation(() => { throw new Error('Synthetic lifecycle failure'); });
  if (method === 'start') await expect(f.runtime.enable()).rejects.toThrow();
  else await f.runtime.disable();
  expect(() => f.runtime.service).toThrow();
  expect(f.engine.beginShutdown).toHaveBeenCalledTimes(1);
});

test.each([false, true])('core failure fences synchronously and defers cleanup and logging: shutdownThrows=%s', async shutdownThrows => {
  const base = fixture();
  let report: (error: unknown) => void = () => { throw new Error('Missing failure observer'); };
  let storage: WorkflowStore | null = null;
  const f = fixture({ createEngine: (store, onFailure) => {
    storage = store;
    report = onFailure;
    return base.engine;
  } });
  await f.runtime.enable();
  if (shutdownThrows) base.engine.beginShutdown.mockImplementation(() => { throw new Error('Synthetic shutdown failure'); });
  const warning = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    report(new Error('Synthetic core listener failure'));
    report(new Error('Synthetic repeated failure'));
    expect(() => f.runtime.service).toThrow();
    expect(base.engine.beginShutdown).toHaveBeenCalledTimes(1);
    expect(storage!.read(() => true)).toBe(true);
    expect(base.engine.dispose).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(storage!.read(() => true)).toBe(true);
    expect(warning).not.toHaveBeenCalled();
    await nextTurn();
    expect(() => storage!.read(() => true)).toThrow();
    expect(base.engine.dispose).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(shutdownThrows ? 2 : 1);
    await f.runtime.close();
    expect(base.engine.dispose).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});
