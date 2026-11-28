import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';
import { SettingsStore } from '../../../../server/controller/settings/store.ts';

interface Order {
  readonly pinnedChatIds: readonly string[];
  readonly normalChatIds: readonly string[];
  readonly archivedChatIds: readonly string[];
}

class FixtureRegistry extends ChatRegistry {
  constructor(workspace: string, private readonly ids: readonly string[]) {
    super(workspace);
  }

  override listChatIds(): string[] { return [...this.ids]; }
}

export async function reconcileOrder(order: Order, ids: readonly string[]) {
  const workspace = await mkdtemp(join(tmpdir(), 'garcon-settings-order-'));
  try {
    const store = new SettingsStore(workspace);
    await store.init();
    await store.saveSettings({ ...order, remoteSettingsVersion: 7 });
    const file = join(workspace, 'project-settings.json');
    const before = await readFile(file, 'utf8');
    await store.reconcileWithRegistry(new FixtureRegistry(workspace, ids));
    if (await readFile(file, 'utf8') === before) return null;
    return {
      pinnedChatIds: store.getPinnedChatIds(),
      normalChatIds: store.getNormalChatIds(),
      archivedChatIds: store.getArchivedChatIds(),
      pinnedChanged: store.getRemoteSettingsVersion() !== 7,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [action, workspace] = Bun.argv.slice(2);
  if (!workspace) throw new Error('A workspace directory is required');
  const ids = ['1000000000000001', '1000000000000002', '1000000000000003', '1000000000000004'];
  const [a, b, c] = ids;
  const store = new SettingsStore(workspace);
  await store.init();
  if (action === 'write') {
    await store.saveSettings({
      pinnedChatIds: [a, 'gone', a], normalChatIds: [a, b], archivedChatIds: [b, c, 'gone-archived'],
      remoteSettingsVersion: 7, chatNames: { [a!]: 'Fixture title' },
    });
  } else if (action === 'reconcile') {
    await store.reconcileWithRegistry(new FixtureRegistry(workspace, ids));
  } else {
    throw new Error(`Invalid oracle action: ${action}`);
  }
  console.log(JSON.stringify({
    pinnedChatIds: store.getPinnedChatIds(),
    normalChatIds: store.getNormalChatIds(),
    archivedChatIds: store.getArchivedChatIds(),
    remoteSettingsVersion: store.getRemoteSettingsVersion(),
    title: store.getChatName(a!),
  }));
}
