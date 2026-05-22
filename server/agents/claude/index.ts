import crypto from 'crypto';
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from '../../../common/chat-modes.js';
import { createClaudeNativePath, runSingleQuery as runSingleQueryClaude, type ClaudeProvider } from '../../providers/claude-cli.js';
import type { ClaudeStartSessionRequest, ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from '../../providers/types.js';
import { getClaudeAuthStatus } from '../../providers/claude-auth.js';
import { launchProviderAuthLogin } from '../../providers/auth-login.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent, AgentRuntime } from '../types.js';

interface ClaudeAgentRuntime extends AgentRuntime {
  setInternalPermissionMode(providerSessionId: string, mode: PermissionMode): void;
  setInternalThinkingMode(providerSessionId: string, mode: ThinkingMode): void;
  setInternalClaudeThinkingMode(providerSessionId: string, mode: ClaudeThinkingMode): void;
}

function createClaudeRuntime(claude: ClaudeProvider): ClaudeAgentRuntime {
  return {
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      const providerSessionId = crypto.randomUUID();
      const nativePath = await createClaudeNativePath(request.projectPath, providerSessionId);
      const claudeRequest: ClaudeStartSessionRequest = { ...request, providerSessionId };
      claude.startClaudeCliSession(claudeRequest).catch((error: Error) => {
        console.error(`agents: claude start failed for chat ${request.chatId}:`, error.message);
      });
      return { providerSessionId, nativePath };
    },
    runTurn(request: ResumeTurnRequest) {
      return claude.runClaudeTurn(request);
    },
    abort(providerSessionId: string) {
      return claude.abortClaudeInternalSession(providerSessionId);
    },
    isRunning(providerSessionId: string) {
      return claude.isClaudeInternalSessionRunning(providerSessionId);
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
    setInternalPermissionMode(providerSessionId, mode) {
      claude.setInternalPermissionMode(providerSessionId, mode);
    },
    setInternalThinkingMode(providerSessionId, mode) {
      claude.setInternalThinkingMode(providerSessionId, mode);
    },
    setInternalClaudeThinkingMode(providerSessionId, mode) {
      claude.setInternalClaudeThinkingMode(providerSessionId, mode);
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
      launchLogin: () => launchProviderAuthLogin('claude'),
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
