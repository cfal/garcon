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
    registry: Pick<IChatRegistry, 'getChat' | 'updateObservedProjectPath'>;
    ledger: Pick<TranscriptLedgerService, 'existingCurrentView' | 'appendNotice'>;
    inspect: ProjectInspector;
    lock: KeyedPromiseLock;
  }) {}

  async settle(chatId: string, turn: TurnEventMetadata, isCurrent: () => boolean): Promise<WorkingDirectorySettlement> {
    const snapshot = turn.executionSnapshot;
    const observed = turn.workingDirectory;
    if (!snapshot || observed?.kind !== 'reported') return { kind: 'settled' };
    const ownsSnapshot = () => {
      const chat = this.deps.registry.getChat(chatId);
      return isCurrent() && chat && !snapshot.producerLease.closed
        && chat.agentId === snapshot.agentId && effectiveExecutorId(chat.executorId) === snapshot.executorId
        && chat.agentOwnershipEpoch === turn.agentOwnershipEpoch
        && this.deps.ledger.existingCurrentView(chatId)?.viewId === snapshot.transcriptViewId;
    };
    const current = () => ownsSnapshot()
      && this.deps.registry.getChat(chatId)?.projectPath === snapshot.projectPath;
    return this.deps.lock.runExclusive(`chat:${chatId}`, async () => {
      if (!current()) return { kind: 'settled' };
      let failure: string | undefined;
      try {
        const resolution = await this.deps.inspect(observed.path, snapshot.executorId, {
          signal: AbortSignal.timeout(5000), timeoutMs: 5000,
        });
        if (!current()) return { kind: 'settled' };
        if (resolution.kind === 'unavailable') {
          failure = `Command completed, but its working directory is unavailable (${resolution.reason}).`;
        } else if (resolution.effectiveProjectKey !== snapshot.projectPath) {
          const persisted = await this.deps.registry.updateObservedProjectPath(chatId, {
            chatId, projectPath: resolution.effectiveProjectKey, effectiveProjectKey: resolution.effectiveProjectKey,
            previousProjectPath: snapshot.projectPath,
          });
          if (!persisted || persisted.durability !== 'durable') {
            failure = 'Command completed, but its working directory save could not be confirmed.';
          }
        }
      } catch (error) {
        if (!current()) return { kind: 'settled' };
        failure = `Command completed, but its working directory could not be synchronized: ${String(error)}`;
      }
      if (failure === undefined) return { kind: 'settled' };
      // An uncertain save can change the live path without changing the owning turn or view.
      if (ownsSnapshot()) {
        const view = this.deps.ledger.existingCurrentView(chatId)!;
        this.deps.ledger.appendNotice(chatId, view.viewId, { title: 'Working directory not saved', content: failure });
      }
      return { kind: 'failed', message: failure };
    });
  }
}
