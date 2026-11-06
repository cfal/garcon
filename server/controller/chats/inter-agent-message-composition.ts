import { diagnosticErrorCode } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import type { InterAgentMessageRequestSink } from '../ledger/garcon-command-publication.js';
import { denyInBandCommand } from './in-band-command-policy.js';
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
  #options: InterAgentMessageCompositionOptions | null = null;

  request(input: InterAgentMessageRequest): void {
    if (!this.#controller) {
      throw new Error('Inter-agent message controller is not initialized');
    }
    const options = this.#options!;
    if (denyInBandCommand({ chatId: input.sourceChatId, viewId: input.sourceViewId }, options.registry, options.notices)) return;
    this.#controller.request(input);
  }

  discardSource(chatId: string): void {
    this.#controller?.discardSource(chatId);
  }

  initialize(options: InterAgentMessageCompositionOptions): void {
    if (this.#controller) throw new Error('Inter-agent message controller is already initialized');
    this.#options = options;
    const controller = new InterAgentMessageController({
      ...options,
      onDisposition(event) {
        logger.debug('Inter-agent message recipient disposition', event);
      },
      onError(error, context) {
        logger.warn('Inter-agent message routing failed', {
          ...context,
          errorCode: diagnosticErrorCode(error),
        });
      },
    });
    this.#controller = controller;
  }
}
