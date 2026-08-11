import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionV4,
  AgentIntegrationError,
  AgentStartedSession,
  AgentTranscriptSourceIdentity,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import { messageSource, nativeAlias } from '../transcript-projection/seed-entries.js';

export interface AgentProjectionProducerMessage {
  readonly message: ChatMessage;
  readonly source: AgentTranscriptSourceIdentity;
  readonly nativeAlias: JsonObject | null;
}

export type AgentProjectionProducerEvent =
  | {
      readonly type: 'messages';
      readonly chatId: string;
      readonly messages: readonly AgentProjectionProducerMessage[];
      readonly operation: AgentTurnOwnerOperationIdentityV4;
    }
  | {
      readonly type: 'processing';
      readonly chatId: string;
      readonly processing: boolean;
      readonly operation: AgentTurnOwnerOperationIdentityV4;
    }
  | {
      readonly type: 'session-created';
      readonly chatId: string;
      readonly session: AgentStartedSession;
      readonly operation: AgentTurnOwnerOperationIdentityV4;
    }
  | {
      readonly type: 'finished';
      readonly chatId: string;
      readonly exitCode: number;
      readonly operation: AgentTurnOwnerOperationIdentityV4;
    }
  | {
      readonly type: 'failed';
      readonly chatId: string;
      readonly error: AgentIntegrationError;
      readonly operation: AgentTurnOwnerOperationIdentityV4;
    };

export interface AgentProjectionRuntimeExecution extends AgentExecutionV4 {
  subscribeProjectionEvents(
    listener: (event: AgentProjectionProducerEvent) => void,
  ): () => void;
}

export class AgentProjectionProducerEventChannel {
  readonly #listeners = new Set<(event: AgentProjectionProducerEvent) => void>();

  subscribe(listener: (event: AgentProjectionProducerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AgentProjectionProducerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export function projectionProducerMessages(
  ownerId: string,
  messages: readonly ChatMessage[],
  sourceNamespace?: string,
): readonly AgentProjectionProducerMessage[] {
  const batchId = randomUUID();
  return messages.map((message, index) => ({
    message,
    source: messageSource(ownerId, sourceNamespace, message, index, batchId),
    nativeAlias: nativeAlias(message),
  }));
}
