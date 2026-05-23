import crypto from 'crypto';
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '../../../common/chat-modes.js';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude, type ClaudeProvider } from './claude-cli.js';
import type { ClaudeStartSessionRequest, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '../session-types.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { launchAgentAuthLogin } from '../auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent, AgentRuntime } from '../types.js';

interface ClaudeAgentRuntime extends AgentRuntime {
  setInternalPermissionMode(agentSessionId: string, mode: PermissionMode): void;
  setInternalThinkingMode(agentSessionId: string, mode: ThinkingMode): void;
  setInternalClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void;
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
    setInternalPermissionMode(agentSessionId, mode) {
      claude.setInternalPermissionMode(agentSessionId, mode);
    },
    setInternalThinkingMode(agentSessionId, mode) {
      claude.setInternalThinkingMode(agentSessionId, mode);
    },
    setInternalClaudeThinkingMode(agentSessionId, mode) {
      claude.setInternalClaudeThinkingMode(agentSessionId, mode);
    },
  };
}

export function createClaudeAgent(claude: ClaudeProvider): Agent {
  return {
    id: 'claude',
    label: 'Claude',
    runtime: createClaudeRuntime(claude),
    transcript: EMPTY_TRANSCRIPT_SOURCE,
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
