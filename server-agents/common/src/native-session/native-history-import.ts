import type { AgentNativeHistoryImport } from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from './evidence-source.js';
import { providerMetadata } from './provider-metadata.js';

export function createNativeHistoryImport(
  source: Pick<AgentNativeEvidenceSource, 'load'>,
): AgentNativeHistoryImport {
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
