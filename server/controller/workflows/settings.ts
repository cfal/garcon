import { DEFAULT_AGENT_ID } from '../../../common/agents.js';
import type { ApiProtocol } from '../../../common/api-providers.js';
import { createEmptyAgentSettings } from '../../../common/agent-settings.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import { executionDefaultsForAgent } from '../../../common/execution-defaults.js';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import { projectTargetKey, type ProjectInspector } from '../../../common/project-resolution.js';
import type { RecentAgentSetting, RemoteExecutionDefaults } from '../../../common/settings.js';
import { resolveStartSelection, StartSelectionError } from '../../../common/start-selection.js';
import type { WorkflowAgentStep, WorkflowStep } from '../../../common/workflow-definition.js';
import type { WorkflowAgentSettings, WorkflowExecutionContext, WorkflowLocation } from '../../../common/workflow-runs.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { preambleMatchesDefaultFilters } from '../preambles/matching.js';
import { defaultOrderedPreambleIds } from '../preambles/selection.js';
import { captureLocation } from './bindings.js';
import type { WorkflowSettingsResolver } from './engine.js';

export interface WorkflowSelectionSource {
  ready(executorId: string): boolean;
  catalog(executorId: string): Promise<ModelCatalogResponse>;
  inspectProject: ProjectInspector;
  recents(): readonly RecentAgentSetting[];
  defaults(): RemoteExecutionDefaults;
  preambles(): PreamblesSnapshot;
  providerRoute(executorId: string, providerId: string, endpointId: string): { revision: number; protocol: ApiProtocol };
}

export async function prepareWorkflowSettings(
  steps: readonly WorkflowStep[], context: WorkflowExecutionContext, source: WorkflowSelectionSource,
): Promise<WorkflowSettingsResolver> {
  const agents = steps.filter(step => step.kind === 'agent');
  const ids = new Set(agents.map(step => captureLocation(step, context).executorId));
  const catalogs = new Map<string, ModelCatalogResponse>();
  // Per-launch catalogs avoid crossing a config change or leaking one launcher's defaults into another.
  for (const id of ids) {
    if (source.ready(id)) catalogs.set(id, await source.catalog(id));
  }
  const recents = source.recents(), defaults = source.defaults(), preambles = source.preambles();
  const scopedDefaults = (executorId: string) => preambles.preambles.filter(p => p.enabled && p.scope.type === 'project-paths'
    && p.scope.rules.some(rule => effectiveExecutorId(rule.executorId) === executorId));
  const canonical = new Map<string, string>();
  for (const step of agents) {
    const location = captureLocation(step, context);
    if (step.orderedPreambleIds !== undefined || !catalogs.has(location.executorId) || !scopedDefaults(location.executorId).length) continue;
    const key = projectTargetKey({ kind: 'path', ...location });
    if (canonical.has(key)) continue;
    const result = await source.inspectProject(location.projectPath, location.executorId);
    if (result.kind === 'unavailable') {
      throw new ValidationDomainError(`Step "${step.id}": cannot resolve folder "${location.projectPath}" on executor "${location.executorId}" (${result.reason}). Choose an accessible folder.`);
    }
    canonical.set(key, result.effectiveProjectKey);
  }
  return (step: WorkflowAgentStep, location: WorkflowLocation): WorkflowAgentSettings => {
    const { executorId, projectPath } = location;
    const catalog = catalogs.get(executorId);
    const recent = recents.find(option => effectiveExecutorId(option.executorId) === executorId &&
      (!step.agentId || option.agentId === step.agentId) && option.agentId !== 'shell' &&
      (!catalog || catalog.catalog.agents.some(agent => agent.id === option.agentId && agent.executionPolicy !== 'literal')));
    const agentId = step.agentId ?? recent?.agentId ?? DEFAULT_AGENT_ID;
    if (step.agentSettings && step.agentSettings.ownerId !== agentId) {
      throw new ValidationDomainError(`Step "${step.id}": settings for "${step.agentSettings.ownerId}" do not belong to the resolved agent "${agentId}". Set agentId explicitly or change agentSettings.`);
    }
    const entry = catalog?.catalog.agents.find(agent => agent.id === agentId);
    if (agentId === 'shell' || entry?.executionPolicy === 'literal') throw new ValidationDomainError(`Step "${step.id}": use a command step to run Shell.`);
    const recentRoute = !step.model && step.apiProviderId === undefined && step.modelEndpointId === undefined ? recent : undefined;
    const model = step.model ?? recentRoute?.model ?? entry?.defaultModel;
    if (!model) throw new ValidationDomainError(`Step "${step.id}" needs a model on executor "${executorId}". Choose one explicitly or reconnect that executor.`);
    const { apiProviderId: providerId, modelEndpointId: endpointId } = recentRoute ?? step;
    const configured = executionDefaultsForAgent(defaults, agentId);
    let selection: WorkflowAgentSettings;
    if (catalog) {
      try {
        selection = resolveStartSelection(catalog, { executionDefaults: defaults }, {
          agentId, model, permissionMode: step.permissionMode, thinkingMode: step.thinkingMode, providerId,
          ...(endpointId ? { endpointId } : {}),
        });
      } catch (error) {
        if (!(error instanceof StartSelectionError)) throw error;
        throw new ValidationDomainError(`Step "${step.id}": ${error.message}`);
      }
    } else {
      if (Boolean(endpointId) !== Boolean(providerId)) throw new ValidationDomainError(`Step "${step.id}" needs both provider and endpoint when its executor is offline.`);
      const permissionMode = step.permissionMode ?? configured.permissionMode;
      if (!step.permissionMode && (permissionMode === 'bypassPermissions' || permissionMode === 'manualBypass')) {
        throw new ValidationDomainError(`Step "${step.id}" must explicitly select bypass permissions.`);
      }
      selection = { model, permissionMode, thinkingMode: step.thinkingMode ?? configured.thinkingMode,
        apiProviderId: providerId ?? null, modelEndpointId: endpointId ?? null,
        agentSettings: configured.agentSettingsById[agentId] ?? createEmptyAgentSettings(agentId) };
    }
    const route = selection.apiProviderId && selection.modelEndpointId
      ? source.providerRoute(executorId, selection.apiProviderId, selection.modelEndpointId) : null;
    const tags = step.tags ?? [];
    if (step.orderedPreambleIds === undefined && !catalog && scopedDefaults(executorId).some(p => preambleMatchesDefaultFilters(p, { agentId, tags }))) {
      throw new ValidationDomainError(`Step "${step.id}": reconnect executor "${executorId}" to resolve folder-scoped preambles, or set orderedPreambleIds explicitly ([] for none).`);
    }
    const canonicalProjectPath = canonical.get(projectTargetKey({ kind: 'path', ...location })) ?? projectPath;
    return { ...selection, agentId, modelProtocol: route?.protocol ?? null, providerRevision: route?.revision ?? null,
      orderedPreambleIds: step.orderedPreambleIds ?? defaultOrderedPreambleIds(preambles, { executorId, canonicalProjectPath, agentId, tags }),
      ...(step.agentSettings && { agentSettings: step.agentSettings }) };
  };
}
