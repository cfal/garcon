import type { ChatMessage } from '../../../../common/chat-types.js';
import { TaskWorker } from '../../lib/task-worker.js';
import type { RenderedHandoffArtifact } from '../handoff-artifact/model.js';
import type {
  CarryoverAssessment,
  CompactionPromptFit,
  CompactionPromptInput,
} from './carryover.js';
import type {
  HandoffArtifactRenderInput,
  TokenFittingResults,
  TokenFittingTask,
} from './tasks.js';

const WORKER_SOURCE_URL = new URL('./worker-main.ts', import.meta.url);

export interface TokenFitting {
  assessCarryover(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarryoverAssessment>;
  fitCompactionPrompt(
    input: CompactionPromptInput,
    signal?: AbortSignal,
  ): Promise<CompactionPromptFit>;
  renderHandoffArtifact(
    input: HandoffArtifactRenderInput,
    signal?: AbortSignal,
  ): Promise<RenderedHandoffArtifact | null>;
}

// Runs token estimation and fitting on a Worker so long transcripts never stall the
// controller's event loop.
export class TokenFittingWorker implements TokenFitting {
  readonly #worker = new TaskWorker<TokenFittingTask, TokenFittingResults>({
    worker: 'token-fitting',
    sourceUrl: WORKER_SOURCE_URL,
    label: 'Token fitting',
  });

  assessCarryover(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CarryoverAssessment> {
    return this.#worker.run({ kind: 'assess-carryover' }, messages, signal);
  }

  fitCompactionPrompt(
    { messages, ...parameters }: CompactionPromptInput,
    signal?: AbortSignal,
  ): Promise<CompactionPromptFit> {
    return this.#worker.run({ kind: 'fit-compaction-prompt', ...parameters }, messages, signal);
  }

  renderHandoffArtifact(
    { rows, ...parameters }: HandoffArtifactRenderInput,
    signal?: AbortSignal,
  ): Promise<RenderedHandoffArtifact | null> {
    return this.#worker.run({ kind: 'render-handoff-artifact', ...parameters }, rows, signal);
  }

  close(): void {
    this.#worker.close();
  }
}
