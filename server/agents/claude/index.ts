import crypto from 'crypto';
import { promises as fs } from 'fs';
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '../../../common/chat-modes.js';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude, type ClaudeProvider } from './claude-cli.js';
import type { ClaudeStartSessionRequest, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '../session-types.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent, AgentRuntime } from '../types.js';

interface ClaudeAgentRuntime extends AgentRuntime {
  setPermissionMode(agentSessionId: string, mode: PermissionMode): void;
  setThinkingMode(agentSessionId: string, mode: ThinkingMode): void;
  setClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void;
}

function createClaudeRuntime(claude: ClaudeProvider): ClaudeAgentRuntime {
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
    setPermissionMode(agentSessionId, mode) {
      claude.setInternalPermissionMode(agentSessionId, mode);
    },
    setThinkingMode(agentSessionId, mode) {
      claude.setInternalThinkingMode(agentSessionId, mode);
    },
    setClaudeThinkingMode(agentSessionId, mode) {
      claude.setInternalClaudeThinkingMode(agentSessionId, mode);
    },
  };
}

export function createClaudeAgent(claude: ClaudeProvider): Agent {
  return {
    id: 'claude',
    label: 'Claude',
    runtime: createClaudeRuntime(claude),
    transcript: {
      ...EMPTY_TRANSCRIPT_SOURCE,
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
    runSingleQuery: runSingleQueryClaude,
  };
}
