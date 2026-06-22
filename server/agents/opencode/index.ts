import type { OpenCodeRuntime } from './opencode.js';
import { getOpenCodeAuthStatus } from './opencode-auth.js';
import type { ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '../session-types.js';
import { createAgentCapabilities } from '../capabilities.js';
import { createArtificialTranscriptSource } from '../shared/artificial-transcript-source.js';
import { createArtificialNativePath } from '../../chats/artificial-native-path.js';
import type { Agent, AgentRuntime } from '../types.js';

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

export function createOpenCodeAgent(opencode: OpenCodeRuntime): Agent {
  return {
    id: 'opencode',
    label: 'OpenCode',
    runtime: createOpenCodeRuntime(opencode),
    transcript: createArtificialTranscriptSource('opencode'),
    auth: { getAuthStatus: () => getOpenCodeAuthStatus(opencode) },
    capabilities: createAgentCapabilities({
      supportsFork: false,
      supportsImages: false,
      acceptsApiProviderEndpoints: false,
      supportedProtocols: [],
      authLoginSupported: false,
      getModels: () => opencode.getModels(),
    }),
    runSingleQuery(prompt, options) {
      return opencode.runSingleQuery(prompt, options);
    },
  };
}
