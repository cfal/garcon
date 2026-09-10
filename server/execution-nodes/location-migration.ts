import { parseChatId } from '../../common/chat-id.js';
import { isRecord } from '../../common/json.js';
import { parseExecutionLocation, type ExecutionLocation } from '../../common/execution-location.js';
import { normalizeLegacyChatRegistryEntry } from '../chats/registry-entry-codec.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { ExecutionNodesStore } from './store.js';

export interface LocatedChatRegistrySnapshot {
  readonly version: 6;
  readonly sessions: Record<string, ChatRegistryEntry & { readonly executionLocation: ExecutionLocation }>;
}

/** Prepares durable local identities before the caller atomically replaces the old registry. */
export async function migrateLocalChatLocations(
  raw: unknown,
  locations: ExecutionNodesStore,
): Promise<LocatedChatRegistrySnapshot> {
  if (!isRecord(raw) || raw.version !== 5 || !isRecord(raw.sessions)) {
    throw new Error('Location migration requires a version-5 chat registry');
  }
  const entries = Object.entries(raw.sessions).map(([id, value]) => {
    const chatId = parseChatId(id);
    if (!isRecord(value)) throw new Error(`Invalid chat registry entry for ${chatId}`);
    const entry = structuredClone(normalizeLegacyChatRegistryEntry(value, chatId));
    const location = value.executionLocation === undefined ? null : parseExecutionLocation(value.executionLocation);
    if (value.executionLocation !== undefined && !location) throw new Error(`Invalid execution location for ${chatId}`);
    return { chatId, entry, location };
  });
  const configured = locations.snapshot();
  for (const { chatId, entry, location } of entries) {
    if (!location) continue;
    if (!configured.nodes.some((node) => node.id === location.nodeId)
      || !configured.instances.some((instance) => instance.id === location.instanceId
        && instance.nodeId === location.nodeId && instance.agentId === entry.agentId)
      || !configured.workspaces.some((workspace) => workspace.id === location.workspaceId && workspace.nodeId === location.nodeId)) {
      throw new Error(`Unknown execution location for ${chatId}`);
    }
  }
  const pending = entries.filter((entry) => entry.location === null);
  const prepared = await locations.prepareLocalTargets(pending.map(({ chatId, entry }) => ({ ...entry, chatId })));
  const migrated = new Map(pending.map(({ chatId }, index) => [chatId, prepared[index]!]));
  return {
    version: 6,
    sessions: Object.fromEntries(entries.map(({ chatId, entry, location }) => [
      chatId, { ...entry, executionLocation: location ?? migrated.get(chatId)! },
    ])),
  };
}
