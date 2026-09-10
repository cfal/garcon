import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseExecutionNodesSnapshot } from '../../../common/execution-nodes.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../lib/json-file-store.js';
import { ExecutionNodesStore } from '../store.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(options) {
  const directory = await mkdtemp(join(homedir(), 'garcon-placement-test-'));
  directories.push(directory);
  const store = new ExecutionNodesStore(directory, options);
  await store.init();
  return { directory, store, file: join(directory, 'execution-nodes.json') };
}

describe('execution resource identity persistence', () => {
  test('persists the local node before returning it and preserves identity after restart', async () => {
    const { directory, store, file } = await fixture();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toEqual(store.snapshot());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await new ExecutionNodesStore(directory).init()).toEqual(saved);
    const returned = store.snapshot();
    returned.nodes[0].label = 'caller mutation';
    expect(store.snapshot()).toEqual(saved);
  });

  test('prepares stable default instances and deduplicated missing project paths without filesystem I/O', async () => {
    const { directory, store, file } = await fixture();
    const targets = [
      { agentId: 'synthetic-provider', projectPath: '/synthetic/missing/project' },
      { agentId: 'synthetic-provider', projectPath: '/synthetic/missing/project' },
      { agentId: 'second-provider', projectPath: '/synthetic/missing/project' },
      { agentId: 'synthetic-provider', projectPath: 'Z:\\missing\\project' },
    ];
    const locations = await store.prepareLocalTargets(targets);
    expect(locations[0]).toEqual(locations[1]);
    expect(locations[0].workspaceId).toBe(locations[2].workspaceId);
    expect(locations[0].instanceId).not.toBe(locations[2].instanceId);
    expect(locations[0].workspaceId).not.toBe(locations[3].workspaceId);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toEqual(store.snapshot());
    expect(saved.instances.map((instance) => instance.storageNamespace)).toEqual(['synthetic-provider', 'second-provider']);
    const restarted = new ExecutionNodesStore(directory);
    await restarted.init();
    expect(await restarted.prepareLocalTargets(targets)).toEqual(locations);
    for (const [index, location] of locations.entries()) restarted.requireLocation(location, targets[index].agentId);
  });

  test('serializes concurrent registrations and isolates additional same-type instance homes', async () => {
    const { store } = await fixture();
    const target = [{ agentId: 'synthetic-provider', projectPath: '/synthetic/project' }];
    const [first, duplicate] = await Promise.all([store.prepareLocalTargets(target), store.prepareLocalTargets(target)]);
    expect(first).toEqual(duplicate);
    const [work, personal] = await Promise.all([
      store.addLocalInstance('synthetic-provider', 'Work'), store.addLocalInstance('synthetic-provider', 'Personal'),
    ]);
    expect(work.id).not.toBe(personal.id);
    expect(work.storageNamespace).not.toBe(personal.storageNamespace);
    expect(work.storageNamespace).toBe(`instances/${work.id}`);
    expect(store.snapshot().instances).toHaveLength(3);
    expect(store.snapshot().instances[0].storageNamespace).toBe('synthetic-provider');
  });

  test('preserves pre-rename state and fences post-rename ambiguity without publishing a successful reference', async () => {
    let failure = null;
    const { directory, store, file } = await fixture({ write: async (...args) => {
      if (failure === 'before') throw new AtomicJsonWriteError('synthetic failure', false);
      await writeJsonFileAtomic(...args);
      if (failure === 'after') throw new AtomicJsonWriteError('synthetic uncertainty', true);
    } });
    const original = store.snapshot();
    const targets = [{ agentId: 'synthetic-provider', projectPath: '/synthetic/project' }];
    failure = 'before';
    await expect(store.prepareLocalTargets(targets)).rejects.toThrow('synthetic failure');
    expect(store.snapshot()).toEqual(original);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(original);
    failure = 'after';
    await expect(store.prepareLocalTargets(targets)).rejects.toThrow('synthetic uncertainty');
    const renamed = store.snapshot();
    expect(renamed.instances).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(renamed);
    failure = null;
    await expect(store.prepareLocalTargets(targets)).rejects.toThrow('durability is unknown');
    const restarted = new ExecutionNodesStore(directory);
    expect(await restarted.init()).toEqual(renamed);
    expect((await restarted.prepareLocalTargets(targets))[0].instanceId).toBe(renamed.instances[0].id);
  });

  test('never silently replaces corrupt or quarantined configuration with a new local identity', async () => {
    const { directory, file } = await fixture();
    await writeFile(file, '{malformed');
    await expect(new ExecutionNodesStore(directory).init()).rejects.toThrow('corrupt');
    await expect(new ExecutionNodesStore(directory).init()).rejects.toThrow('corrupt');
  });

  test('rejects malformed and dangling location references without local fallback', async () => {
    const { store } = await fixture();
    const [location] = await store.prepareLocalTargets([{ agentId: 'synthetic-provider', projectPath: '/synthetic/project' }]);
    expect(() => store.requireLocation({ ...location, nodeId: 'missing-node' }, 'synthetic-provider')).toThrow();
    expect(() => store.requireLocation(location, 'different-provider')).toThrow();
    for (const mutate of [
      (value) => { value.version = 2; },
      (value) => { value.instances.push(value.instances[0]); },
      (value) => { value.instances[0].nodeId = 'missing-node'; },
      (value) => { value.instances[0].storageNamespace = '../escape'; },
      (value) => { value.workspaces.push(value.workspaces[0]); },
      (value) => { value.localNodeId = 'missing-node'; },
      (value) => { value.credential = 'must-not-appear-in-topology'; },
    ]) {
      const invalid = store.snapshot();
      mutate(invalid);
      expect(parseExecutionNodesSnapshot(invalid)).toBeNull();
    }
  });
});
