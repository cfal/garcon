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

function titleModelSelection(persisted: unknown, use: TitleModelUse): unknown {
  if (use === 'automatic') return persisted;
  const settings = isRecord(persisted) ? persisted : {};
  // On demand, a saved target is always enabled. Without one, Auto decides from readiness.
  const hasSavedTarget = ['agentId', 'model', 'apiProviderId', 'modelEndpointId']
    .some(key => typeof settings[key] === 'string');
  return { ...settings, enabled: hasSavedTarget ? true : undefined };
}

export async function resolveTitleModelQuery(
  agents: GenerationDiscoveryAgents,
  persisted: unknown,
  use: TitleModelUse,
  externalSignal?: AbortSignal,
): Promise<TitleModelQuery | null> {
  const signal = createGenerationRequestSignal(externalSignal);
  const context = await resolveGenerationContextForSelection(agents, persisted, signal);
  const { enabled, source: _source, ...target } = resolveEffectiveGenerationConfig({
    persisted: titleModelSelection(persisted, use),
    ...context,
  });
  if (!enabled) return null;
  if (!target.agentId || !target.model) {
    if (use === 'automatic') logger.warn('chat-title: generation failed:', TITLE_MODEL_UNAVAILABLE_MESSAGE);
    return null;
  }
  return { ...target, permissionMode: 'default', timeoutMs: GENERATION_PROVIDER_TIMEOUT_MS, signal };
}
