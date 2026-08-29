import { createLogger } from '../lib/log.js';
import type { InterAgentMessageRequestSink } from '../ledger/garcon-command-publication.js';
import {
  InterAgentMessageController,
  type InterAgentMessageControllerOptions,
  type InterAgentMessageRequest,
} from './inter-agent-message-controller.js';

const logger = createLogger('inter-agent-messages');

type InterAgentMessageCompositionOptions = Pick<
  InterAgentMessageControllerOptions,
  'registry' | 'adoption' | 'execution' | 'notices' | 'chatMutationLock' | 'isEnabled'
>;

export class InterAgentMessageComposition implements InterAgentMessageRequestSink {
  #controller: InterAgentMessageController | null = null;

  request(input: InterAgentMessageRequest): void {
    if (!this.#controller) {
      throw new Error('Inter-agent message controller is not initialized');
    }
    this.#controller.request(input);
  }

  discardSource(chatId: string): void {
    this.#controller?.discardSource(chatId);
  }

  initialize(options: InterAgentMessageCompositionOptions): void {
    if (this.#controller) throw new Error('Inter-agent message controller is already initialized');
    const controller = new InterAgentMessageController({
      ...options,
      onDisposition(event) {
        logger.debug('Inter-agent message recipient disposition', event);
      },
      onError(error, context) {
        logger.warn('Inter-agent message routing failed', {
          ...context,
          errorCode: structuredErrorCode(error),
        });
      },
    });
    this.#controller = controller;
  }
}

function structuredErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}
