import { constants, promises as fs } from 'fs';
import type { AgentId } from '../../../common/agents.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import { endpointSupportsAgent } from '../../../common/model-routing.js';
import type { ApiProviderReader } from '../../api-providers/read-model.js';
import type { StoredApiProviderEndpoint } from '../../api-providers/store.js';
import { getArtificialAgentSessionId } from '../../chats/artificial-native-path.js';
import { hasNodeErrorCode } from '../../lib/errors.js';
import type { AgentChatEntry } from '../session-types.js';
import type { AgentTranscriptSource } from '../types.js';
import {
  getDirectCompatiblePreviewFromSessionId,
  loadDirectCompatibleChatMessages,
} from './history-loader.js';
import { isSafeDirectPathSegment } from './session-paths.js';

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
      isValidSessionId: isSafeDirectPathSegment,
      sessionLabel: config.sessionLabel,
    });
  }

  async function resolvePath(session: AgentChatEntry): Promise<string | null> {
    const sessionId = getDirectSessionId(session, config.agentId);
    if (!sessionId) return null;
    for (const endpointId of getEndpointCandidates(session, config)) {
      const resolved = await existingPath(config.getSessionFilePath(endpointId, sessionId));
      if (resolved) return resolved;
    }
    return null;
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
      return resolvePath(session);
    },
    async resolveSearchLoadPlan(session) {
      const nativePath = await resolvePath(session);
      if (!nativePath) return { kind: 'live-only', reasonCode: 'source-unavailable', retryable: true };
      return { kind: 'detached', source: { kind: 'direct-jsonl', nativePath } };
    },
  };
}

function getDirectSessionId(session: AgentChatEntry, agentId: AgentId): string | null {
  const directId = typeof session.agentSessionId === 'string' ? session.agentSessionId.trim() : '';
  if (isSafeDirectPathSegment(directId)) return directId;

  const artificialId = getArtificialAgentSessionId(session.nativePath, agentId);
  return isSafeDirectPathSegment(artificialId) ? artificialId : null;
}

function getEndpointCandidates(
  session: AgentChatEntry,
  config: DirectCompatibleTranscriptSourceConfig,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (endpointId: string | null | undefined) => {
    const id = typeof endpointId === 'string' ? endpointId.trim() : '';
    if (!isSafeDirectPathSegment(id) || seen.has(id)) return;
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

async function existingPath(candidate: string): Promise<string | null> {
  try {
    await fs.access(candidate, constants.F_OK);
    return candidate;
  } catch (error: unknown) {
    if (hasNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}
