import { normalizeAgentSettings } from '@garcon/common/agent-settings';
import type { AgentCatalogEntry, AgentModelOption } from '@garcon/common/agents';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import type { AgentHandoffTarget } from '@garcon/common/chat-command-contracts';
import {
  executionDefaultsForAgent,
  normalizeSupportedThinkingMode,
} from '@garcon/common/execution-defaults';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import {
  StartSelectionError,
  requireCatalogAgent as requireSharedCatalogAgent,
  requireCatalogModels as requireSharedCatalogModels,
  resolveCatalogModelSelection as resolveSharedCatalogModelSelection,
  resolveModelSelection as resolveSharedModelSelection,
  resolveStartSelection as resolveSharedStartSelection,
  validateExplicitModes as validateSharedExplicitModes,
  type RequestedModelSelection,
  type RequestedStartSelection,
  type ResolvedModelSelection,
  type ResolvedStartSelection,
} from '@garcon/common/start-selection';
import { CliError } from './errors.js';

export type {
  RequestedModelSelection,
  RequestedStartSelection,
  ResolvedModelSelection,
  ResolvedStartSelection,
};

function asCliCatalogError(error: unknown): never {
  if (error instanceof StartSelectionError) {
    const exitCode = error.code === 'INVALID_CATALOG' ? 3 : 2;
    throw new CliError('catalog resolution', error.message, exitCode, { cause: error });
  }
  throw error;
}

function withCliCatalogErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    return asCliCatalogError(error);
  }
}

export function requireCatalogAgent(
  catalog: ModelCatalogResponse,
  agentId: string,
): AgentCatalogEntry {
  return withCliCatalogErrors(() => requireSharedCatalogAgent(catalog, agentId));
}

export function requireCatalogModels(agent: AgentCatalogEntry): AgentModelOption[] {
  return withCliCatalogErrors(() => requireSharedCatalogModels(agent));
}

export function resolveCatalogModelSelection(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  model: AgentModelOption,
): ResolvedModelSelection {
  return withCliCatalogErrors(() => resolveSharedCatalogModelSelection(catalog, agent, model));
}

export function resolveModelSelection(
  catalog: ModelCatalogResponse,
  agentId: string,
  requested: RequestedModelSelection,
): ResolvedModelSelection {
  return withCliCatalogErrors(() => resolveSharedModelSelection(catalog, agentId, requested));
}

export function validateExplicitModes(
  catalog: ModelCatalogResponse,
  agentId: string,
  requested: { readonly permissionMode?: PermissionMode; readonly thinkingMode?: ThinkingMode },
): void {
  withCliCatalogErrors(() => validateSharedExplicitModes(catalog, agentId, requested));
}

export function resolveStartSelection(
  catalog: ModelCatalogResponse,
  settings: RemoteSettingsSnapshot,
  requested: RequestedStartSelection,
): ResolvedStartSelection {
  return withCliCatalogErrors(() => resolveSharedStartSelection(catalog, settings, requested));
}

export function resolveHandoffSelection(
  catalog: ModelCatalogResponse,
  settings: RemoteSettingsSnapshot,
  requested: {
    readonly agentId: string;
    readonly model?: string;
    readonly providerId?: string;
    readonly endpointId?: string;
    readonly permissionMode?: PermissionMode;
    readonly thinkingMode?: ThinkingMode;
  },
): AgentHandoffTarget {
  const agent = requireCatalogAgent(catalog, requested.agentId);
  const model = requested.model ?? agent.defaultModel;
  if (model.length === 0) {
    throw new CliError(
      'catalog resolution',
      `agent ${requested.agentId} has no default model; specify --model`,
      2,
    );
  }
  validateExplicitModes(catalog, requested.agentId, requested);
  const defaults = executionDefaultsForAgent(settings.executionDefaults, requested.agentId);
  const thinkingMode = requested.thinkingMode
    ?? normalizeSupportedThinkingMode(defaults.thinkingMode, agent.supportedThinkingModes);
  const agentSettings = normalizeAgentSettings(
    requested.agentId,
    defaults.agentSettingsById[requested.agentId],
    agent.defaultSettings,
  );
  return {
    agentId: requested.agentId,
    ...resolveModelSelection(catalog, requested.agentId, {
      model,
      providerId: requested.providerId,
      endpointId: requested.endpointId,
    }),
    ...(requested.permissionMode === undefined
      ? {}
      : { permissionMode: requested.permissionMode }),
    thinkingMode,
    agentSettings,
  };
}
