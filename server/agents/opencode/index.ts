import type { OpenCodeProvider } from '../../providers/opencode.js';
import { getOpenCodeAuthStatus } from '../../providers/opencode-auth.js';
import type { ResumeTurnRequest, StartSessionRequest, StartedProviderSession } from '../../providers/types.js';
import { createAgentCapabilities } from '../capabilities.js';
import { EMPTY_TRANSCRIPT_SOURCE } from '../shared/empty-transcript-source.js';
import type { Agent, AgentRuntime } from '../types.js';

function createOpenCodeRuntime(opencode: OpenCodeProvider): AgentRuntime {
  return {
    async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
      const providerSessionId = await opencode.startSession(request);
      return { providerSessionId, nativePath: `opencode:${providerSessionId}` };
    },
    runTurn(request: ResumeTurnRequest) {
      return opencode.runTurn(request);
    },
    abort(providerSessionId) {
      return opencode.abort(providerSessionId);
    },
    isRunning(providerSessionId) {
      return opencode.isRunning(providerSessionId);
    },
    getRunningSessions() {
      return opencode.getRunningSessions();
    },
    resolvePermission(permissionRequestId, decision) {
      return opencode.resolvePermission(permissionRequestId, decision);
    },
    shutdown() {
      opencode.shutdown?.();
    },
    startPurgeTimer() {
      return opencode.startPurgeTimer();
    },
    onMessages(cb) { opencode.onMessages(cb); },
    onProcessing(cb) { opencode.onProcessing(cb); },
    onSessionCreated(cb) { opencode.onSessionCreated(cb); },
    onFinished(cb) { opencode.onFinished(cb); },
    onFailed(cb) { opencode.onFailed(cb); },
  };
}

export function createOpenCodeAgent(opencode: OpenCodeProvider): Agent {
  return {
    id: 'opencode',
    label: 'OpenCode',
    runtime: createOpenCodeRuntime(opencode),
    transcript: EMPTY_TRANSCRIPT_SOURCE,
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
