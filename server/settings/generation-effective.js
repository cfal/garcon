import {
  GENERATION_PROVIDER_PRIORITY,
  GENERATION_MODEL_DEFAULTS,
  OPENCODE_PREFERRED_MODEL_PATTERNS,
} from '../../common/generation-defaults.ts';

function isProvider(value) {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'amp';
}

function pickAutoProvider(authByProvider) {
  return GENERATION_PROVIDER_PRIORITY.find((provider) => authByProvider?.[provider]?.authenticated) ?? null;
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

function pickDefaultModel(provider, modelsByProvider) {
  if (provider === 'opencode') return pickPreferredOpenCodeModel(modelsByProvider?.opencode || []);
  return GENERATION_MODEL_DEFAULTS[provider] || '';
}

export function resolveEffectiveGenerationConfig({ persisted, authByProvider, modelsByProvider }) {
  const cfg = persisted && typeof persisted === 'object' ? persisted : {};
  const persistedEnabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : null;
  const persistedProvider = isProvider(cfg.provider) ? cfg.provider : null;
  const persistedModel = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model : '';

  const autoProvider = pickAutoProvider(authByProvider);
  const selectedProvider = persistedProvider || autoProvider || 'claude';
  const selectedModel = persistedModel || pickDefaultModel(selectedProvider, modelsByProvider);
  const selectedEnabled = persistedEnabled ?? Boolean(autoProvider);

  return {
    enabled: selectedEnabled,
    provider: selectedProvider,
    model: selectedModel,
    source: persistedEnabled === null && !persistedProvider && !persistedModel ? 'auto' : 'manual',
  };
}

export function resolveEffectiveGenerationUiConfig({ persisted, authByProvider, modelsByProvider }) {
  const config = persisted && typeof persisted === 'object' ? persisted : {};
  return {
    ...config,
    ...resolveEffectiveGenerationConfig({ persisted: config, authByProvider, modelsByProvider }),
  };
}
