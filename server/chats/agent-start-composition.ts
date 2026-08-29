import { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import type { AgentStartRequestSink } from '../ledger/garcon-command-publication.js';
import {
  AgentStartController,
  type AgentStartControllerOptions,
  type AgentStartRequest,
} from './agent-start-controller.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agent-starts');

type AgentStartCompositionOptions = Omit<
  AgentStartControllerOptions,
  'selection' | 'batchLock' | 'onDisposition' | 'onError'
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
      onDisposition(event) {
        logger.debug('Agent start batch disposition', event);
      },
      onError(error, context) {
        logger.warn('Agent start batch failed', {
          ...context,
          errorCode: structuredErrorCode(error),
        });
      },
    });
  }
}

function structuredErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}
