import type { GarconCreateChatFailureMessage, GarconCreateChatParams } from '../../common/garcon-start-agent.js';
import type { PermissionMode } from '../../common/chat-modes.js';
import type { RemoteExecutionDefaults } from '../../common/settings.js';
import {
  resolveStartSelection,
  StartSelectionError,
  type ResolvedStartSelection,
  type StartSelectionErrorCode,
} from '../../common/start-selection.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { AgentRegistryServiceContract } from './registry.js';

export type AgentStartSelectionResult =
  | { readonly ok: true; readonly selection: ResolvedStartSelection }
  | { readonly ok: false; readonly message: GarconCreateChatFailureMessage };

export class AgentStartSelectionService {
  constructor(
    private readonly deps: {
      readonly agents: Pick<
        AgentRegistryServiceContract,
        'getAgentCatalogEntry' | 'requiresStrictModelDiscovery'
      >;
      readonly apiProviders: Pick<ApiProviderService, 'getCatalog'>;
    },
  ) {}

  async resolve(
    params: GarconCreateChatParams,
    executionDefaults: RemoteExecutionDefaults,
    permissionMode: PermissionMode,
  ): Promise<AgentStartSelectionResult> {
    const initialEntry = await this.deps.agents.getAgentCatalogEntry(params.agentId);
    const requiresStrictDiscovery = this.deps.agents.requiresStrictModelDiscovery(params.agentId)
      || initialEntry?.requiresStrictModelDiscovery === true;
    const entry = requiresStrictDiscovery
      ? await this.deps.agents.getAgentCatalogEntry(params.agentId, { strict: true })
      : initialEntry;

    try {
      const selection = resolveStartSelection(
        {
          catalog: {
            agents: entry ? [entry] : [],
            apiProviders: this.deps.apiProviders.getCatalog(),
          },
        },
        { executionDefaults },
        {
          agentId: params.agentId,
          model: params.model,
          ...(params.providerId === null ? {} : { providerId: params.providerId }),
          ...(params.endpointId === null ? {} : { endpointId: params.endpointId }),
          permissionMode,
          ...(params.reasoningEffort === null ? {} : { thinkingMode: params.reasoningEffort }),
        },
      );
      return { ok: true, selection };
    } catch (error) {
      if (!(error instanceof StartSelectionError)) throw error;
      return { ok: false, message: resultMessageForSelectionError(error.code) };
    }
  }
}

export function resultMessageForSelectionError(
  code: StartSelectionErrorCode,
): GarconCreateChatFailureMessage {
  switch (code) {
    case 'UNKNOWN_AGENT':
      return 'unknown-agent';
    case 'PROVIDER_NOT_SUPPORTED':
      return 'provider-not-supported';
    case 'UNKNOWN_PROVIDER':
      return 'unknown-provider';
    case 'UNKNOWN_ENDPOINT':
      return 'unknown-endpoint';
    case 'INCOMPATIBLE_ENDPOINT':
      return 'incompatible-endpoint';
    case 'AMBIGUOUS_MODEL':
      return 'ambiguous-model';
    case 'UNKNOWN_MODEL':
      return 'unknown-model';
    case 'UNSUPPORTED_REASONING_EFFORT':
      return 'unsupported-reasoning-effort';
    case 'PERMISSION_OVERRIDE_REQUIRED':
      return 'permission-override-required';
    case 'INVALID_CATALOG':
      return 'start-failed';
    case 'UNSUPPORTED_PERMISSION_MODE':
      return 'unsupported-permission-mode';
  }
}
