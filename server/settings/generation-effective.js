import {
  GENERATION_HARNESS_PRIORITY,
  GENERATION_MODEL_DEFAULTS,
  OPENCODE_PREFERRED_MODEL_PATTERNS,
} from '../../common/generation-defaults.ts';

function isHarness(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(value);
}

function hasAutoModel(harnessId, modelsByHarness) {
  if (GENERATION_MODEL_DEFAULTS[harnessId]) return true;
  return Array.isArray(modelsByHarness?.[harnessId])
    && modelsByHarness[harnessId].some((model) => typeof model?.value === 'string' && model.value.trim());
}

function pickAutoHarness(authByHarness, readinessByHarness, modelsByHarness) {
  return GENERATION_HARNESS_PRIORITY.find((harnessId) =>
    (authByHarness?.[harnessId]?.authenticated || readinessByHarness?.[harnessId]?.ready)
      && hasAutoModel(harnessId, modelsByHarness)
  ) ?? null;
}

function pickPreferredOpenCodeModel(models) {
  if (!Array.isArray(models) || models.length === 0) return '';
  const preferred = models.find((model) => {
    const label = typeof model?.label === 'string' ? model.label : '';
    const value = typeof model?.value === 'string' ? model.value : '';
    const text = `${label} ${value}`;
    return OPENCODE_PREFERRED_MODEL_PATTERNS.some((pattern) => pattern.test(text));
  });
  return preferred?.value || models[0]?.value || '';
}

function pickDefaultModel(harnessId, modelsByHarness) {
  if (harnessId === 'opencode') return pickPreferredOpenCodeModel(modelsByHarness?.opencode || []);
  return GENERATION_MODEL_DEFAULTS[harnessId] || modelsByHarness?.[harnessId]?.[0]?.value || '';
}

export function resolveEffectiveGenerationConfig({ persisted, authByHarness, modelsByHarness, readinessByHarness }) {
  const cfg = persisted && typeof persisted === 'object' ? persisted : {};
  const persistedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : null;
  const persistedHarness = isHarness(cfg.provider) ? cfg.provider : null;
  const persistedModel = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : '';
  const persistedApiProviderId = typeof cfg.apiProviderId === 'string' ? cfg.apiProviderId : null;
  const persistedEndpointId = typeof cfg.modelEndpointId === 'string' ? cfg.modelEndpointId : null;
  const persistedProtocol = (cfg.modelProtocol === 'openai-chat-completions' || cfg.modelProtocol === 'anthropic-messages')
    ? cfg.modelProtocol
    : null;

  const autoHarness = pickAutoHarness(authByHarness, readinessByHarness ?? {}, modelsByHarness);
  const selectedHarness = persistedHarness || autoHarness || 'claude';
  const selectedModel = persistedModel || pickDefaultModel(selectedHarness, modelsByHarness);
  const selectedEnabled = persistedEnabled ?? Boolean(autoHarness);

  return {
    enabled: selectedEnabled,
    provider: selectedHarness,
    model: selectedModel,
    apiProviderId: persistedApiProviderId,
    modelEndpointId: persistedEndpointId,
    modelProtocol: persistedProtocol,
    source: persistedEnabled === null && !persistedHarness && !persistedModel ? 'auto' : 'manual',
  };
}

export function resolveEffectiveGenerationUiConfig({ persisted, authByHarness, modelsByHarness, readinessByHarness }) {
  const config = persisted && typeof persisted === 'object' ? persisted : {};
  return {
    ...config,
    ...resolveEffectiveGenerationConfig({ persisted: config, authByHarness, modelsByHarness, readinessByHarness }),
  };
}
