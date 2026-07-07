import type { AgentId } from '../../../common/agents.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import { endpointSupportsAgent } from '../../../common/model-routing.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import type { StoredApiProviderEndpoint } from '../../api-providers/store.js';
import {
  createArtificialNativePath,
  getArtificialAgentSessionId,
} from '../../chats/artificial-native-path.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';
import {
  getDirectCompatiblePreviewFromSessionId,
  loadDirectCompatibleChatMessages,
} from './history-loader.js';

const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface DirectCompatibleTranscriptSourceConfig {
  agentId: AgentId;
  protocol: ApiProtocol;
  sessionLabel: string;
  apiProviders: ApiProviderReader;
  getSessionFilePath(endpointId: string, sessionId: string): string;
}

export function createDirectCompatibleTranscriptSource(
  config: DirectCompatibleTranscriptSourceConfig,
): AgentTranscriptSource {
  async function loadForEndpoint(endpointId: string, sessionId: string) {
    return loadDirectCompatibleChatMessages(sessionId, {
      getSessionFilePath: (id) => config.getSessionFilePath(endpointId, id),
      isValidSessionId: isSafePathSegment,
      sessionLabel: config.sessionLabel,
    });
  }

  return {
    async loadMessages(session) {
      const sessionId = getDirectSessionId(session, config.agentId);
      if (!sessionId) return [];

      for (const endpointId of getEndpointCandidates(session, config)) {
        const messages = await loadForEndpoint(endpointId, sessionId);
        if (messages.length > 0) return messages;
      }
      return [];
    },
    async getPreview(session) {
      const sessionId = getDirectSessionId(session, config.agentId);
      if (!sessionId) return null;

      for (const endpointId of getEndpointCandidates(session, config)) {
        const preview = await getDirectCompatiblePreviewFromSessionId(
          sessionId,
          (id) => loadForEndpoint(endpointId, id || ''),
          config.sessionLabel,
        );
        if (preview) return preview;
      }
      return null;
    },
    async resolveNativePath(session) {
      return createArtificialNativePath(config.agentId, getDirectSessionId(session, config.agentId));
    },
  };
}

function getDirectSessionId(session: AgentChatEntry, agentId: AgentId): string | null {
  const directId = typeof session.agentSessionId === 'string' ? session.agentSessionId.trim() : '';
  if (isSafePathSegment(directId)) return directId;

  const artificialId = getArtificialAgentSessionId(session.nativePath, agentId);
  return isSafePathSegment(artificialId) ? artificialId : null;
}

function getEndpointCandidates(
  session: AgentChatEntry,
  config: DirectCompatibleTranscriptSourceConfig,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (endpointId: string | null | undefined) => {
    const id = typeof endpointId === 'string' ? endpointId.trim() : '';
    if (!isSafePathSegment(id) || seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };

  push(session.modelEndpointId);

  const providers = config.apiProviders.list();
  for (const provider of providers) {
    if (session.apiProviderId && provider.id !== session.apiProviderId) continue;
    for (const endpoint of provider.endpoints) {
      if (isMatchingEndpoint(endpoint, config)) push(endpoint.id);
    }
  }
  for (const provider of providers) {
    for (const endpoint of provider.endpoints) {
      if (isMatchingEndpoint(endpoint, config)) push(endpoint.id);
    }
  }

  return candidates;
}

function isMatchingEndpoint(
  endpoint: StoredApiProviderEndpoint,
  config: DirectCompatibleTranscriptSourceConfig,
): boolean {
  return endpoint.protocol === config.protocol && endpointSupportsAgent(config.agentId, endpoint);
}

function isSafePathSegment(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && SAFE_PATH_SEGMENT_RE.test(value)
    && value !== '.'
    && value !== '..';
}
