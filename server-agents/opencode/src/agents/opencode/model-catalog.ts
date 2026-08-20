import { isRecord } from '@garcon/common/json';

export interface OpenCodeModelOption {
  value: string;
  label: string;
  supportsImages?: boolean;
}

// The server computes capabilities.input from config modalities and the
// registry, so it is the authoritative image-input signal; older payloads
// without it fall back to the raw declarations.
function modelSupportsImages(model: Record<string, unknown>): boolean | undefined {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : null;
  const input = capabilities && isRecord(capabilities.input) ? capabilities.input : null;
  if (input && typeof input.image === 'boolean') return input.image;
  const modalities = isRecord(model.modalities) ? model.modalities : null;
  if (modalities && Array.isArray(modalities.input)) {
    return modalities.input.includes('image');
  }
  if (typeof model.attachment === 'boolean') return model.attachment;
  return undefined;
}

export function configuredProvidersFromResult(result: any): any[] {
  const providers = result?.data?.providers;
  return Array.isArray(providers) ? providers : [];
}

export function connectedProvidersFromListResult(result: any): any[] {
  const data = result?.data;
  const allProviders: any[] = Array.isArray(data?.all) ? data.all : [];
  const connected = new Set<string>(Array.isArray(data?.connected) ? data.connected : []);
  return allProviders.filter((provider) => connected.has(provider.id || provider.name));
}

export function modelsFromProviders(providers: any[]): OpenCodeModelOption[] {
  const models: OpenCodeModelOption[] = [];
  for (const provider of providers) {
    const providerId = provider.id || provider.name;
    const providerName = provider.name || providerId;
    const agentModelsObj = provider.models || {};
    for (const [modelKey, model] of Object.entries(agentModelsObj)) {
      if (!isRecord(model)) continue;
      const modelId = typeof model.id === 'string' ? model.id : modelKey;
      const supportsImages = modelSupportsImages(model);
      models.push({
        value: `${providerId}/${modelId}`,
        label: `${providerName}: ${typeof model.name === 'string' ? model.name : modelId}`,
        ...(supportsImages === undefined ? {} : { supportsImages }),
      });
    }
  }
  return models;
}
