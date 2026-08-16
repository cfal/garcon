import {
  AgentIntegrationError,
  type AgentHistoryImport,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from './evidence-source.js';
import { providerMetadata } from './provider-metadata.js';

export function createHistoryImport(
  source: Pick<AgentNativeEvidenceSource, 'load'>,
): AgentHistoryImport {
  return {
    async *load(request) {
      const snapshot = await source.load(request);
      yield snapshot.messages.map((message) => {
        const metadata = providerMetadata(message);
        return {
          message,
          ...(metadata ? { providerMeta: metadata } : {}),
        };
      });
    },
  };
}

export function createNativeHistoryImport(
  source: Pick<AgentNativeEvidenceSource, 'load'>,
): AgentHistoryImport {
  const importer = createHistoryImport(source);
  return {
    async *load(request) {
      if (!request.chat.agentSessionId && !request.chat.nativeSession) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'Native history import requires a selected session',
          false,
        );
      }
      yield* importer.load(request);
    },
  };
}
