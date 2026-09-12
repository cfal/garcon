import { expect, test } from 'bun:test';
import { DEFAULT_NODE_REPLAY } from '../../replay-cache.js';
import { MAX_NODE_WORKER_CONFIGURATION_BYTES, MAX_NODE_WORKER_INSTANCES, parseNodeWorkerConfiguration } from '../configuration.js';

export function sessionConfiguration() {
  return { role: 'session' as const, nodeId: 'synthetic-node', storageDirectory: '/synthetic/storage',
    workspaces: [{ id: 'synthetic-workspace', projectPath: '/synthetic/project' }], replay: { ...DEFAULT_NODE_REPLAY },
    instances: [{ id: 'synthetic-instance', agentId: 'synthetic', label: 'Synthetic', homeDirectory: '/synthetic/home',
      environment: { SYNTHETIC_API_KEY: 'synthetic-private-value' }, workspaceIds: ['synthetic-workspace'], maxOperations: 2 }],
  };
}

test('configuration snapshots instance environments and grants without starting provider code', () => {
  const input = sessionConfiguration();
  const parsed = parseNodeWorkerConfiguration(input);
  expect(parsed).toEqual(input);
  if (parsed?.role !== 'session') throw new Error('Missing session configuration');
  input.instances[0]!.environment.SYNTHETIC_API_KEY = 'replacement';
  input.instances[0]!.workspaceIds.length = 0;
  input.replay.maxBytes = 1;
  expect(parsed.instances[0]!.environment.SYNTHETIC_API_KEY).toBe('synthetic-private-value');
  expect(parsed.instances[0]!.workspaceIds).toEqual(['synthetic-workspace']);
  expect(parsed.replay).toEqual(DEFAULT_NODE_REPLAY);
  expect(Object.isFrozen(parsed.instances[0]!.environment)).toBe(true);
  expect(Object.isFrozen(parsed.workspaces)).toBe(true);
});

test('instance configuration receives only its explicit workspace grants', () => {
  const input = sessionConfiguration();
  const instance = { role: 'instance' as const, nodeId: input.nodeId, storageDirectory: input.storageDirectory,
    instance: input.instances[0], workspaces: input.workspaces };
  expect(parseNodeWorkerConfiguration(instance)).toEqual(instance);
  expect(parseNodeWorkerConfiguration({ ...instance, replay: DEFAULT_NODE_REPLAY })).toBeNull();
  expect(parseNodeWorkerConfiguration({ ...instance, workspaces: [] })).toBeNull();
});

test('same-provider profiles require distinct identities and nonoverlapping homes', () => {
  const input = sessionConfiguration();
  const original = input.instances[0]!;
  for (const extra of [original, { ...original, id: 'second' }, { ...original, id: 'second', homeDirectory: `${original.homeDirectory}/nested` }]) {
    expect(parseNodeWorkerConfiguration({ ...input, instances: [original, extra] })).toBeNull();
  }
  expect(parseNodeWorkerConfiguration({ ...input, instances: [original, { ...original, id: 'second', homeDirectory: '/synthetic/second' }] })).not.toBeNull();
});

test('configuration rejects ambiguous fields, foreign grants, unsafe paths and unbounded resource lists', () => {
  const input = sessionConfiguration();
  const original = input.instances[0]!;
  for (const malformed of [
    { ...input, credential: 'synthetic-pairing-secret' }, { ...input, role: 'controller' },
    { ...input, storageDirectory: '/synthetic/../storage' }, { ...input, storageDirectory: 'relative' },
    { ...input, workspaces: [...input.workspaces, ...input.workspaces] },
    { ...input, instances: [{ ...original, workspaceIds: ['unknown'] }] },
    { ...input, instances: [{ ...original, workspaceIds: ['synthetic-workspace', 'synthetic-workspace'] }] },
    { ...input, instances: [{ ...original, maxOperations: 257 }] },
    { ...input, instances: Array(MAX_NODE_WORKER_INSTANCES + 1).fill(original) },
    { ...input, replay: { ...DEFAULT_NODE_REPLAY, maxBytes: DEFAULT_NODE_REPLAY.maxBytes + 1 } },
    { ...input, replay: { ...DEFAULT_NODE_REPLAY, maxAgeMs: 0 } },
  ]) expect(parseNodeWorkerConfiguration(malformed)).toBeNull();
});

test('instance environment cannot override owned namespaces or carry malformed process values', () => {
  const input = sessionConfiguration();
  for (const environment of [{ PATH: '/another/bin' }, { LANG: 'another' }, { HOME: '/another/home' }, { XDG_RUNTIME_DIR: '/another/run' }, { TMPDIR: '/another/tmp' },
    { GARCON_WORKSPACE_DIR: '/controller' }, { 'BAD=KEY': 'value' }, { KEY: 'embedded\0value' },
    { KEY: 'x'.repeat(MAX_NODE_WORKER_CONFIGURATION_BYTES) }, { KEY: 1 }]) {
    expect(parseNodeWorkerConfiguration({ ...input, instances: [{ ...input.instances[0], environment }] })).toBeNull();
  }
});

test('only session configuration can declare a finite positive output memory budget', () => {
  const input = sessionConfiguration();
  expect(parseNodeWorkerConfiguration({ ...input, outputMemoryBytes: 512 * 1024 * 1024 }))
    .toMatchObject({ outputMemoryBytes: 512 * 1024 * 1024 });
  for (const outputMemoryBytes of [0, -1, 1.5, '1024', null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(parseNodeWorkerConfiguration({ ...input, outputMemoryBytes })).toBeNull();
  }
  expect(parseNodeWorkerConfiguration({ role: 'instance', nodeId: input.nodeId, storageDirectory: input.storageDirectory,
    instance: input.instances[0], workspaces: input.workspaces, outputMemoryBytes: 1024 })).toBeNull();
});
