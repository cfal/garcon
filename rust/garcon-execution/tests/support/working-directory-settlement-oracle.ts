import { KeyedPromiseLock } from '../../../../server/common/keyed-lock.ts';
import type { TurnEventMetadata } from '../../../../server/controller/agents/event-bus.ts';
import type { ChatRegistryEntry } from '../../../../server/controller/chats/registry-contracts.ts';
import { transcriptViewId } from '../../../../server/controller/ledger/contracts.ts';
import { WorkingDirectorySettler } from '../../../../server/controller/projects/working-directory-settlement.ts';

const CHAT = '1767225600000000';
const EXECUTOR = '11111111-1111-4111-8111-111111111111';

export async function workingDirectorySettlementTrace(change: string) {
  const calls: unknown[] = [];
  const chat: ChatRegistryEntry = {
    executorId: EXECUTOR, agentId: 'synthetic', agentOwnershipEpoch: change === 'stale' ? 'epoch-2' : 'epoch-1',
    projectPath: '/project', nativeSession: null, agentSettingsById: {}, tags: [], agentSessionId: null,
    model: 'synthetic', permissionMode: 'default', thinkingMode: 'none', carryOverSegments: [],
    nativeSeedReceipt: null, carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
  };
  const lease = { closed: false };
  const at = '2026-01-01T00:00:00.000Z';
  let view = transcriptViewId('view-1');
  let current = true;
  const turn: TurnEventMetadata = {
    agentOwnershipEpoch: 'epoch-1',
    executionSnapshot: {
      agentId: 'synthetic', executorId: EXECUTOR, projectPath: '/project', transcriptViewId: view, producerLease: lease,
    },
    workingDirectory: change === 'not-reported' ? { kind: 'unavailable', reason: 'exit' }
      : { kind: 'reported', path: change === 'unchanged' ? '/project' : '/project/ next\n' },
  };
  const service = new WorkingDirectorySettler({
    lock: new KeyedPromiseLock(),
    registry: {
      getChat: () => chat,
      async updateObservedProjectPath(chatId, update) {
        calls.push(['update', chatId, update]);
        await Promise.resolve();
        switch (change) {
          case 'write-failed': throw new Error('Synthetic disk failure');
          case 'write-unknown': return { entry: { ...chat, id: chatId }, durability: 'unknown', changed: false };
          case 'write-owner': chat.agentOwnershipEpoch = 'epoch-2'; break;
          case 'write-attempt': current = false; break;
          case 'write-lease': lease.closed = true; break;
          case 'write-view': view = transcriptViewId('view-2'); break;
          default: chat.projectPath = update.projectPath;
        }
        return { entry: { ...chat, id: chatId }, durability: change.startsWith('write-') ? 'unknown' : 'durable', changed: true };
      },
    },
    ledger: {
      existingCurrentView: () => ({ viewId: view, status: 'current', createdAt: at, contentStartOrdinal: 1 }),
      appendNotice(chatId, viewId, input) {
        calls.push(['notice', chatId, viewId, input.title, input.content]);
        return { viewId, kind: 'notice', ordinal: 1, at, message: input.content,
          detail: input.title ? { title: input.title } : {}, providerMeta: null };
      },
    },
    async inspect(path, executorId, options) {
      calls.push(['inspect', path, executorId, {
        liveSignal: Boolean(options?.signal && !options.signal.aborted), timeoutMs: options?.timeoutMs,
        dispatchDeadline: options?.dispatchDeadline ?? null,
      }]);
      await Promise.resolve();
      switch (change) {
        case 'inspect-owner': chat.agentOwnershipEpoch = 'epoch-2'; break;
        case 'inspect-path': chat.projectPath = '/replacement'; break;
        case 'inspect-agent': chat.agentId = 'other'; break;
        case 'inspect-executor': chat.executorId = 'local'; break;
        case 'inspect-attempt': current = false; break;
        case 'inspect-lease': lease.closed = true; break;
        case 'inspect-view': view = transcriptViewId('view-2'); break;
        case 'inspect-failed': throw new Error('Synthetic inspection failure');
        case 'unavailable': return { kind: 'unavailable', reason: 'outside-base' };
      }
      return { kind: 'available', effectiveProjectKey: path };
    },
  });
  const result = await service.settle(CHAT, turn, () => current);
  return { result, path: chat.projectPath, calls };
}
