import { isRecord } from '../../../common/json.js';
import { resolveGenerationContextForSelection, type GenerationDiscoveryAgents } from './generation-config-source.js';
import { resolveEffectiveGenerationConfig, type EffectiveGenerationConfig } from './generation-effective.js';
import { createGenerationRequestSignal, GENERATION_PROVIDER_TIMEOUT_MS } from './generation-limits.js';

type TitleModelQuery = Omit<EffectiveGenerationConfig, 'enabled' | 'source'> & {
  permissionMode: 'default';
  timeoutMs: number;
  signal: AbortSignal;
};

export interface TitleModelAgents extends GenerationDiscoveryAgents {
  runSingleQuery(prompt: string, options: TitleModelQuery): Promise<string>;
}

export async function resolveTitleModelQuery(
  agents: GenerationDiscoveryAgents,
  persisted: unknown,
  use: 'automatic' | 'on-demand',
  externalSignal?: AbortSignal,
): Promise<TitleModelQuery | null> {
  const signal = createGenerationRequestSignal(externalSignal);
  const context = await resolveGenerationContextForSelection(agents, persisted, signal);
  const selection = isRecord(persisted) ? persisted : {};
  // The switch governs automatic chat titles, not explicit requests for a name.
  const config = resolveEffectiveGenerationConfig({
    persisted: use === 'automatic' ? selection : { ...selection, enabled: undefined },
    ...context,
  });
  const explicit = ['agentId', 'model', 'apiProviderId', 'modelEndpointId'].some(key => typeof selection[key] === 'string');
  const { enabled, source: _source, ...target } = config;
  if (!target.agentId || !target.model || (!enabled && (use === 'automatic' || !explicit))) return null;
  return { ...target, permissionMode: 'default', timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS, signal };
}
