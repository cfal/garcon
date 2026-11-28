import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatIdAllocator } from '../../../../server/controller/chats/chat-id-allocator.ts';
import { isCarryOverSegmentId } from '../../../../server/controller/chats/carryover/segment-types.ts';
import { normalizeChatRegistryEntry, parseCarryOverSegmentRefs } from '../../../../server/controller/chats/registry-entry-codec.ts';
import { ChatRegistry, type NewChatRegistryEntry } from '../../../../server/controller/chats/store.ts';

export const CHAT_ID = '1783725900000200';
export const OTHER_ID = '1783725900000201';

export function acceptsEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeEntry(raw: Record<string, unknown>) {
  return normalizeChatRegistryEntry(raw, CHAT_ID);
}

export function parseSegments(value: unknown) {
  return parseCarryOverSegmentRefs(value);
}

export function validSegmentId(value: unknown) {
  return isCarryOverSegmentId(value);
}

export function acceptsAllocation(times: unknown) {
  return Array.isArray(times) && times.length <= 20 && times.every((time) =>
    typeof time === 'number' && Number.isSafeInteger(time) && Math.abs(time) <= 9_007_199_254_740);
}

export function acceptsExisting(ids: unknown) {
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string');
}

export function allocateIds(times: number[], ids: string[]) {
  const existing = new Set(ids);
  let index = 0;
  const allocator = new ChatIdAllocator({ hasChat: (id: string) => existing.has(id) }, () => times[index++]!);
  return times.map(() => allocator.allocate());
}

type BoundaryMutation = 'add' | 'live' | 'phased';

export function acceptsBoundaryMutation(value: unknown): value is BoundaryMutation {
  return value === 'add' || value === 'live' || value === 'phased';
}

export function acceptsEpoch(value: unknown): value is string {
  return typeof value === 'string';
}

export async function commitBoundary(mode: BoundaryMutation, ownershipEpoch: string, boundaryEpoch: string) {
  const workspace = await mkdtemp(join(tmpdir(), 'garcon-registry-boundary-'));
  try {
    const registry = new ChatRegistry(workspace);
    await registry.init();
    const entry: NewChatRegistryEntry = { id: CHAT_ID, agentId: 'codex', model: 'fixture', projectPath: '/workspace/project',
      agentOwnershipEpoch: 'epoch-a', preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null };
    const patch = { agentOwnershipEpoch: ownershipEpoch,
      pendingPreambleBoundary: { kind: 'selection-change', ownershipEpoch: boundaryEpoch, selectionRevision: 0 } } as const;
    const file = join(workspace, 'chats.json');
    const bytes = async () => readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (mode !== 'add') {
      registry.addChat(entry);
      await registry.flush();
    }
    const before = await bytes();
    const previous = JSON.stringify(registry.getChat(CHAT_ID));
    try {
      if (mode === 'add') registry.addChat({ ...entry, ...patch });
      else if (mode === 'live') registry.updateChat(CHAT_ID, patch);
      else await registry.updateChatPhased(CHAT_ID, patch);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { mutationError: error.message, unchanged: await bytes() === before && JSON.stringify(registry.getChat(CHAT_ID)) === previous };
    }
    await registry.flush();
    const reopened = new ChatRegistry(workspace);
    await reopened.init();
    return { live: registry.getChat(CHAT_ID)?.pendingPreambleBoundary, reopened: reopened.getChat(CHAT_ID)?.pendingPreambleBoundary };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
