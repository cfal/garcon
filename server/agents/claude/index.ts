import crypto from 'crypto';
import { promises as fs } from 'fs';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude, type ClaudeCliRuntime } from './claude-cli.js';
import type {
  AgentSessionSettingsPatch,
  ClaudeStartSessionRequest,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
} from '../session-types.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import { loadClaudeChatMessages, getClaudePreviewFromNativePath } from './history-loader.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { Agent, AgentRuntime } from '../types.js';
import { buildClaudeEndpointRuntime } from './endpoint-runtime.js';

interface ClaudeAgentRuntime extends AgentRuntime {
  updateSessionSettings(agentSessionId: string, patch: AgentSessionSettingsPatch): void;
}

function createClaudeRuntime(claude: ClaudeCliRuntime): ClaudeAgentRuntime {
  return {
    async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
      const agentSessionId = crypto.randomUUID();
      const nativePath = await createClaudeNativePath(request.projectPath, agentSessionId);
      const claudeRequest: ClaudeStartSessionRequest = { ...request, agentSessionId };
      claude.startClaudeCliSession(claudeRequest).catch((error: Error) => {
        console.error(`agents: claude start failed for chat ${request.chatId}:`, error.message);
      });
      return { agentSessionId, nativePath };
    },
    runTurn(request: ResumeTurnRequest) {
      return claude.runClaudeTurn(request);
    },
    abort(agentSessionId: string) {
      return claude.abortClaudeInternalSession(agentSessionId);
    },
    isRunning(agentSessionId: string) {
      return claude.isClaudeInternalSessionRunning(agentSessionId);
    },
    getRunningSessions() {
      return claude.getRunningClaudeInternalSessions();
    },
    resolvePermission(permissionRequestId, decision) {
      claude.resolveInternalToolApproval(permissionRequestId, decision);
    },
    startPurgeTimer() {
      return claude.startPurgeTimer();
    },
    onMessages(cb) { claude.onMessages(cb); },
    onProcessing(cb) { claude.onProcessing(cb); },
    onSessionCreated(cb) { claude.onSessionCreated(cb); },
    onFinished(cb) { claude.onFinished(cb); },
    onFailed(cb) { claude.onFailed(cb); },
    updateSessionSettings(agentSessionId, patch) {
      if (patch.permissionMode !== undefined) claude.setInternalPermissionMode(agentSessionId, patch.permissionMode);
      if (patch.thinkingMode !== undefined) claude.setInternalThinkingMode(agentSessionId, patch.thinkingMode);
      if (patch.claudeThinkingMode !== undefined) claude.setInternalClaudeThinkingMode(agentSessionId, patch.claudeThinkingMode);
    },
  };
}

export function createClaudeAgent(claude: ClaudeCliRuntime): Agent {
  return {
    id: 'claude',
    label: 'Claude',
    runtime: createClaudeRuntime(claude),
    transcript: {
      async loadMessages(session): Promise<ChatMessage[]> {
        const nativePath = session.nativePath
          ?? (session.agentSessionId
            ? await createClaudeNativePath(session.projectPath, session.agentSessionId)
            : null);
        if (!nativePath) return [];
        return loadClaudeChatMessages(nativePath) as Promise<ChatMessage[]>;
      },
      async getPreview(session) {
        const nativePath = session.nativePath
          ?? (session.agentSessionId
            ? await createClaudeNativePath(session.projectPath, session.agentSessionId)
            : null);
        if (!nativePath) return null;
        return getClaudePreviewFromNativePath(nativePath);
      },
      async resolveNativePath(session) {
        if (!session.agentSessionId) return null;
        const candidate = await createClaudeNativePath(session.projectPath, session.agentSessionId);
        if (!candidate) return null;
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          return null;
        }
      },
    },
    auth: {
      getAuthStatus: () => getClaudeAuthStatus(),
      launchLogin: () => launchAgentAuthLogin('claude'),
    },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['anthropic-messages'],
      authLoginSupported: true,
    }),
    prepareEndpointRuntime: buildClaudeEndpointRuntime,
    runSingleQuery: runSingleQueryClaude,
  };
}
