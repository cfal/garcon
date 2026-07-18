import crypto from 'crypto';
import { promises as fs } from 'fs';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude, type ClaudeCliRuntime } from './claude-cli.js';
import {
  executionEventMetadata,
  type AgentSessionSettingsPatch,
  type ClaudeStartSessionRequest,
  type ResumeTurnRequest,
  type StartSessionRequest,
  type StartedAgentSession,
} from '../session-types.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { completeAgentAuthLogin, getAgentAuthLoginStatus, launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import { loadClaudeChatMessages, getClaudePreviewFromNativePath, loadClaudeChatMessagePage } from './history-loader.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { Agent, AgentRuntime } from '../types.js';
import { buildClaudeEndpointRuntime } from './endpoint-runtime.js';
import { getClaudeSlashCommands } from './slash-command-discovery.js';
import { createLogger } from '../../lib/log.js';
import { rewriteClaudeForkTranscriptEntry } from './fork-transcript.js';

const logger = createLogger('agents:claude');

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
        logger.error(`agents: claude start failed for chat ${request.chatId}:`, error.message);
        claude.failClaudeInternalSession(
          agentSessionId,
          request.chatId,
          error.message,
          executionEventMetadata(request, 'chat-start'),
        );
      });
      return { agentSessionId, nativePath };
    },
    runTurn(request: ResumeTurnRequest) {
      return claude.runClaudeTurn(request);
    },
    prepareProjectPathUpdate(request) {
      return claude.prepareClaudeProjectPathUpdate(request);
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
    shutdown() {
      claude.shutdown();
    },
    startPurgeTimer() {
      claude.startPurgeTimer();
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
      async loadMessagePage(session, page) {
        const nativePath = session.nativePath
          ?? (session.agentSessionId
            ? await createClaudeNativePath(session.projectPath, session.agentSessionId)
            : null);
        if (!nativePath) return null;
        return loadClaudeChatMessagePage(nativePath, page.limit, page.offset);
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
      async resolveSearchLoadPlan(session) {
        const nativePath = session.nativePath
          ?? (session.agentSessionId
            ? await createClaudeNativePath(session.projectPath, session.agentSessionId)
            : null);
        if (!nativePath) return { kind: 'live-only', reasonCode: 'source-unavailable', retryable: true };
        return { kind: 'detached', source: { kind: 'claude-jsonl', nativePath } };
      },
      rewriteForkTranscriptEntry: rewriteClaudeForkTranscriptEntry,
    },
    auth: {
      getAuthStatus: () => getClaudeAuthStatus(),
      launchLogin: () => launchAgentAuthLogin('claude'),
      completeLogin: (sessionId, code) => completeAgentAuthLogin('claude', sessionId, code),
      loginStatus: (expectedSessionId) => getAgentAuthLoginStatus('claude', expectedSessionId),
    },
    capabilities: createAgentCapabilities({
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: true,
      supportsUpdateProjectPath: true,
      supportsImages: true,
      acceptsApiProviderEndpoints: true,
      supportedProtocols: ['anthropic-messages'],
      authLoginSupported: true,
    }),
    prepareEndpointRuntime: buildClaudeEndpointRuntime,
    runSingleQuery: runSingleQueryClaude,
    discoverSlashCommands: (projectPath) => getClaudeSlashCommands(projectPath),
  };
}
