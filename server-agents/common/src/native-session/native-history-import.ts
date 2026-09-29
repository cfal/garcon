import {
  AgentIntegrationError,
  type AgentHistoryImport,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from './evidence-source.js';
import { providerMetadata } from './provider-metadata.js';

// Bounds each batch's conversion here and downstream, and lets reload report
// progress while it reads, instead of handing over a whole history at once.
const IMPORT_BATCH_ROWS = 256;

export function createHistoryImport(
  source: Pick<AgentNativeEvidenceSource, 'load'>,
): AgentHistoryImport {
  return {
    async *load(request) {
      const { messages } = await source.load(request);
      for (let start = 0; start < messages.length; start += IMPORT_BATCH_ROWS) {
        yield messages.slice(start, start + IMPORT_BATCH_ROWS).map((message) => {
          const metadata = providerMetadata(message);
          return {
            message,
            ...(metadata ? { providerMeta: metadata } : {}),
          };
        });
      }
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
