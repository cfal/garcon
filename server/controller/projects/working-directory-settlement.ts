import type { ProjectInspector } from '../../../common/project-resolution.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { IChatRegistry } from '../chats/store.js';
import type { TurnEventMetadata } from '../agents/event-bus.js';
import type { TranscriptLedgerService } from '../ledger/service.js';

export type WorkingDirectorySettlement = { readonly kind: 'settled' } | { readonly kind: 'failed'; readonly message: string };
export interface WorkingDirectorySettlementPort {
  settle(chatId: string, turn: TurnEventMetadata, isCurrent: () => boolean): Promise<WorkingDirectorySettlement>;
}

export class WorkingDirectorySettler implements WorkingDirectorySettlementPort {
  constructor(private readonly deps: {
    registry: Pick<IChatRegistry, 'getChat' | 'updateProjectPath'>;
    ledger: Pick<TranscriptLedgerService, 'existingCurrentView'>;
    inspect: ProjectInspector;
    lock: KeyedPromiseLock;
  }) {}

  async settle(chatId: string, turn: TurnEventMetadata, isCurrent: () => boolean): Promise<WorkingDirectorySettlement> {
    const snapshot = turn.executionSnapshot;
    const observed = turn.workingDirectory;
    if (!snapshot || observed?.kind !== 'reported') return { kind: 'settled' };
    const current = () => {
      const chat = this.deps.registry.getChat(chatId);
      return isCurrent() && chat && !snapshot.producerLease.closed
        && chat.agentId === snapshot.agentId && effectiveExecutorId(chat.executorId) === snapshot.executorId
        && chat.agentOwnershipEpoch === turn.agentOwnershipEpoch && chat.projectPath === snapshot.projectPath
        && this.deps.ledger.existingCurrentView(chatId)?.viewId === snapshot.transcriptViewId;
    };
    return this.deps.lock.runExclusive(`chat:${chatId}`, async () => {
      if (!current()) return { kind: 'settled' };
      try {
        const resolution = await this.deps.inspect(observed.path, snapshot.executorId, {
          signal: AbortSignal.timeout(5000), timeoutMs: 5000,
        });
        if (!current()) return { kind: 'settled' };
        if (resolution.kind === 'unavailable') return {
          kind: 'failed', message: `Command completed, but its working directory is unavailable (${resolution.reason}).`,
        };
        if (resolution.effectiveProjectKey !== snapshot.projectPath) {
          await this.deps.registry.updateProjectPath(chatId, {
            chatId, projectPath: resolution.effectiveProjectKey, effectiveProjectKey: resolution.effectiveProjectKey,
            previousProjectPath: snapshot.projectPath,
          }, { flush: true });
        }
        return { kind: 'settled' };
      } catch (error) {
        return current()
          ? { kind: 'failed', message: `Command completed, but its working directory could not be synchronized: ${String(error)}` }
          : { kind: 'settled' };
      }
    });
  }
}
