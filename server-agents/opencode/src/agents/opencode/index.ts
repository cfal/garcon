import type { OpenCodeRuntime } from './opencode.js';
import { getOpenCodeAuthStatus } from './opencode-auth.js';
import type { ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '@garcon/server-agent-common/legacy/session-types';
import { createAgentCapabilities } from '@garcon/server-agent-common/legacy/capabilities';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import {
  getOpenCodePreviewFromSessionId,
  loadOpenCodeChatMessages,
} from './history-loader.js';
import type { Agent, AgentRuntime, AgentTranscriptSource } from '@garcon/server-agent-common/legacy/types';

function createOpenCodeRuntime(opencode: OpenCodeRuntime): AgentRuntime {
  return {
    async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
      const agentSessionId = await opencode.startSession(request);
      return { agentSessionId, nativePath: createArtificialNativePath('opencode', agentSessionId) };
    },
    runTurn(request: ResumeTurnRequest) {
      return opencode.runTurn(request);
    },
    abort(agentSessionId) {
      return opencode.abort(agentSessionId);
    },
    isRunning(agentSessionId) {
      return opencode.isRunning(agentSessionId);
    },
    getRunningSessions() {
      return opencode.getRunningSessions();
    },
    resolvePermission(permissionRequestId, decision) {
      return opencode.resolvePermission(permissionRequestId, decision);
    },
    updateSessionSettings(agentSessionId, patch) {
      opencode.updateSessionSettings(agentSessionId, patch);
    },
    shutdown() {
      opencode.shutdown?.();
    },
    startPurgeTimer() {
      opencode.startPurgeTimer();
    },
    onMessages(cb) { opencode.onMessages(cb); },
    onProcessing(cb) { opencode.onProcessing(cb); },
    onSessionCreated(cb) { opencode.onSessionCreated(cb); },
    onFinished(cb) { opencode.onFinished(cb); },
    onFailed(cb) { opencode.onFailed(cb); },
  };
}

function createOpenCodeTranscriptSource(opencode: OpenCodeRuntime): AgentTranscriptSource {
  return {
    loadMessages(session) {
      return loadOpenCodeChatMessages(session.agentSessionId, () => opencode.getClient(), {
        directory: session.projectPath,
      });
    },
    getPreview(session) {
      return getOpenCodePreviewFromSessionId(session.agentSessionId, () => opencode.getClient(), {
        directory: session.projectPath,
      });
    },
    async resolveNativePath(session) {
      if (!session.agentSessionId) return null;
      return createArtificialNativePath('opencode', session.agentSessionId);
    },
    async resolveSearchLoadPlan(session) {
      if (!session.agentSessionId) {
        return { kind: 'live-only', reasonCode: 'source-unavailable' };
      }
      try {
        const lease = await opencode.acquireSearchServerLease();
        return {
          kind: 'detached',
          source: {
            kind: 'opencode-api',
            baseUrl: lease.baseUrl,
            sessionId: session.agentSessionId,
            directory: session.projectPath,
          },
          release: lease.release,
        };
      } catch {
        return { kind: 'live-only', reasonCode: 'provider-unavailable', retryable: true };
      }
    },
  };
}

export function createOpenCodeAgent(opencode: OpenCodeRuntime): Agent {
  return {
    id: 'opencode',
    label: 'OpenCode',
    runtime: createOpenCodeRuntime(opencode),
    transcript: createOpenCodeTranscriptSource(opencode),
    auth: { getAuthStatus: () => getOpenCodeAuthStatus(opencode) },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: false,
      supportsForkWhileRunning: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: () => opencode.getModels(),
    }),
    async forkSession({ sourceSession }) {
      const sourceSessionId = sourceSession.agentSessionId?.trim();
      if (!sourceSessionId) {
        throw new Error('Cannot fork OpenCode session: missing source session id');
      }
      const agentSessionId = await opencode.forkSession(sourceSessionId, {
        projectPath: sourceSession.projectPath,
      });
      return {
        agentSessionId,
        nativePath: createArtificialNativePath('opencode', agentSessionId),
      };
    },
    runSingleQuery(prompt, options) {
      return opencode.runSingleQuery(prompt, options);
    },
  };
}
