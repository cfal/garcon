import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { SettingsStore } from '../settings/store.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import { isAgentId } from '../../common/agents.js';
import { isThinkingMode } from '../../common/chat-modes.js';
import { validateGitRequest } from '../../common/git-request-validation.js';
import { generateCommitMessageForFiles } from '../git/commit-generation.js';
import { resolveEffectiveGenerationUiConfig } from '../settings/generation-effective.js';
import { resolveGenerationContextForSelection } from '../settings/generation-config-source.js';
import { createGenerationRequestSignal } from '../settings/generation-limits.js';
import { withJsonBody } from '../lib/json-route.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { executionNodeIdFromValue } from './node-target.js';
import { gitRouteFailure, type GitServiceResolver } from './git-node-service.js';
import { assertGitBodyUrl, validateGitHttpFields } from './git-request-fields.js';

const GENERATION_FIELDS = ['generationNodeId', 'agentId', 'model', 'apiProviderId', 'modelEndpointId', 'modelProtocol', 'thinkingMode', 'customPrompt'];

function hasOwn(source: unknown, key: string): source is Record<string, unknown> {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value) ? value : null;
}

function optionalProtocol(value: unknown): ApiProtocol | null {
  return value === 'openai-compatible' || value === 'anthropic-messages' ? value : null;
}

function hasGenerationRoutingOverride(input: Record<string, unknown>): boolean {
  return ['generationNodeId', 'agentId', 'model', 'apiProviderId', 'modelEndpointId', 'modelProtocol'].some((key) => hasOwn(input, key));
}

async function resolveCommitMessageConfig(settings: SettingsStore, agents: AgentRegistryServiceContract, signal?: AbortSignal) {
  const ui = (await settings?.getUiSettings?.()) ?? {};
  const generationContext = await resolveGenerationContextForSelection(agents, ui?.commitMessage, signal);
  return resolveEffectiveGenerationUiConfig({
    persisted: ui?.commitMessage,
    ...generationContext,
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0) ? value : null;
}

function gitRouteError(error: string, status = 400): Response { return jsonError(error, status); }

export function createGitGenerationRoute(agents: AgentRegistryServiceContract, settings: SettingsStore, resolveGit: GitServiceResolver) {
  return withJsonBody(async (body: JsonBody, request: Request): Promise<Response> => {
    try {
      assertGitBodyUrl(request);
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const files = stringArray(input.files);
      if (!project || !files || files.length === 0) {
        return gitRouteError('Missing required parameters: project and files.', 400);
      }
      validateGitHttpFields('collectCommitMessageContext', input, GENERATION_FIELDS);
      validateGitRequest('collectCommitMessageContext', { projectPath: project, files });
      if (hasOwn(input, 'agentId') && !isAgentId(input.agentId)) {
        return gitRouteError('Invalid agent.', 400);
      }
      if (hasOwn(input, 'thinkingMode') && !isThinkingMode(input.thinkingMode)) {
        return gitRouteError('Invalid reasoning effort.', 400);
      }

      const generationSignal = createGenerationRequestSignal(request.signal);
      const persistedConfig = await resolveCommitMessageConfig(settings, agents, generationSignal);
      const nodeId = hasGenerationRoutingOverride(input) ? executionNodeIdFromValue(input.generationNodeId) : persistedConfig.nodeId;
      const agentId = hasOwn(input, 'agentId') && isAgentId(input.agentId) ? input.agentId : persistedConfig.agentId;
      const model = hasOwn(input, 'model') ? (typeof input.model === 'string' ? input.model : '') : typeof persistedConfig.model === 'string' ? persistedConfig.model : '';
      const apiProviderId = hasOwn(input, 'apiProviderId') ? optionalId(input.apiProviderId) : (persistedConfig.apiProviderId ?? null);
      const modelEndpointId = hasOwn(input, 'modelEndpointId') ? optionalId(input.modelEndpointId) : (persistedConfig.modelEndpointId ?? null);
      const modelProtocol = hasOwn(input, 'modelProtocol') ? optionalProtocol(input.modelProtocol) : (persistedConfig.modelProtocol ?? null);
      const customPrompt = hasOwn(input, 'customPrompt')
        ? typeof input.customPrompt === 'string'
          ? input.customPrompt
          : ''
        : typeof persistedConfig.customPrompt === 'string'
          ? persistedConfig.customPrompt
          : '';
      const useCommonDirPrefix = persistedConfig.useCommonDirPrefix === true;
      const selectedThinkingMode = hasOwn(input, 'thinkingMode') && isThinkingMode(input.thinkingMode)
        ? input.thinkingMode
        : hasGenerationRoutingOverride(input)
          ? 'none'
          : persistedConfig.thinkingMode;
      let thinkingMode = selectedThinkingMode;
      if (agentId) {
        try {
          agents.assertAgentAvailable(agentId, nodeId);
          if (hasOwn(input, 'thinkingMode')) {
            agents.assertExecutionModeSelectionSupported(agentId, { thinkingMode: selectedThinkingMode, nodeId });
          }
          thinkingMode = agents.normalizeThinkingModeForAgent(agentId, selectedThinkingMode, nodeId);
        } catch (error) {
          return jsonErrorFromUnknown(error);
        }
      }

      const repository = await resolveGit(executionNodeIdFromValue(input.nodeId));
      const result = await generateCommitMessageForFiles(agents, repository, {
        nodeId,
        projectPath: project,
        files,
        agentId,
        model,
        apiProviderId,
        modelEndpointId,
        modelProtocol,
        thinkingMode,
        customPrompt,
        useCommonDirPrefix,
        signal: generationSignal,
      });
      return Response.json(result);
    } catch (error) { return gitRouteFailure(error); }
  });
}
