import { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import { diagnosticErrorCode } from '../lib/errors.js';
import { createLogger } from '../lib/log.js';
import type { AgentStartRequestSink } from '../ledger/garcon-command-publication.js';
import {
  AgentStartController,
  type AgentStartControllerOptions,
  type AgentStartRequest,
} from './agent-start-controller.js';

const logger = createLogger('agent-starts');

type AgentStartCompositionOptions = Omit<
  AgentStartControllerOptions,
  'selection' | 'batchLock' | 'onDiagnostic' | 'onError'
> & {
  readonly selection: ConstructorParameters<typeof AgentStartSelectionService>[0];
};

export class AgentStartComposition implements AgentStartRequestSink {
  #controller: AgentStartController | null = null;

  request(input: AgentStartRequest): void {
    if (!this.#controller) throw new Error('Agent start controller is not initialized');
    this.#controller.request(input);
  }

  discardSource(chatId: string): void {
    this.#controller?.discardSource(chatId);
  }

  beginShutdown(): void {
    this.#controller?.beginShutdown();
  }

  async waitForIdle(): Promise<void> {
    await this.#controller?.waitForIdle();
  }

  initialize(options: AgentStartCompositionOptions): void {
    if (this.#controller) throw new Error('Agent start controller is already initialized');
    this.#controller = new AgentStartController({
      ...options,
      selection: new AgentStartSelectionService(options.selection),
      onDiagnostic(event) {
        logger.debug('Agent start event', event);
      },
      onError(error, context) {
        logger.warn('Agent start batch failed', {
          ...context,
          errorCode: diagnosticErrorCode(error),
        });
      },
    });
  }
}
