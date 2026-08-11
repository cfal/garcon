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
import { getNativeMessageRevisionSource } from '@garcon/server-agent-interface';

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
  sourceNamespace = `${ownerId}:native`,
): readonly AgentProjectionProducerMessage[] {
  const batchId = randomUUID();
  return messages.map((message, index) => {
    const native = getNativeMessageRevisionSource(message);
    const itemId = native?.entryId
      ?? (native?.byteOffset !== undefined ? `byte:${native.byteOffset}` : null)
      ?? (native?.lineNumber !== undefined ? `line:${native.lineNumber}` : null)
      ?? `event:${batchId}`;
    return {
      message,
      source: {
        namespace: sourceNamespace,
        itemId,
        subrowId: `row:${native?.withinSourceOrdinal ?? index}`,
      },
      nativeAlias: native ? {
        ...(native.entryId ? { entryId: native.entryId } : {}),
        ...(native.lineNumber !== undefined ? { lineNumber: native.lineNumber } : {}),
        ...(native.byteOffset !== undefined ? { byteOffset: native.byteOffset } : {}),
        ...(native.withinSourceOrdinal !== undefined
          ? { withinSourceOrdinal: native.withinSourceOrdinal }
          : {}),
      } : null,
    };
  });
}
