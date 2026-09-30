import { createLogger } from '../../common/log.ts';
import { PromiseTimeoutError, withPromiseTimeout } from '../../common/promise-timeout.ts';
import type { FileMentionResolverDep } from './command-support.ts';

const logger = createLogger('commands:steer');
const STEER_FILE_CONTEXT_TIMEOUT_MS = 2_000;
const STEER_FILE_CONTEXT_IN_FLIGHT_LIMIT = 8;

interface SteerFileContextInput {
  chatId: string;
  clientRequestId: string;
  content: string;
  projectPath?: string;
  executorId?: string | null;
}

// Resolves the file mentions in steering input. A steer goes to a turn that is already
// running, so a slow resolution, a chat that already has one in flight, or a full budget
// sends the input as typed.
export class SteerFileContext {
  readonly #resolutions = new Map<string, Promise<string>>();

  constructor(private readonly fileMentions: FileMentionResolverDep) {}

  // A steer that can wait in the queue is kept even when resolution fails, as while its
  // executor is unavailable, because queued delivery resolves its file context again.
  async resolveOrTyped(input: SteerFileContextInput): Promise<string> {
    try {
      return await this.resolve(input);
    } catch (error) {
      logger.warn('steer file context failed', {
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return input.content;
    }
  }

  async resolve(input: SteerFileContextInput): Promise<string> {
    if (!input.projectPath) return input.content;
    if (
      this.#resolutions.has(input.chatId)
      || this.#resolutions.size >= STEER_FILE_CONTEXT_IN_FLIGHT_LIMIT
    ) {
      return input.content;
    }

    const cancellation = new AbortController();
    const resolution = this.fileMentions.resolve(input.content, input.projectPath, input.executorId, {
      signal: cancellation.signal,
    });
    this.#resolutions.set(input.chatId, resolution);
    const clearResolution = () => {
      if (this.#resolutions.get(input.chatId) === resolution) {
        this.#resolutions.delete(input.chatId);
      }
    };
    void resolution.then(clearResolution, clearResolution);

    try {
      return await withPromiseTimeout(
        resolution,
        STEER_FILE_CONTEXT_TIMEOUT_MS,
        'Steering file-context preparation',
      );
    } catch (error) {
      if (!(error instanceof PromiseTimeoutError)) throw error;
      cancellation.abort();
      logger.warn('steer file context timed out', {
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
      });
      return input.content;
    }
  }
}

// Resolves a queued steer's file context when it is delivered, against its chat's current
// project and executor.
export function queuedSteerContentResolver(
  fileMentions: FileMentionResolverDep,
  chats: { getChat(chatId: string): { projectPath?: string; executorId?: string | null } | null },
): (input: { chatId: string; clientRequestId: string; content: string }) => Promise<string> {
  const context = new SteerFileContext(fileMentions);
  return (input) => {
    const chat = chats.getChat(input.chatId);
    return context.resolve({ ...input, projectPath: chat?.projectPath, executorId: chat?.executorId });
  };
}
