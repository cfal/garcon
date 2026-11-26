import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatRegistry, type NewChatRegistryEntry } from '../store.js';
import type { NativeChildObservationOrigin } from '../registry-contracts.js';
import { assertChatExecutable } from '../native-observation.js';

const ID = '1783725900000401';
const SOURCE = '1783725900000400';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

function origin(): NativeChildObservationOrigin {
  return {
    kind: 'native-child', sourceChatId: SOURCE, sourceOwnershipEpoch: 'synthetic-epoch',
    sourceAgentSessionId: 'synthetic-root', parentKey: null, reportedModel: null,
    child: { ownerId: 'claude', schemaVersion: 1, key: 'synthetic-child', value: { root: 'synthetic-root' } },
  };
}

function entry(): NewChatRegistryEntry {
  return {
    id: ID, agentId: 'claude', model: 'synthetic-model', projectPath: '/synthetic',
    nativeObservation: origin(), parentChatId: SOURCE, lineage: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] },
  };
}

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-observer-registry-'));
  directories.push(directory);
  const registry = new ChatRegistry(directory);
  await registry.init();
  return { registry, directory };
}

describe('native child registry provenance', () => {
  it('persists an inert origin and clones references on both boundaries', async () => {
    const { registry, directory } = await setup();
    const input = entry();
    registry.addChat(input);
    Object.assign(input.nativeObservation!.child.value, { root: 'mutated' });
    const stored = registry.getChat(ID)!;
    Object.assign(stored.nativeObservation!.child.value, { root: 'mutated-again' });
    expect(registry.getChat(ID)!.nativeObservation!.child.value.root).toBe('synthetic-root');
    expect(stored.agentSessionId).toBeNull();
    expect(() => assertChatExecutable(stored)).toThrow('read-only');
    registry.updateChat(ID, { tags: ['observed'] });
    await registry.flush();
    const reopened = new ChatRegistry(directory);
    await reopened.init();
    expect(reopened.getChat(ID)!.nativeObservation).toEqual(origin());
    expect(reopened.getChat(ID)!.tags).toEqual(['observed']);
  });

  it('rejects generic provenance patches and all execution-field changes without mutation', async () => {
    const { registry } = await setup();
    registry.addChat(entry());
    const before = registry.getChat(ID);
    expect(() => registry.updateChat(ID, { tags: [], ...{ nativeObservation: null } })).toThrow('creation-only');
    expect(() => registry.updateChat(ID, { model: 'other' })).toThrow('read-only');
    await expect(registry.updateChatPhased(ID, { agentSessionId: 'native' })).rejects.toThrow('read-only');
    await expect(registry.installAgentOwnership(ID, { projectPath: '/other', patch: {} })).rejects.toThrow('read-only');
    expect(registry.getChat(ID)).toEqual(before);
    await registry.flush();
  });

  it('rejects executable bindings at creation', async () => {
    const { registry } = await setup();
    expect(() => registry.addChat({ ...entry(), agentSessionId: 'native' })).toThrow('execution bindings');
    expect(() => registry.addChat({ ...entry(), preambleSelection: { revision: 1, orderedPreambleIds: [] } })).toThrow('execution bindings');
    expect(registry.hasChat(ID)).toBe(false);
  });

  it('requires an explicit schema-7 discriminator on disk', async () => {
    const { registry, directory } = await setup();
    registry.addChat(entry());
    await registry.flush();
    const file = path.join(directory, 'chats.json');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    delete saved.sessions[ID].nativeObservation;
    await fs.writeFile(file, JSON.stringify(saved));
    await expect(new ChatRegistry(directory).init()).rejects.toThrow('Missing nativeObservation');
  });
});
