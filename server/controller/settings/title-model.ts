import { isRecord } from '../../../common/json.js';
import { createLogger } from '../../common/log.js';
import { resolveGenerationContextForSelection, type GenerationDiscoveryAgents } from './generation-config-source.js';
import { resolveEffectiveGenerationConfig, type EffectiveGenerationConfig } from './generation-effective.js';
import { createGenerationRequestSignal, GENERATION_PROVIDER_TIMEOUT_MS } from './generation-limits.js';

export type TitleModelUse = 'automatic' | 'on-demand';
export const TITLE_MODEL_UNAVAILABLE_MESSAGE = 'Title generation is unavailable because no generation model is configured or ready.';

const logger = createLogger('settings:title-model');

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
  use: TitleModelUse,
  externalSignal?: AbortSignal,
): Promise<TitleModelQuery | null> {
  const signal = createGenerationRequestSignal(externalSignal);
  const context = await resolveGenerationContextForSelection(agents, persisted, signal);
  let selection = isRecord(persisted) ? persisted : {};
  if (use === 'on-demand') {
    // An explicit request uses the saved target regardless of the automatic-title switch.
    // With no saved target, the resolver enables generation only when Auto is ready.
    const hasSavedTarget = ['agentId', 'model', 'apiProviderId', 'modelEndpointId']
      .some(key => typeof selection[key] === 'string');
    selection = { ...selection, enabled: hasSavedTarget ? true : undefined };
  }
  const { enabled, source: _source, ...target } = resolveEffectiveGenerationConfig({ persisted: selection, ...context });
  if (!enabled) return null;
  if (!target.agentId || !target.model) {
    if (use === 'automatic') logger.warn('chat-title: generation failed:', TITLE_MODEL_UNAVAILABLE_MESSAGE);
    return null;
  }
  return { ...target, permissionMode: 'default', timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS, signal };
}
