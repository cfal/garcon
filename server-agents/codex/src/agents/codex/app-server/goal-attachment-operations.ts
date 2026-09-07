import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { AgentLogger } from '@garcon/server-agent-interface';

import type { CodexAppServerClient } from './client.js';
import { cleanupOwnedGoalAttachments, materializeGoalDraft } from './goal-files.js';
import { recoverGoalDraftAfterError } from './goal-recovery.js';
import type { ThreadGoalSetResponse } from './protocol.js';

export interface GoalAttachmentOperationsOptions {
  codexHome: string | null;
  threadId: string;
  cleanup?: typeof cleanupOwnedGoalAttachments;
  logger: AgentLogger;
  chatId: string;
  queue?: GoalAttachmentOperationQueue;
}

export class GoalAttachmentOperationQueue {
  #chains = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#chains.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#chains.set(key, settled);
    void settled.then(() => {
      if (this.#chains.get(key) === settled) this.#chains.delete(key);
    });
    return result;
  }
}

export class GoalAttachmentOperations {
  #codexHome: string | null;
  #threadId: string;
  #cleanupOwned: typeof cleanupOwnedGoalAttachments;
  #onCleanupError: (error: unknown) => void;
  #queue: GoalAttachmentOperationQueue;

  constructor(options: GoalAttachmentOperationsOptions) {
    this.#codexHome = options.codexHome;
    this.#threadId = options.threadId;
    this.#cleanupOwned = options.cleanup ?? cleanupOwnedGoalAttachments;
    this.#onCleanupError = (error) => options.logger.warn('Codex goal attachment cleanup failed', {
      chatId: options.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    this.#queue = options.queue ?? new GoalAttachmentOperationQueue();
  }

  set(
    client: CodexAppServerClient,
    objective: string,
    attachments: readonly AgentAttachment[] | undefined,
    deliver: (materializedObjective: string) => Promise<ThreadGoalSetResponse>,
  ): Promise<ThreadGoalSetResponse> {
    return this.#run(async () => {
      const draft = await materializeGoalDraft(this.#codexHome, this.#threadId, objective, attachments);
      let response: ThreadGoalSetResponse;
      try {
        response = await deliver(draft.objective);
      } catch (error) {
        response = await recoverGoalDraftAfterError(
          client,
          this.#threadId,
          draft,
          error,
          this.#onCleanupError,
        );
      }
      await this.#cleanup(draft.outputDir);
      return response;
    });
  }

  clear(deliver: () => Promise<{ cleared: boolean }>): Promise<{ cleared: boolean }> {
    return this.#run(async () => {
      const response = await deliver();
      if (response.cleared) await this.#cleanup(null);
      return response;
    });
  }

  queueClear(): void {
    void this.#run(() => this.#cleanup(null));
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#queue.run(JSON.stringify([this.#codexHome, this.#threadId]), operation);
  }

  async #cleanup(keepOutputDir: string | null): Promise<void> {
    try {
      await this.#cleanupOwned(this.#codexHome, this.#threadId, keepOutputDir);
    } catch (error) {
      this.#onCleanupError(error);
    }
  }
}
