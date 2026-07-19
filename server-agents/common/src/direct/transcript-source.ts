import { constants, promises as fs } from 'fs';
import type { AgentId } from '@garcon/common/agents';
import type { ApiProtocol } from '@garcon/common/api-providers';
import type { ApiProviderReader } from '@garcon/server-agent-common/legacy/api-providers';
import type { StoredApiProviderEndpoint } from '@garcon/server-agent-common/legacy/types';
import { getArtificialAgentSessionId } from '@garcon/server-agent-common/chats/artificial-native-path';
import { hasNodeErrorCode } from '@garcon/server-agent-common/lib/errors';
import type { AgentChatEntry } from '@garcon/server-agent-common/legacy/session-types';
import type { AgentTranscriptSource } from '@garcon/server-agent-common/legacy/types';
import {
  getDirectCompatiblePreviewFromSessionId,
  loadDirectCompatibleChatMessages,
} from './history-loader.js';
import { isSafeDirectPathSegment } from './session-paths.js';

export interface DirectCompatibleTranscriptSourceConfig {
  agentId: AgentId;
  protocol: ApiProtocol;
  requiredCapability: 'chatCompletions' | 'responses' | null;
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
    async release(session) {
      const nativePath = await resolvePath(session);
      if (nativePath) await fs.rm(nativePath, { force: true });
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
  return endpoint.protocol === config.protocol
    && (!config.requiredCapability || endpoint.capabilities?.[config.requiredCapability] === true);
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
